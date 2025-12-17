/**
 * Purchasing Intelligence API Routes
 *
 * Provides REST endpoints for the Purchasing Intelligence Agent
 */

const express = require('express');
const router = express.Router();
const syncRouter = express.Router(); // Separate router for sync endpoints (no auth)

const { PurchasingIntelligenceAgent } = require('../../core/agents/specialized/PurchasingIntelligenceAgent');
const { getSeasonalCalendar } = require('../../core/agents/services/SeasonalCalendar');
const { getForecastEngine } = require('../../core/agents/services/ForecastEngine');
const { getSupplyChainManager } = require('../../core/agents/services/SupplyChainManager');
const { getStockoutAnalyzer } = require('../../core/agents/services/StockoutAnalyzer');
const { getPurchasingContext } = require('../../core/agents/services/PurchasingContext');
const { getOdooDataSync } = require('../../services/OdooDataSync');

// Singleton agent instance
let purchasingAgent = null;

/**
 * Initialize the purchasing agent
 */
async function initAgent(odooClient, db) {
  if (!purchasingAgent) {
    purchasingAgent = new PurchasingIntelligenceAgent({
      odooClient,
      db,
    });
    await purchasingAgent.init();
  }
  return purchasingAgent;
}

/**
 * Middleware to ensure agent is initialized
 */
function requireAgent(req, res, next) {
  if (!purchasingAgent) {
    return res.status(503).json({
      error: 'Purchasing agent not initialized',
      message: 'Please configure Odoo connection first',
    });
  }
  next();
}

// ==================== DASHBOARD ====================

/**
 * GET /api/purchasing/dashboard
 * Get comprehensive purchasing dashboard data
 */
router.get('/dashboard', requireAgent, async (req, res) => {
  try {
    const [recommendations, seasonalForecast, supplyChainStatus] = await Promise.all([
      purchasingAgent._getPurchasingRecommendations({ limit: 20 }),
      getSeasonalCalendar().getSeasonalForecast(new Date(), 6),
      getSeasonalCalendar().isSupplyChainImpacted(),
    ]);

    res.json({
      success: true,
      data: {
        recommendations: recommendations.recommendations?.slice(0, 10) || [],
        summary: recommendations.summary,
        supplyChainStatus,
        upcomingSeasons: seasonalForecast.upcomingSeasons.slice(0, 5),
        alerts: seasonalForecast.supplyChainAlerts,
        monthlyMultipliers: seasonalForecast.monthlyMultipliers,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== RECOMMENDATIONS ====================

/**
 * GET /api/purchasing/recommendations
 * Get purchasing recommendations
 */
router.get('/recommendations', requireAgent, async (req, res) => {
  try {
    const { urgent_only, include_cny, limit } = req.query;

    const recommendations = await purchasingAgent._getPurchasingRecommendations({
      urgent_only: urgent_only === 'true',
      include_cny_prep: include_cny !== 'false',
      limit: parseInt(limit) || 50,
    });

    res.json({ success: true, data: recommendations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/products/:id/analysis
 * Get detailed analysis for a specific product
 */
router.get('/products/:id/analysis', requireAgent, async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const analysis = await purchasingAgent._getProductPurchasingAnalysis({ product_id: productId });

    res.json({ success: true, data: analysis });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/reorder-check
 * Check reorder status for multiple products
 */
router.post('/reorder-check', requireAgent, async (req, res) => {
  try {
    const { product_ids } = req.body;

    if (!Array.isArray(product_ids)) {
      return res.status(400).json({ error: 'product_ids must be an array' });
    }

    const status = await purchasingAgent._checkReorderStatus({ product_ids });
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== FORECASTING ====================

/**
 * GET /api/purchasing/forecast/:productId
 * Get demand forecast for a product
 */
router.get('/forecast/:productId', requireAgent, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const { weeks, category, seasonality } = req.query;

    const forecast = await purchasingAgent._generateDemandForecast({
      product_id: productId,
      forecast_weeks: parseInt(weeks) || 12,
      product_category: category,
      include_seasonality: seasonality !== 'false',
    });

    res.json({ success: true, data: forecast });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/trends
 * Detect sales trends
 */
router.get('/trends', requireAgent, async (req, res) => {
  try {
    const { threshold, weeks } = req.query;

    const trends = await purchasingAgent._detectSalesTrends({
      threshold_percent: parseInt(threshold) || 20,
      compare_weeks: parseInt(weeks) || 4,
    });

    res.json({ success: true, data: trends });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SEASONAL CALENDAR ====================

/**
 * GET /api/purchasing/calendar/seasons
 * Get upcoming seasons and holidays
 */
router.get('/calendar/seasons', (req, res) => {
  try {
    const { months } = req.query;
    const calendar = getSeasonalCalendar();

    const seasons = calendar.getUpcomingSeasons(new Date(), (parseInt(months) || 6) * 30);
    const holidays = calendar.getHolidays(new Date().getFullYear());

    res.json({
      success: true,
      data: { seasons, holidays },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/calendar/cny
 * Get Chinese New Year information
 */
router.get('/calendar/cny', (req, res) => {
  try {
    const { year } = req.query;
    const calendar = getSeasonalCalendar();
    const currentYear = new Date().getFullYear();
    const targetYear = parseInt(year) || currentYear;

    const cnyInfo = calendar.getCNYClosurePeriod(targetYear);
    const orderDeadline = calendar.getCNYOrderDeadline(targetYear);

    res.json({
      success: true,
      data: {
        year: targetYear,
        cny: cnyInfo,
        orderDeadline,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/calendar/seasonal-forecast
 * Get seasonal forecast with multipliers
 */
router.get('/calendar/seasonal-forecast', (req, res) => {
  try {
    const { months, category } = req.query;
    const calendar = getSeasonalCalendar();

    const forecast = calendar.getSeasonalForecast(new Date(), parseInt(months) || 6);

    // Add category-specific multipliers if provided
    if (category) {
      for (const key of Object.keys(forecast.monthlyMultipliers)) {
        const monthDate = new Date(key + '-01');
        forecast.monthlyMultipliers[key].categoryMultiplier =
          calendar.getDemandMultiplier(category, monthDate);
      }
    }

    res.json({ success: true, data: forecast });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/calendar/supply-chain-status
 * Check current supply chain impact
 */
router.get('/calendar/supply-chain-status', (req, res) => {
  try {
    const { date } = req.query;
    const calendar = getSeasonalCalendar();
    const checkDate = date ? new Date(date) : new Date();

    const impact = calendar.isSupplyChainImpacted(checkDate);

    res.json({ success: true, data: impact });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SUPPLY CHAIN ====================

/**
 * POST /api/purchasing/calculate/reorder-point
 * Calculate reorder point
 */
router.post('/calculate/reorder-point', (req, res) => {
  try {
    const { avg_daily_demand, demand_std_dev, lead_time_days, service_level } = req.body;

    if (!avg_daily_demand) {
      return res.status(400).json({ error: 'avg_daily_demand is required' });
    }

    const manager = getSupplyChainManager();
    const result = manager.calculateReorderPoint({
      avgDailyDemand: avg_daily_demand,
      demandStdDev: demand_std_dev,
      shippingMethod: 'sea',
      serviceLevel: service_level || 0.95,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/calculate/eoq
 * Calculate Economic Order Quantity
 */
router.post('/calculate/eoq', (req, res) => {
  try {
    const { annual_demand, unit_cost, ordering_cost, holding_cost_rate, min_order_qty } = req.body;

    if (!annual_demand || !unit_cost) {
      return res.status(400).json({ error: 'annual_demand and unit_cost are required' });
    }

    const manager = getSupplyChainManager();
    const result = manager.calculateEOQ({
      annualDemand: annual_demand,
      unitCost: unit_cost,
      orderingCost: ordering_cost || 100,
      holdingCostRate: holding_cost_rate || 0.25,
      minimumOrderQuantity: min_order_qty || 1,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/calculate/cny-order
 * Calculate CNY order quantity and deadline
 */
router.post('/calculate/cny-order', (req, res) => {
  try {
    const { avg_daily_demand, current_stock, pending_orders, year } = req.body;

    if (!avg_daily_demand) {
      return res.status(400).json({ error: 'avg_daily_demand is required' });
    }

    const manager = getSupplyChainManager();
    const result = manager.calculateCNYOrder({
      avgDailyDemand: avg_daily_demand,
      currentStock: current_stock || 0,
      pendingOrders: pending_orders || 0,
      year: year || new Date().getFullYear(),
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/calculate/shipping-options
 * Compare shipping options
 */
router.post('/calculate/shipping-options', (req, res) => {
  try {
    const { order_quantity, unit_cost, urgency_days } = req.body;

    if (!order_quantity || !unit_cost) {
      return res.status(400).json({ error: 'order_quantity and unit_cost are required' });
    }

    const manager = getSupplyChainManager();
    const result = manager.compareShippingOptions({
      orderQuantity: order_quantity,
      unitCost: unit_cost,
      urgencyDays: urgency_days,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/lead-time
 * Get lead time information
 */
router.get('/lead-time', (req, res) => {
  try {
    const { shipping_method } = req.query;
    const manager = getSupplyChainManager();

    const result = manager.getTotalLeadTime(null, shipping_method || 'sea');
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== STOCKOUT ANALYSIS ====================

/**
 * GET /api/purchasing/stockout/:productId
 * Get stockout history analysis for a product
 */
router.get('/stockout/:productId', requireAgent, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const { months } = req.query;

    const analysis = await purchasingAgent._analyzeStockoutHistory({
      product_id: productId,
      months_back: parseInt(months) || 12,
    });

    res.json({ success: true, data: analysis });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/stockout/cost
 * Calculate stockout cost
 */
router.post('/stockout/cost', (req, res) => {
  try {
    const { stockout_days, avg_daily_sales, avg_selling_price, profit_margin } = req.body;

    if (!stockout_days || !avg_daily_sales || !avg_selling_price) {
      return res.status(400).json({
        error: 'stockout_days, avg_daily_sales, and avg_selling_price are required',
      });
    }

    const analyzer = getStockoutAnalyzer();
    const result = analyzer.calculateStockoutCost({
      stockoutDays: stockout_days,
      avgDailySales: avg_daily_sales,
      avgSellingPrice: avg_selling_price,
      profitMargin: profit_margin || 0.3,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CONTEXT MANAGEMENT ====================
// Business context for demand adjustments (substitutions, one-time orders, etc.)

/**
 * POST /api/purchasing/context/substitution
 * Record a substitution event that affects demand forecasting
 * Example: Delivered Product B instead of Product A
 */
router.post('/context/substitution', requireAgent, async (req, res) => {
  try {
    const {
      date,
      original_product_id,
      original_product_name,
      substituted_product_id,
      substituted_product_name,
      quantity,
      reason,
      customer_id,
      customer_name,
      invoice_id,
    } = req.body;

    if (!date || !original_product_id || !substituted_product_id || !quantity) {
      return res.status(400).json({
        error: 'date, original_product_id, substituted_product_id, and quantity are required',
      });
    }

    const context = getPurchasingContext(req.app.get('db'));
    const result = await context.addSubstitution({
      date,
      originalProductId: original_product_id,
      originalProductName: original_product_name || `Product ${original_product_id}`,
      substitutedProductId: substituted_product_id,
      substitutedProductName: substituted_product_name || `Product ${substituted_product_id}`,
      quantity,
      reason: reason || 'Product substitution',
      customerId: customer_id,
      customerName: customer_name,
      invoiceId: invoice_id,
      createdBy: 'api',
    });

    res.json({
      success: true,
      data: result,
      message: `Substitution recorded: +${quantity} to ${original_product_name || original_product_id} demand, -${quantity} from ${substituted_product_name || substituted_product_id} demand`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/context/one-time-order
 * Record a one-time order that should be excluded from normal demand forecasting
 * Example: Large event order, promotional giveaway
 */
router.post('/context/one-time-order', requireAgent, async (req, res) => {
  try {
    const {
      date,
      product_id,
      product_name,
      quantity,
      reason,
      customer_id,
      customer_name,
      invoice_id,
      exclude_from_forecast,
    } = req.body;

    if (!date || !product_id || !quantity) {
      return res.status(400).json({
        error: 'date, product_id, and quantity are required',
      });
    }

    const context = getPurchasingContext(req.app.get('db'));
    const result = await context.addOneTimeOrder({
      date,
      productId: product_id,
      productName: product_name || `Product ${product_id}`,
      quantity,
      reason: reason || 'One-time order',
      customerId: customer_id,
      customerName: customer_name,
      invoiceId: invoice_id,
      excludeFromForecast: exclude_from_forecast !== false, // Default true
      createdBy: 'api',
    });

    res.json({
      success: true,
      data: result,
      message: `One-time order recorded: ${quantity} units will be ${result.excludeFromForecast ? 'excluded from' : 'included in'} demand forecast`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/context/promotion
 * Record a promotion period that affects demand interpretation
 */
router.post('/context/promotion', requireAgent, async (req, res) => {
  try {
    const {
      start_date,
      end_date,
      product_ids,
      product_names,
      promotion_name,
      expected_multiplier,
      actual_multiplier,
      notes,
    } = req.body;

    if (!start_date || !end_date || !product_ids || !promotion_name) {
      return res.status(400).json({
        error: 'start_date, end_date, product_ids, and promotion_name are required',
      });
    }

    const context = getPurchasingContext(req.app.get('db'));
    const result = await context.addPromotion({
      startDate: start_date,
      endDate: end_date,
      productIds: product_ids,
      productNames: product_names || [],
      promotionName: promotion_name,
      expectedMultiplier: expected_multiplier || 1.0,
      actualMultiplier: actual_multiplier,
      notes,
      createdBy: 'api',
    });

    res.json({
      success: true,
      data: result,
      message: `Promotion "${promotion_name}" recorded for ${product_ids.length} product(s)`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/context/supply-disruption
 * Record a supply disruption that caused stockouts
 */
router.post('/context/supply-disruption', requireAgent, async (req, res) => {
  try {
    const {
      start_date,
      end_date,
      product_ids,
      product_names,
      supplier_id,
      supplier_name,
      reason,
      estimated_lost_sales_per_day,
    } = req.body;

    if (!start_date || !product_ids || !reason) {
      return res.status(400).json({
        error: 'start_date, product_ids, and reason are required',
      });
    }

    const context = getPurchasingContext(req.app.get('db'));
    const result = await context.addSupplyDisruption({
      startDate: start_date,
      endDate: end_date,
      productIds: product_ids,
      productNames: product_names || [],
      supplierId: supplier_id,
      supplierName: supplier_name,
      reason,
      estimatedLostSalesPerDay: estimated_lost_sales_per_day || {},
      createdBy: 'api',
    });

    res.json({
      success: true,
      data: result,
      message: `Supply disruption recorded: ${reason}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/context/note
 * Add a general note/context for a product
 */
router.post('/context/note', requireAgent, async (req, res) => {
  try {
    const {
      product_id,
      product_name,
      note,
      impact_type,
      quantity_adjustment,
      start_date,
      end_date,
    } = req.body;

    if (!product_id || !note) {
      return res.status(400).json({
        error: 'product_id and note are required',
      });
    }

    const context = getPurchasingContext(req.app.get('db'));
    const result = await context.addProductNote({
      productId: product_id,
      productName: product_name || `Product ${product_id}`,
      note,
      impactType: impact_type || 'info',
      quantityAdjustment: quantity_adjustment || 0,
      startDate: start_date,
      endDate: end_date,
      createdBy: 'api',
    });

    res.json({
      success: true,
      data: result,
      message: `Note added for product ${product_name || product_id}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/context/product/:productId
 * Get all context for a specific product
 */
router.get('/context/product/:productId', requireAgent, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);

    const context = getPurchasingContext(req.app.get('db'));
    const result = await context.getProductContext(productId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/context/product/:productId/adjustments
 * Get demand adjustments for a product within a date range
 */
router.get('/context/product/:productId/adjustments', requireAgent, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const { start_date, end_date } = req.query;

    const context = getPurchasingContext(req.app.get('db'));
    const result = await context.getProductAdjustments(productId, start_date, end_date);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/context/recent
 * Get recently added contexts
 */
router.get('/context/recent', requireAgent, async (req, res) => {
  try {
    const { limit } = req.query;

    const context = getPurchasingContext(req.app.get('db'));
    const result = await context.getRecentContexts(parseInt(limit) || 20);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/purchasing/context/:contextId
 * Deactivate a context entry
 */
router.delete('/context/:contextId', requireAgent, async (req, res) => {
  try {
    const { contextId } = req.params;

    const context = getPurchasingContext(req.app.get('db'));
    const result = await context.deactivateContext(contextId);

    if (result.success) {
      res.json({
        success: true,
        message: 'Context deactivated successfully',
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Context not found or already deactivated',
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== MOQ MANAGEMENT ====================

/**
 * POST /api/purchasing/moq/:productId
 * Set MOQ configuration for a product
 */
router.post('/moq/:productId', (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const {
      moq,
      moq_unit,
      units_per_carton,
      cartons_per_pallet,
      order_multiple,
      supplier_id,
    } = req.body;

    if (!moq) {
      return res.status(400).json({ error: 'moq is required' });
    }

    const manager = getSupplyChainManager();
    const result = manager.setProductMOQ(productId, {
      moq,
      moqUnit: moq_unit || 'units',
      unitsPerCarton: units_per_carton || 1,
      cartonsPerPallet: cartons_per_pallet,
      orderMultiple: order_multiple || 1,
      supplierId: supplier_id,
    });

    res.json({
      success: true,
      data: result,
      message: `MOQ set for product ${productId}: ${moq} ${moq_unit || 'units'}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/moq/:productId
 * Get MOQ configuration for a product
 */
router.get('/moq/:productId', (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const manager = getSupplyChainManager();
    const result = manager.getProductMOQ(productId);

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/moq/apply
 * Apply MOQ constraints to a desired quantity
 */
router.post('/moq/apply', (req, res) => {
  try {
    const { product_id, desired_quantity, moq_config } = req.body;

    if (!product_id || !desired_quantity) {
      return res.status(400).json({ error: 'product_id and desired_quantity are required' });
    }

    const manager = getSupplyChainManager();
    const result = manager.applyMOQConstraints({
      productId: product_id,
      desiredQuantity: desired_quantity,
      moqConfig: moq_config,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PRODUCT DIMENSIONS ====================

/**
 * POST /api/purchasing/dimensions/:productId
 * Set product dimensions for container calculations
 */
router.post('/dimensions/:productId', (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const {
      length_cm,
      width_cm,
      height_cm,
      weight_kg,
      package_length_cm,
      package_width_cm,
      package_height_cm,
      package_weight_kg,
      units_per_carton,
      carton_length_cm,
      carton_width_cm,
      carton_height_cm,
      carton_weight_kg,
    } = req.body;

    if (!length_cm || !width_cm || !height_cm) {
      return res.status(400).json({
        error: 'length_cm, width_cm, and height_cm are required',
      });
    }

    const manager = getSupplyChainManager();
    const result = manager.setProductDimensions(productId, {
      lengthCm: length_cm,
      widthCm: width_cm,
      heightCm: height_cm,
      weightKg: weight_kg,
      packageLengthCm: package_length_cm,
      packageWidthCm: package_width_cm,
      packageHeightCm: package_height_cm,
      packageWeightKg: package_weight_kg,
      unitsPerCarton: units_per_carton,
      cartonLengthCm: carton_length_cm,
      cartonWidthCm: carton_width_cm,
      cartonHeightCm: carton_height_cm,
      cartonWeightKg: carton_weight_kg,
    });

    res.json({
      success: true,
      data: result,
      message: `Dimensions set for product ${productId}: ${result.volumeM3.toFixed(4)} m³`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/dimensions/:productId
 * Get product dimensions
 */
router.get('/dimensions/:productId', (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const manager = getSupplyChainManager();
    const result = manager.getProductDimensions(productId);

    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'No dimensions found for product',
      });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/dimensions/volume
 * Calculate total volume for a quantity of products
 */
router.post('/dimensions/volume', (req, res) => {
  try {
    const { product_id, quantity } = req.body;

    if (!product_id || !quantity) {
      return res.status(400).json({ error: 'product_id and quantity are required' });
    }

    const manager = getSupplyChainManager();
    const result = manager.calculateProductVolume(product_id, quantity);

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CONTAINER OPTIMIZATION ====================

/**
 * GET /api/purchasing/container/specs
 * Get available container specifications
 */
router.get('/container/specs', (req, res) => {
  try {
    const manager = getSupplyChainManager();
    res.json({
      success: true,
      data: manager.containerSpecs,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/container/capacity
 * Calculate how many units of a product fit in a container
 */
router.post('/container/capacity', (req, res) => {
  try {
    const { product_id, container_type } = req.body;

    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    const manager = getSupplyChainManager();
    const result = manager.calculateContainerCapacity(product_id, container_type || '40ft');

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/container/optimize
 * Optimize order quantity for container utilization
 */
router.post('/container/optimize', (req, res) => {
  try {
    const {
      product_id,
      desired_quantity,
      preferred_container,
      max_containers,
      min_fill_percent,
    } = req.body;

    if (!product_id || !desired_quantity) {
      return res.status(400).json({
        error: 'product_id and desired_quantity are required',
      });
    }

    const manager = getSupplyChainManager();
    const result = manager.optimizeForContainer({
      productId: product_id,
      desiredQuantity: desired_quantity,
      preferredContainer: preferred_container || '40ft',
      maxContainers: max_containers || 5,
      minFillPercent: min_fill_percent || 70,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/container/optimize-multi
 * Optimize multiple products for a container shipment
 */
router.post('/container/optimize-multi', (req, res) => {
  try {
    const { products, container_type, max_containers } = req.body;

    if (!products || !Array.isArray(products)) {
      return res.status(400).json({
        error: 'products array is required (each with productId, desiredQuantity, optional priority)',
      });
    }

    const manager = getSupplyChainManager();
    const result = manager.optimizeMultiProductContainer({
      products: products.map(p => ({
        productId: p.product_id,
        desiredQuantity: p.desired_quantity,
        priority: p.priority || 0,
      })),
      containerType: container_type || '40ft',
      maxContainers: max_containers || 1,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/purchasing/container/recommend
 * Get container recommendation based on total volume and weight
 */
router.post('/container/recommend', (req, res) => {
  try {
    const { total_volume_m3, total_weight_kg } = req.body;

    if (!total_volume_m3 || !total_weight_kg) {
      return res.status(400).json({
        error: 'total_volume_m3 and total_weight_kg are required',
      });
    }

    const manager = getSupplyChainManager();
    const result = manager.getContainerRecommendation(total_volume_m3, total_weight_kg);

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== REPORTS ====================

/**
 * GET /api/purchasing/report
 * Generate purchasing report
 */
router.get('/report', requireAgent, async (req, res) => {
  try {
    const { type, format } = req.query;

    const report = await purchasingAgent._generatePurchasingReport({
      report_type: type || 'summary',
      format: format || 'json',
    });

    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== AI CHAT ====================

/**
 * POST /api/purchasing/chat
 * Chat with the purchasing intelligence agent
 */
router.post('/chat', requireAgent, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Generate response using the LLM agent
    const result = await purchasingAgent.generateResponse(message, {
      includeTools: true,
    });

    res.json({
      success: true,
      data: {
        response: result.content || result,
        thinking: result.thinking || null,
        toolsUsed: result.toolCalls || [],
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CONFIGURATION ====================

/**
 * GET /api/purchasing/status
 * Get agent status and configuration
 */
router.get('/status', (req, res) => {
  res.json({
    success: true,
    data: {
      agentInitialized: !!purchasingAgent,
      services: {
        seasonalCalendar: true,
        forecastEngine: true,
        supplyChainManager: true,
        stockoutAnalyzer: true,
      },
      config: purchasingAgent?.config || null,
    },
  });
});

/**
 * POST /api/purchasing/init
 * Initialize the purchasing agent with Odoo client
 */
router.post('/init', async (req, res) => {
  try {
    // Get Odoo client from app (should be set in index.js)
    const odooClient = req.app.get('odooClient');
    const db = req.app.get('db');

    if (!odooClient) {
      return res.status(400).json({
        error: 'Odoo client not configured',
        message: 'Please configure Odoo connection in environment variables',
      });
    }

    await initAgent(odooClient, db);

    res.json({
      success: true,
      message: 'Purchasing agent initialized successfully',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== DATA SYNC (syncRouter - no auth) ====================

/**
 * GET /api/odoo-sync/status
 * Get Odoo data sync status
 */
syncRouter.get('/status', async (req, res) => {
  try {
    const dataSync = getOdooDataSync();
    const status = await dataSync.getStatus();

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/odoo-sync/run
 * Trigger a manual data sync from Odoo
 * No auth required - internal operation
 *
 * Query params:
 * - incremental: if true, only sync past 30 days (faster)
 * - full: if true, sync all historical data (slower, use for initial sync)
 */
syncRouter.post('/run', async (req, res) => {
  try {
    const dataSync = getOdooDataSync();

    // Check if sync is already running
    const status = await dataSync.getStatus();
    if (status.isRunning) {
      return res.status(409).json({
        success: false,
        error: 'Sync already in progress',
        message: 'Please wait for the current sync to complete',
      });
    }

    // Determine sync mode: incremental (default) or full
    const { incremental, full } = req.query;
    const isIncremental = full !== 'true' && incremental !== 'false'; // Default to incremental

    const syncMode = isIncremental ? 'incremental (past 30 days)' : 'full (all history)';

    // Start sync in background
    dataSync.syncAll({ incremental: isIncremental }).catch(err => {
      console.error(`Manual ${syncMode} sync failed:`, err.message);
    });

    res.json({
      success: true,
      message: `Data sync started in ${syncMode} mode. Check /sync/status for progress.`,
      syncMode: isIncremental ? 'incremental' : 'full',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/sync/products
 * Get synced products from local database
 */
router.get('/sync/products', requireAgent, async (req, res) => {
  try {
    const { limit = 100, offset = 0, low_stock } = req.query;
    const dataSync = getOdooDataSync();

    if (low_stock === 'true') {
      const products = await dataSync.getLowStockProducts();
      return res.json({
        success: true,
        data: products.slice(offset, offset + parseInt(limit)),
        total: products.length,
      });
    }

    const db = req.app.get('db');
    if (!db) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const products = await db.collection('purchasing_products')
      .find({})
      .sort({ 'stock.available': 1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .toArray();

    const total = await db.collection('purchasing_products').countDocuments();

    res.json({
      success: true,
      data: products,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/sync/products/:productId
 * Get detailed product info from synced data
 */
router.get('/sync/products/:productId', requireAgent, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const dataSync = getOdooDataSync();

    const product = await dataSync.getProduct(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found',
      });
    }

    res.json({
      success: true,
      data: product,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/sync/products/:productId/sales
 * Get sales history for a product
 */
router.get('/sync/products/:productId/sales', requireAgent, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const { days = 365, period = 'week' } = req.query;
    const dataSync = getOdooDataSync();

    const sales = await dataSync.getProductSalesByPeriod(
      productId,
      parseInt(days),
      period
    );

    res.json({
      success: true,
      data: sales,
      productId,
      days: parseInt(days),
      periodType: period,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/sync/purchase-orders
 * Get synced purchase orders
 */
router.get('/sync/purchase-orders', requireAgent, async (req, res) => {
  try {
    const { pending_only, supplier_id } = req.query;
    const dataSync = getOdooDataSync();

    if (pending_only === 'true') {
      const orders = await dataSync.getPendingPurchaseOrders(
        supplier_id ? parseInt(supplier_id) : null
      );
      return res.json({
        success: true,
        data: orders,
        count: orders.length,
      });
    }

    const db = req.app.get('db');
    if (!db) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const query = {};
    if (supplier_id) query.supplierId = parseInt(supplier_id);

    const orders = await db.collection('purchasing_orders')
      .find(query)
      .sort({ orderDate: -1 })
      .limit(100)
      .toArray();

    res.json({
      success: true,
      data: orders,
      count: orders.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/purchasing/sync/low-stock
 * Get products that need reordering
 */
router.get('/sync/low-stock', requireAgent, async (req, res) => {
  try {
    const dataSync = getOdooDataSync();
    const products = await dataSync.getLowStockProducts();

    res.json({
      success: true,
      data: products,
      count: products.length,
      message: `${products.length} products need attention`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export routers and init function
module.exports = router;
module.exports.syncRouter = syncRouter;
module.exports.initAgent = initAgent;
