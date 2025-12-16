/**
 * PurchasingIntelligenceAgent
 *
 * AI-powered purchasing agent that makes intelligent procurement decisions
 * based on demand forecasting, seasonal patterns, and supply chain constraints.
 *
 * IMPORTANT DATA PRINCIPLES:
 * - Uses INVOICED quantities only (not ordered) - all sales from all channels
 *   (Amazon, Bol.com, etc.) flow through Odoo invoices
 * - Applies context adjustments for substitutions, one-time orders, etc.
 * - Always explains reasoning behind recommendations
 *
 * @module PurchasingIntelligenceAgent
 */

const { LLMAgent } = require('../LLMAgent');
const { getSeasonalCalendar } = require('../services/SeasonalCalendar');
const { getForecastEngine } = require('../services/ForecastEngine');
const { getSupplyChainManager } = require('../services/SupplyChainManager');
const { getStockoutAnalyzer } = require('../services/StockoutAnalyzer');
const { getPurchasingContext } = require('../services/PurchasingContext');
const { getOdooDataSync } = require('../../../services/OdooDataSync');

class PurchasingIntelligenceAgent extends LLMAgent {
  constructor(config = {}) {
    super({
      name: config.name || 'Purchasing Intelligence Agent',
      role: 'purchasing_intelligence',
      taskType: 'strategic',
      capabilities: [
        'demand_forecasting',
        'seasonal_planning',
        'cny_preparation',
        'stockout_prevention',
        'reorder_optimization',
        'context_management',
      ],
      llmConfig: {
        systemPrompt: `You are an intelligent purchasing agent for a Belgium-based e-commerce company
that imports products primarily from China.

## CRITICAL PRINCIPLES

1. **USE INVOICED QUANTITIES ONLY**
   - All sales data comes from Odoo INVOICES (account.move.line with invoice)
   - Amazon, Bol.com, and all other channel sales are already in Odoo
   - Never use ordered quantities - only what was actually invoiced/delivered

2. **APPLY CONTEXT ADJUSTMENTS**
   - Check for substitution events (Product A delivered instead of B)
   - Check for one-time orders that shouldn't affect baseline
   - Check for supply disruptions that suppressed true demand
   - ALWAYS retrieve and consider product context before forecasting

3. **PREVENT STOCKOUTS - THIS IS CRITICAL**
   - Lost sales during stockouts are NEVER compensated by post-restock peaks
   - Customers go elsewhere and may not return
   - When in doubt, order MORE not less

4. **PLAN FOR CHINESE NEW YEAR**
   - Factories close 3-4 weeks (typically late Jan to mid Feb)
   - Order 60+ days before CNY to account for shipping
   - Add 30% buffer for CNY period uncertainty

5. **ACCOUNT FOR BELGIAN SEASONS**
   - Back to School (Aug 15 - Sep 15): office/school supplies surge
   - Back to Office (Sep 1 - Sep 30): office equipment
   - Black Friday (late Nov): all categories spike
   - Sinterklaas (Nov 15 - Dec 6): gifts
   - Christmas (Dec 1-24): general retail peak

## WHEN MAKING RECOMMENDATIONS

You MUST always:
1. State the data sources used (invoiced quantities, date range)
2. List any context adjustments applied (substitutions, one-time orders)
3. Explain your calculation methodology
4. Show the seasonal factors considered
5. Provide specific quantities with reasoning
6. Flag urgency level and deadline

Example reasoning format:
"Based on invoiced quantities from [date range]:
- Raw invoiced: X units
- Context adjustments: +Y units (substitution for Product Z)
- Adjusted true demand: X+Y units
- Average daily demand: N units/day
- Lead time: 50 days
- Safety stock (21 days): M units
- Seasonal factor (Back to School): 1.5x
- Recommended order: Q units
- Order deadline: [date]
- Urgency: HIGH - order within 7 days"`,
        temperature: 0.3,
        maxTokens: 4000,
      },
      ...config,
    });

    // Initialize services
    this.seasonalCalendar = getSeasonalCalendar();
    this.forecastEngine = getForecastEngine();
    this.supplyChainManager = getSupplyChainManager();
    this.stockoutAnalyzer = getStockoutAnalyzer();
    this.purchasingContext = getPurchasingContext();
    this.dataSync = getOdooDataSync();

    // External clients
    this.odooClient = config.odooClient || null;
    this.db = config.db || null;

    // Configuration
    this.config = {
      defaultLeadTimeDays: config.defaultLeadTimeDays || 50,
      safetyStockDays: config.safetyStockDays || 21,
      cnyBufferMultiplier: config.cnyBufferMultiplier || 1.3,
      approvalThreshold: config.approvalThreshold || 5000,
      preferSyncedData: config.preferSyncedData !== false, // Default true
    };
  }

  async init(platform) {
    await super.init(platform);

    // Initialize context with database
    if (this.db) {
      this.purchasingContext.setDb(this.db);
      this.dataSync.db = this.db;
    }

    this._registerTools();
    console.log('PurchasingIntelligenceAgent initialized with', this.tools.size, 'tools');
  }

  _registerTools() {
    const tools = [
      // ==================== INVOICED SALES DATA ====================
      {
        name: 'get_invoiced_sales',
        schema: {
          description: 'Get INVOICED quantities for a product from Odoo. This is the source of truth for all sales across all channels (Amazon, Bol.com, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number', description: 'Odoo product ID' },
              sku: { type: 'string', description: 'Product SKU (alternative to product_id)' },
              days_back: { type: 'number', default: 365, description: 'Number of days of history' },
              apply_context: { type: 'boolean', default: true, description: 'Apply context adjustments (substitutions, etc.)' },
            },
          },
        },
        handler: this._getInvoicedSales.bind(this),
      },
      {
        name: 'get_stock_levels',
        schema: {
          description: 'Get current stock levels for products',
          inputSchema: {
            type: 'object',
            properties: {
              product_ids: { type: 'array', items: { type: 'number' } },
              low_stock_only: { type: 'boolean', default: false },
            },
          },
        },
        handler: this._getStockLevels.bind(this),
      },
      {
        name: 'get_pending_purchase_orders',
        schema: {
          description: 'Get pending purchase orders and expected arrivals',
          inputSchema: {
            type: 'object',
            properties: {
              supplier_id: { type: 'number' },
            },
          },
        },
        handler: this._getPendingPurchaseOrders.bind(this),
      },
      {
        name: 'get_supplier_info',
        schema: {
          description: 'Get supplier information including lead times and MOQs',
          inputSchema: {
            type: 'object',
            properties: {
              supplier_id: { type: 'number' },
              product_id: { type: 'number' },
            },
          },
        },
        handler: this._getSupplierInfo.bind(this),
      },

      // ==================== CONTEXT MANAGEMENT ====================
      {
        name: 'get_product_context',
        schema: {
          description: 'Get all business context for a product (substitutions, one-time orders, notes). ALWAYS call this before forecasting.',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number', description: 'Product ID' },
            },
            required: ['product_id'],
          },
        },
        handler: this._getProductContext.bind(this),
      },
      {
        name: 'add_substitution',
        schema: {
          description: 'Record a substitution event: Product B was delivered instead of Product A. Adjusts forecasts for both products.',
          inputSchema: {
            type: 'object',
            properties: {
              date: { type: 'string', format: 'date', description: 'Date of substitution' },
              original_product_id: { type: 'number', description: 'Product that was ordered (A)' },
              original_product_name: { type: 'string' },
              substituted_product_id: { type: 'number', description: 'Product that was delivered (B)' },
              substituted_product_name: { type: 'string' },
              quantity: { type: 'number', description: 'Quantity substituted' },
              reason: { type: 'string', description: 'Why substitution was made' },
              customer_id: { type: 'number' },
              customer_name: { type: 'string' },
              invoice_id: { type: 'number' },
            },
            required: ['date', 'original_product_id', 'substituted_product_id', 'quantity', 'reason'],
          },
        },
        handler: this._addSubstitution.bind(this),
      },
      {
        name: 'add_one_time_order',
        schema: {
          description: 'Record a one-time order that should be excluded from regular demand forecasting',
          inputSchema: {
            type: 'object',
            properties: {
              date: { type: 'string', format: 'date' },
              product_id: { type: 'number' },
              product_name: { type: 'string' },
              quantity: { type: 'number' },
              reason: { type: 'string', description: 'Why this is a one-time order' },
              customer_id: { type: 'number' },
              customer_name: { type: 'string' },
            },
            required: ['date', 'product_id', 'quantity', 'reason'],
          },
        },
        handler: this._addOneTimeOrder.bind(this),
      },
      {
        name: 'add_product_note',
        schema: {
          description: 'Add a general note or context about a product that affects forecasting',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              product_name: { type: 'string' },
              note: { type: 'string' },
              impact_type: { type: 'string', enum: ['info', 'increase_demand', 'decrease_demand'], default: 'info' },
              quantity_adjustment: { type: 'number', default: 0 },
            },
            required: ['product_id', 'note'],
          },
        },
        handler: this._addProductNote.bind(this),
      },
      {
        name: 'get_recent_contexts',
        schema: {
          description: 'Get recent context entries (substitutions, one-time orders, notes)',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', default: 20 },
            },
          },
        },
        handler: this._getRecentContexts.bind(this),
      },

      // ==================== FORECASTING ====================
      {
        name: 'generate_forecast',
        schema: {
          description: 'Generate demand forecast using invoiced data and context adjustments. Returns forecast with full reasoning.',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              forecast_weeks: { type: 'number', default: 12 },
              product_category: { type: 'string' },
            },
            required: ['product_id'],
          },
        },
        handler: this._generateForecastWithReasoning.bind(this),
      },
      {
        name: 'get_seasonal_factors',
        schema: {
          description: 'Get seasonal multipliers for upcoming periods',
          inputSchema: {
            type: 'object',
            properties: {
              months_ahead: { type: 'number', default: 6 },
              product_category: { type: 'string' },
            },
          },
        },
        handler: this._getSeasonalFactors.bind(this),
      },

      // ==================== SUPPLY CHAIN ====================
      {
        name: 'get_cny_info',
        schema: {
          description: 'Get Chinese New Year dates and order deadlines',
          inputSchema: {
            type: 'object',
            properties: {
              year: { type: 'number' },
            },
          },
        },
        handler: this._getCNYInfo.bind(this),
      },
      {
        name: 'calculate_order_recommendation',
        schema: {
          description: 'Calculate recommended order quantity with full reasoning',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              include_cny_buffer: { type: 'boolean', default: true },
            },
            required: ['product_id'],
          },
        },
        handler: this._calculateOrderRecommendation.bind(this),
      },
      {
        name: 'compare_shipping_options',
        schema: {
          description: 'Compare shipping options (sea, rail, air)',
          inputSchema: {
            type: 'object',
            properties: {
              order_quantity: { type: 'number' },
              unit_cost: { type: 'number' },
              urgency_days: { type: 'number' },
            },
            required: ['order_quantity', 'unit_cost'],
          },
        },
        handler: this._compareShippingOptions.bind(this),
      },

      // ==================== MOQ MANAGEMENT ====================
      {
        name: 'get_product_moq',
        schema: {
          description: 'Get Minimum Order Quantity (MOQ) configuration for a product',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number', description: 'Product ID' },
            },
            required: ['product_id'],
          },
        },
        handler: this._getProductMOQ.bind(this),
      },
      {
        name: 'set_product_moq',
        schema: {
          description: 'Set MOQ configuration for a product',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number', description: 'Product ID' },
              moq: { type: 'number', description: 'Minimum order quantity' },
              moq_unit: { type: 'string', enum: ['units', 'cartons', 'pallets'], default: 'units' },
              units_per_carton: { type: 'number', default: 1 },
              cartons_per_pallet: { type: 'number' },
              order_multiple: { type: 'number', description: 'Must order in multiples of this quantity', default: 1 },
              supplier_id: { type: 'number' },
            },
            required: ['product_id', 'moq'],
          },
        },
        handler: this._setProductMOQ.bind(this),
      },
      {
        name: 'apply_moq_constraints',
        schema: {
          description: 'Apply MOQ constraints to a desired order quantity. Returns adjusted quantity that meets MOQ requirements.',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              desired_quantity: { type: 'number', description: 'Quantity you want to order' },
            },
            required: ['product_id', 'desired_quantity'],
          },
        },
        handler: this._applyMOQConstraints.bind(this),
      },

      // ==================== PRODUCT DIMENSIONS & CONTAINER ====================
      {
        name: 'get_product_dimensions',
        schema: {
          description: 'Get product dimensions for container calculations',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
            },
            required: ['product_id'],
          },
        },
        handler: this._getProductDimensions.bind(this),
      },
      {
        name: 'set_product_dimensions',
        schema: {
          description: 'Set product dimensions for container calculations. All dimensions in cm, weight in kg.',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              length_cm: { type: 'number', description: 'Product length in cm' },
              width_cm: { type: 'number', description: 'Product width in cm' },
              height_cm: { type: 'number', description: 'Product height in cm' },
              weight_kg: { type: 'number', description: 'Product weight in kg' },
              units_per_carton: { type: 'number', description: 'Number of units per carton' },
              carton_length_cm: { type: 'number', description: 'Carton length in cm' },
              carton_width_cm: { type: 'number', description: 'Carton width in cm' },
              carton_height_cm: { type: 'number', description: 'Carton height in cm' },
              carton_weight_kg: { type: 'number', description: 'Carton weight in kg (filled)' },
            },
            required: ['product_id', 'length_cm', 'width_cm', 'height_cm'],
          },
        },
        handler: this._setProductDimensions.bind(this),
      },
      {
        name: 'get_container_specs',
        schema: {
          description: 'Get available container specifications (20ft, 40ft, 40ft HC)',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        handler: this._getContainerSpecs.bind(this),
      },
      {
        name: 'calculate_container_capacity',
        schema: {
          description: 'Calculate how many units of a product fit in a container',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              container_type: { type: 'string', enum: ['20ft', '40ft', '40ft_hc'], default: '40ft' },
            },
            required: ['product_id'],
          },
        },
        handler: this._calculateContainerCapacity.bind(this),
      },
      {
        name: 'optimize_order_for_container',
        schema: {
          description: 'Optimize order quantity for best container utilization. Takes into account MOQ and container fill percentage.',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              desired_quantity: { type: 'number', description: 'How many units you want to order' },
              preferred_container: { type: 'string', enum: ['20ft', '40ft', '40ft_hc'], default: '40ft' },
              max_containers: { type: 'number', description: 'Maximum number of containers to consider', default: 5 },
              min_fill_percent: { type: 'number', description: 'Minimum acceptable container fill %', default: 70 },
            },
            required: ['product_id', 'desired_quantity'],
          },
        },
        handler: this._optimizeOrderForContainer.bind(this),
      },
      {
        name: 'optimize_multi_product_container',
        schema: {
          description: 'Optimize container allocation for multiple products in one shipment',
          inputSchema: {
            type: 'object',
            properties: {
              products: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    product_id: { type: 'number' },
                    desired_quantity: { type: 'number' },
                    priority: { type: 'number', description: 'Higher = more important (0-10)' },
                  },
                },
                description: 'Products to fit in container(s)',
              },
              container_type: { type: 'string', enum: ['20ft', '40ft', '40ft_hc'], default: '40ft' },
              max_containers: { type: 'number', default: 1 },
            },
            required: ['products'],
          },
        },
        handler: this._optimizeMultiProductContainer.bind(this),
      },
      {
        name: 'calculate_order_with_moq_and_container',
        schema: {
          description: 'Calculate final order quantity considering forecast, MOQ, and container optimization. Use this for complete order recommendations.',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              include_cny_buffer: { type: 'boolean', default: true },
              optimize_container: { type: 'boolean', default: true },
            },
            required: ['product_id'],
          },
        },
        handler: this._calculateOrderWithMOQAndContainer.bind(this),
      },

      // ==================== RECOMMENDATIONS ====================
      {
        name: 'get_all_recommendations',
        schema: {
          description: 'Get purchasing recommendations for all products that need attention',
          inputSchema: {
            type: 'object',
            properties: {
              urgent_only: { type: 'boolean', default: false },
              limit: { type: 'number', default: 30 },
            },
          },
        },
        handler: this._getAllRecommendations.bind(this),
      },
      {
        name: 'get_product_analysis',
        schema: {
          description: 'Get comprehensive analysis for a specific product with full reasoning',
          inputSchema: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
            },
            required: ['product_id'],
          },
        },
        handler: this._getProductAnalysis.bind(this),
      },

      // ==================== CALENDAR ====================
      {
        name: 'get_upcoming_seasons',
        schema: {
          description: 'Get upcoming retail seasons',
          inputSchema: {
            type: 'object',
            properties: {
              months_ahead: { type: 'number', default: 6 },
            },
          },
        },
        handler: this._getUpcomingSeasons.bind(this),
      },
      {
        name: 'check_supply_chain_status',
        schema: {
          description: 'Check if supply chain is impacted (CNY, etc.)',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        handler: this._checkSupplyChainStatus.bind(this),
      },
    ];

    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  // ==================== INVOICED SALES DATA ====================

  async _getInvoicedSales(params) {
    const { product_id, sku, days_back = 365, apply_context = true } = params;

    // Try to use synced data first (faster, less load on Odoo)
    if (this.config.preferSyncedData && this.db) {
      const syncedResult = await this._getInvoicedSalesFromSync(product_id, sku, days_back, apply_context);
      if (syncedResult && !syncedResult.error) {
        return syncedResult;
      }
      // Fall back to direct Odoo if synced data not available
      console.log('Synced data not available, falling back to direct Odoo query');
    }

    if (!this.odooClient) {
      return { error: 'Odoo client not configured and no synced data available' };
    }

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days_back);

      // Resolve product ID
      let productId = product_id;
      if (!productId && sku) {
        const products = await this.odooClient.searchRead('product.product', [
          ['default_code', '=', sku],
        ], ['id', 'name'], { limit: 1 });
        if (products.length > 0) {
          productId = products[0].id;
        }
      }

      if (!productId) {
        return { error: 'Product not found' };
      }

      // Get INVOICED quantities from account.move.line (invoice lines)
      // This captures ALL sales: Amazon, Bol.com, direct - everything that was invoiced
      const invoiceLines = await this.odooClient.searchRead('account.move.line', [
        ['product_id', '=', productId],
        ['move_id.move_type', '=', 'out_invoice'], // Customer invoices only
        ['move_id.state', '=', 'posted'], // Only posted (confirmed) invoices
        ['move_id.invoice_date', '>=', cutoffDate.toISOString().split('T')[0]],
      ], [
        'quantity', 'price_subtotal', 'move_id', 'create_date',
      ], { order: 'create_date asc', limit: 10000 });

      // Get invoice dates
      const invoiceIds = [...new Set(invoiceLines.map(l => l.move_id[0]))];
      let invoiceDateMap = new Map();

      if (invoiceIds.length > 0) {
        const invoices = await this.odooClient.read('account.move', invoiceIds, ['invoice_date']);
        invoiceDateMap = new Map(invoices.map(i => [i.id, i.invoice_date]));
      }

      // Build sales history from invoices
      const salesHistory = invoiceLines.map(line => ({
        date: invoiceDateMap.get(line.move_id[0]) || line.create_date,
        quantity: Math.abs(line.quantity), // Invoice lines can be negative for credits
        revenue: Math.abs(line.price_subtotal),
        invoiceId: line.move_id[0],
      }));

      // Calculate raw statistics
      const rawTotalQuantity = salesHistory.reduce((sum, s) => sum + s.quantity, 0);
      const rawTotalRevenue = salesHistory.reduce((sum, s) => sum + s.revenue, 0);

      // Apply context adjustments if requested
      let adjustedTotalQuantity = rawTotalQuantity;
      let contextAdjustments = null;

      if (apply_context) {
        const productContext = await this.purchasingContext.getProductAdjustments(
          productId,
          cutoffDate,
          new Date()
        );

        if (productContext.netAdjustment !== 0) {
          adjustedTotalQuantity = rawTotalQuantity + productContext.netAdjustment;
          contextAdjustments = {
            netAdjustment: productContext.netAdjustment,
            details: productContext.adjustments,
            explanation: productContext.adjustments.map(a =>
              `${a.adjustment > 0 ? '+' : ''}${a.adjustment} (${a.reason})`
            ).join('; '),
          };
        }
      }

      const avgDailySales = adjustedTotalQuantity / days_back;

      return {
        productId,
        dataSource: 'Odoo Invoices (direct query)',
        period: {
          days: days_back,
          from: cutoffDate.toISOString().split('T')[0],
          to: new Date().toISOString().split('T')[0],
        },
        rawStatistics: {
          totalInvoicedQuantity: rawTotalQuantity,
          totalRevenue: Math.round(rawTotalRevenue * 100) / 100,
          invoiceCount: invoiceIds.length,
        },
        contextAdjustments,
        adjustedStatistics: {
          totalQuantity: adjustedTotalQuantity,
          avgDailySales: Math.round(avgDailySales * 100) / 100,
          avgWeeklySales: Math.round(avgDailySales * 7 * 100) / 100,
          avgMonthlySales: Math.round(avgDailySales * 30 * 100) / 100,
        },
        salesHistory, // Raw data for forecasting
        reasoning: this._buildSalesDataReasoning(rawTotalQuantity, contextAdjustments, days_back, 'direct'),
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Get invoiced sales from synced MongoDB data (faster than direct Odoo)
   */
  async _getInvoicedSalesFromSync(productId, sku, daysBack, applyContext) {
    try {
      // Resolve product ID from SKU if needed
      if (!productId && sku) {
        const product = await this.db.collection('purchasing_products')
          .findOne({ sku });
        if (product) {
          productId = product.odooId;
        }
      }

      if (!productId) {
        return null; // Will fall back to direct Odoo
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);

      // Get sales from synced invoice lines
      const invoiceLines = await this.db.collection('purchasing_invoice_lines')
        .find({
          productId,
          invoiceDate: { $gte: cutoffDate },
        })
        .sort({ invoiceDate: 1 })
        .toArray();

      if (invoiceLines.length === 0) {
        return null; // No data, fall back to direct Odoo
      }

      // Build sales history
      const salesHistory = invoiceLines.map(line => ({
        date: line.invoiceDate,
        quantity: line.quantity,
        revenue: line.subtotal,
        invoiceId: line.odooInvoiceId,
      }));

      // Calculate raw statistics
      const rawTotalQuantity = salesHistory.reduce((sum, s) => sum + s.quantity, 0);
      const rawTotalRevenue = salesHistory.reduce((sum, s) => sum + s.revenue, 0);
      const invoiceIds = [...new Set(invoiceLines.map(l => l.odooInvoiceId))];

      // Apply context adjustments if requested
      let adjustedTotalQuantity = rawTotalQuantity;
      let contextAdjustments = null;

      if (applyContext) {
        const productContext = await this.purchasingContext.getProductAdjustments(
          productId,
          cutoffDate,
          new Date()
        );

        if (productContext.netAdjustment !== 0) {
          adjustedTotalQuantity = rawTotalQuantity + productContext.netAdjustment;
          contextAdjustments = {
            netAdjustment: productContext.netAdjustment,
            details: productContext.adjustments,
            explanation: productContext.adjustments.map(a =>
              `${a.adjustment > 0 ? '+' : ''}${a.adjustment} (${a.reason})`
            ).join('; '),
          };
        }
      }

      const avgDailySales = adjustedTotalQuantity / daysBack;

      return {
        productId,
        dataSource: 'Synced Odoo Data (MongoDB)',
        period: {
          days: daysBack,
          from: cutoffDate.toISOString().split('T')[0],
          to: new Date().toISOString().split('T')[0],
        },
        rawStatistics: {
          totalInvoicedQuantity: rawTotalQuantity,
          totalRevenue: Math.round(rawTotalRevenue * 100) / 100,
          invoiceCount: invoiceIds.length,
        },
        contextAdjustments,
        adjustedStatistics: {
          totalQuantity: adjustedTotalQuantity,
          avgDailySales: Math.round(avgDailySales * 100) / 100,
          avgWeeklySales: Math.round(avgDailySales * 7 * 100) / 100,
          avgMonthlySales: Math.round(avgDailySales * 30 * 100) / 100,
        },
        salesHistory,
        reasoning: this._buildSalesDataReasoning(rawTotalQuantity, contextAdjustments, daysBack, 'synced'),
      };
    } catch (error) {
      console.error('Error getting synced sales data:', error.message);
      return null; // Fall back to direct Odoo
    }
  }

  _buildSalesDataReasoning(rawQuantity, contextAdjustments, days, source = 'direct') {
    const sourceLabel = source === 'synced' ? 'MongoDB (synced from Odoo)' : 'Odoo (direct query)';
    let reasoning = `Data Source: ${sourceLabel} - posted customer invoices (${days} days)\n`;
    reasoning += `Raw Invoiced Quantity: ${rawQuantity} units\n`;

    if (contextAdjustments) {
      reasoning += `\nContext Adjustments Applied:\n`;
      reasoning += `${contextAdjustments.explanation}\n`;
      reasoning += `Net Adjustment: ${contextAdjustments.netAdjustment > 0 ? '+' : ''}${contextAdjustments.netAdjustment} units\n`;
      reasoning += `\nWhy adjustments matter: Invoiced quantities may not reflect true demand due to substitutions, stockouts, or one-time orders.`;
    } else {
      reasoning += `No context adjustments needed.`;
    }

    return reasoning;
  }

  async _getStockLevels(params) {
    const { product_ids, low_stock_only = false } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    try {
      const domain = [['type', '=', 'product']];
      if (product_ids && product_ids.length > 0) {
        domain.push(['id', 'in', product_ids]);
      }
      if (low_stock_only) {
        domain.push(['qty_available', '<', 10]);
      }

      const products = await this.odooClient.searchRead('product.product', domain, [
        'name', 'default_code', 'qty_available', 'virtual_available',
        'incoming_qty', 'outgoing_qty', 'standard_price', 'list_price',
      ], { limit: 500 });

      return {
        products: products.map(p => ({
          id: p.id,
          name: p.name,
          sku: p.default_code,
          currentStock: p.qty_available,
          forecastedStock: p.virtual_available,
          incoming: p.incoming_qty,
          outgoing: p.outgoing_qty,
          cost: p.standard_price,
          price: p.list_price,
        })),
        count: products.length,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async _getPendingPurchaseOrders(params) {
    const { supplier_id } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    try {
      const domain = [['state', 'in', ['draft', 'sent', 'to approve', 'purchase']]];
      if (supplier_id) {
        domain.push(['partner_id', '=', supplier_id]);
      }

      const orders = await this.odooClient.searchRead('purchase.order', domain, [
        'name', 'partner_id', 'date_order', 'date_planned', 'amount_total', 'state', 'order_line',
      ], { order: 'date_planned asc', limit: 100 });

      const allLineIds = orders.flatMap(o => o.order_line);
      let lineMap = new Map();

      if (allLineIds.length > 0) {
        const lines = await this.odooClient.read('purchase.order.line', allLineIds, [
          'product_id', 'product_qty', 'qty_received', 'date_planned',
        ]);
        lineMap = new Map(lines.map(l => [l.id, l]));
      }

      return {
        orders: orders.map(o => ({
          id: o.id,
          name: o.name,
          supplier: o.partner_id?.[1],
          orderDate: o.date_order,
          expectedArrival: o.date_planned,
          total: o.amount_total,
          status: o.state,
          items: o.order_line.map(lineId => {
            const line = lineMap.get(lineId);
            return line ? {
              product: line.product_id?.[1],
              productId: line.product_id?.[0],
              ordered: line.product_qty,
              received: line.qty_received,
              pending: line.product_qty - line.qty_received,
            } : null;
          }).filter(Boolean),
        })),
        count: orders.length,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async _getSupplierInfo(params) {
    const { supplier_id, product_id } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    try {
      const domain = [];
      if (supplier_id) domain.push(['partner_id', '=', supplier_id]);
      if (product_id) domain.push(['product_tmpl_id', '=', product_id]);

      const supplierInfo = await this.odooClient.searchRead('product.supplierinfo', domain, [
        'partner_id', 'product_tmpl_id', 'price', 'min_qty', 'delay', 'currency_id',
      ], { limit: 100 });

      return {
        products: supplierInfo.map(s => ({
          supplier: s.partner_id?.[1],
          supplierId: s.partner_id?.[0],
          productId: s.product_tmpl_id?.[0],
          price: s.price,
          minOrderQty: s.min_qty,
          leadTimeDays: s.delay,
          currency: s.currency_id?.[1],
        })),
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  // ==================== CONTEXT MANAGEMENT ====================

  async _getProductContext(params) {
    const { product_id } = params;
    return this.purchasingContext.getProductContext(product_id);
  }

  async _addSubstitution(params) {
    return this.purchasingContext.addSubstitution({
      date: params.date,
      originalProductId: params.original_product_id,
      originalProductName: params.original_product_name,
      substitutedProductId: params.substituted_product_id,
      substitutedProductName: params.substituted_product_name,
      quantity: params.quantity,
      reason: params.reason,
      customerId: params.customer_id,
      customerName: params.customer_name,
      invoiceId: params.invoice_id,
    });
  }

  async _addOneTimeOrder(params) {
    return this.purchasingContext.addOneTimeOrder({
      date: params.date,
      productId: params.product_id,
      productName: params.product_name,
      quantity: params.quantity,
      reason: params.reason,
      customerId: params.customer_id,
      customerName: params.customer_name,
    });
  }

  async _addProductNote(params) {
    return this.purchasingContext.addProductNote({
      productId: params.product_id,
      productName: params.product_name,
      note: params.note,
      impactType: params.impact_type,
      quantityAdjustment: params.quantity_adjustment,
    });
  }

  async _getRecentContexts(params) {
    return this.purchasingContext.getRecentContexts(params.limit);
  }

  // ==================== FORECASTING ====================

  async _generateForecastWithReasoning(params) {
    const { product_id, forecast_weeks = 12, product_category } = params;

    try {
      // Step 1: Get invoiced sales with context
      const salesData = await this._getInvoicedSales({ product_id, days_back: 365, apply_context: true });
      if (salesData.error) {
        return { error: salesData.error };
      }

      // Step 2: Get product context for reasoning
      const productContext = await this._getProductContext({ product_id });

      // Step 3: Generate forecast
      const forecast = await this.forecastEngine.generateForecast(salesData.salesHistory, {
        forecastPeriods: forecast_weeks,
        periodType: 'week',
        productCategory: product_category,
        includeSeasonality: true,
      });

      // Step 4: Get seasonal factors
      const seasonalForecast = this.seasonalCalendar.getSeasonalForecast(new Date(), 3);

      // Step 5: Build comprehensive reasoning
      const reasoning = this._buildForecastReasoning(
        salesData,
        productContext,
        forecast,
        seasonalForecast,
        product_category
      );

      return {
        productId: product_id,
        dataSource: salesData.dataSource,
        period: salesData.period,
        contextSummary: productContext.summary,
        salesStatistics: salesData.adjustedStatistics,
        forecast: forecast.ensembleForecast,
        trendAnalysis: forecast.trendAnalysis,
        confidenceIntervals: forecast.confidenceIntervals,
        upcomingSeasons: seasonalForecast.upcomingSeasons.slice(0, 3),
        reasoning,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  _buildForecastReasoning(salesData, productContext, forecast, seasonalForecast, category) {
    const lines = [];

    lines.push('## FORECAST REASONING\n');

    // Data source
    lines.push('### 1. Data Source');
    lines.push(`- Source: ${salesData.dataSource}`);
    lines.push(`- Period: ${salesData.period.from} to ${salesData.period.to} (${salesData.period.days} days)`);
    lines.push(`- Raw invoiced quantity: ${salesData.rawStatistics.totalInvoicedQuantity} units`);
    lines.push(`- Invoice count: ${salesData.rawStatistics.invoiceCount}`);
    lines.push('');

    // Context adjustments
    if (salesData.contextAdjustments) {
      lines.push('### 2. Context Adjustments Applied');
      lines.push(salesData.contextAdjustments.explanation);
      lines.push(`- Adjusted total: ${salesData.adjustedStatistics.totalQuantity} units`);
      lines.push('');
    }

    if (productContext.summary && productContext.summary !== 'No special context recorded for this product.') {
      lines.push('### Product Context Notes');
      lines.push(productContext.summary);
      lines.push('');
    }

    // Demand statistics
    lines.push('### 3. Demand Statistics');
    lines.push(`- Average daily demand: ${salesData.adjustedStatistics.avgDailySales} units`);
    lines.push(`- Average weekly demand: ${salesData.adjustedStatistics.avgWeeklySales} units`);
    lines.push(`- Average monthly demand: ${salesData.adjustedStatistics.avgMonthlySales} units`);
    lines.push('');

    // Trend
    lines.push('### 4. Trend Analysis');
    lines.push(`- Trend direction: ${forecast.trendAnalysis?.trend || 'stable'}`);
    lines.push(`- Confidence: ${forecast.trendAnalysis?.confidence || 'medium'}`);
    if (forecast.trendAnalysis?.percentageChangePerPeriod) {
      lines.push(`- Change per period: ${forecast.trendAnalysis.percentageChangePerPeriod.toFixed(1)}%`);
    }
    lines.push('');

    // Seasonal factors
    lines.push('### 5. Seasonal Factors');
    const upcomingSeasons = seasonalForecast.upcomingSeasons.slice(0, 3);
    if (upcomingSeasons.length > 0) {
      for (const season of upcomingSeasons) {
        const categoryMatch = !category || season.categories.includes('all') || season.categories.includes(category.toLowerCase());
        lines.push(`- ${season.name} (${season.daysUntilStart} days): ${season.demandMultiplier}x multiplier ${categoryMatch ? '✓ applies' : '(not applicable to category)'}`);
      }
    } else {
      lines.push('- No major seasons in the next 3 months');
    }
    lines.push('');

    // Forecast summary
    lines.push('### 6. Forecast Summary');
    if (forecast.ensembleForecast?.forecast) {
      const avgForecast = forecast.ensembleForecast.avgForecast;
      lines.push(`- Ensemble forecast average: ${avgForecast} units/week`);
      lines.push(`- Forecast method: Weighted average of Moving Average, Exponential Smoothing, and Holt-Winters`);
    }

    return lines.join('\n');
  }

  async _getSeasonalFactors(params) {
    const { months_ahead = 6, product_category } = params;
    const forecast = this.seasonalCalendar.getSeasonalForecast(new Date(), months_ahead);

    if (product_category) {
      for (const key of Object.keys(forecast.monthlyMultipliers)) {
        const monthDate = new Date(key + '-01');
        forecast.monthlyMultipliers[key].categoryMultiplier =
          this.seasonalCalendar.getDemandMultiplier(product_category, monthDate);
      }
    }

    return forecast;
  }

  // ==================== SUPPLY CHAIN ====================

  async _getCNYInfo(params) {
    const { year } = params;
    const currentYear = new Date().getFullYear();
    const targetYear = year || (new Date() > this.seasonalCalendar.getCNYDate(currentYear) ? currentYear + 1 : currentYear);

    const cnyPeriod = this.seasonalCalendar.getCNYClosurePeriod(targetYear);
    const orderDeadline = this.seasonalCalendar.getCNYOrderDeadline(targetYear);

    return {
      year: targetYear,
      cnyDate: cnyPeriod.cnyDate,
      closurePeriod: cnyPeriod,
      orderDeadline,
      recommendation: orderDeadline.daysUntilDeadline <= 0
        ? 'CRITICAL: Order deadline has passed! Consider air freight for urgent items.'
        : orderDeadline.daysUntilDeadline <= 14
        ? `URGENT: Only ${orderDeadline.daysUntilDeadline} days until order deadline. Place orders immediately.`
        : `Order deadline: ${orderDeadline.orderDeadline.toDateString()} (${orderDeadline.daysUntilDeadline} days remaining)`,
    };
  }

  async _calculateOrderRecommendation(params) {
    const { product_id, include_cny_buffer = true } = params;

    try {
      // Get all necessary data
      const [salesData, stockLevels, productContext, pendingPOs] = await Promise.all([
        this._getInvoicedSales({ product_id, days_back: 365, apply_context: true }),
        this._getStockLevels({ product_ids: [product_id] }),
        this._getProductContext({ product_id }),
        this._getPendingPurchaseOrders({}),
      ]);

      if (salesData.error) return { error: salesData.error };

      const product = stockLevels.products[0];
      if (!product) return { error: 'Product not found in stock' };

      const avgDailySales = salesData.adjustedStatistics.avgDailySales;
      const currentStock = product.currentStock;
      const incoming = product.incoming;

      // Find pending POs for this product
      let pendingQuantity = 0;
      for (const po of pendingPOs.orders || []) {
        for (const item of po.items || []) {
          if (item.productId === product_id) {
            pendingQuantity += item.pending;
          }
        }
      }

      // Calculate lead time
      const leadTime = this.supplyChainManager.getTotalLeadTime(null, 'sea');

      // Calculate reorder point
      const reorderPoint = this.supplyChainManager.calculateReorderPoint({
        avgDailyDemand: avgDailySales,
        demandStdDev: avgDailySales * 0.3,
      });

      // Check CNY
      const cnyInfo = await this._getCNYInfo({});
      let cnyBuffer = 0;
      let cnyReasoning = '';

      if (include_cny_buffer && cnyInfo.orderDeadline.daysUntilDeadline > 0 && cnyInfo.orderDeadline.daysUntilDeadline <= 90) {
        // Need to cover CNY closure period
        const closureDays = cnyInfo.closurePeriod.totalClosureDays + cnyInfo.closurePeriod.recoveryDays;
        cnyBuffer = Math.ceil(avgDailySales * closureDays * this.config.cnyBufferMultiplier);
        cnyReasoning = `CNY buffer: ${closureDays} days × ${avgDailySales.toFixed(1)} units/day × ${this.config.cnyBufferMultiplier} safety = ${cnyBuffer} units`;
      }

      // Calculate available stock
      const availableStock = currentStock + incoming + pendingQuantity;

      // Calculate recommendation
      const targetStock = reorderPoint.reorderPoint + cnyBuffer;
      const recommendedOrder = Math.max(0, targetStock - availableStock);

      // Determine urgency
      let urgency = 'none';
      let action = 'monitor';
      const daysOfStock = availableStock / avgDailySales;

      if (availableStock <= reorderPoint.safetyStock) {
        urgency = 'critical';
        action = 'order_immediately';
      } else if (availableStock <= reorderPoint.reorderPoint) {
        urgency = 'high';
        action = 'order_this_week';
      } else if (cnyInfo.orderDeadline.daysUntilDeadline <= 14 && recommendedOrder > 0) {
        urgency = 'high';
        action = 'order_for_cny';
      } else if (daysOfStock < leadTime.totalDays) {
        urgency = 'moderate';
        action = 'plan_order';
      }

      // Build reasoning
      const reasoning = this._buildOrderReasoning({
        product,
        salesData,
        productContext,
        currentStock,
        incoming,
        pendingQuantity,
        availableStock,
        leadTime,
        reorderPoint,
        cnyBuffer,
        cnyReasoning,
        cnyInfo,
        targetStock,
        recommendedOrder,
        urgency,
        daysOfStock,
      });

      return {
        productId: product_id,
        productName: product.name,
        recommendation: {
          orderQuantity: recommendedOrder,
          urgency,
          action,
          orderDeadline: urgency === 'critical' ? 'IMMEDIATELY' :
            cnyInfo.orderDeadline.daysUntilDeadline <= 14 ? cnyInfo.orderDeadline.orderDeadline :
            null,
        },
        currentState: {
          currentStock,
          incoming,
          pendingOrders: pendingQuantity,
          availableStock,
          daysOfStock: Math.round(daysOfStock),
        },
        calculations: {
          avgDailySales,
          leadTimeDays: leadTime.totalDays,
          reorderPoint: reorderPoint.reorderPoint,
          safetyStock: reorderPoint.safetyStock,
          cnyBuffer,
          targetStock,
        },
        contextSummary: productContext.summary,
        reasoning,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  _buildOrderReasoning(data) {
    const lines = [];

    lines.push('## ORDER RECOMMENDATION REASONING\n');

    lines.push('### 1. Current Inventory Position');
    lines.push(`- Current stock: ${data.currentStock} units`);
    lines.push(`- Incoming (in transit): ${data.incoming} units`);
    lines.push(`- Pending POs: ${data.pendingQuantity} units`);
    lines.push(`- Total available: ${data.availableStock} units`);
    lines.push(`- Days of stock: ${Math.round(data.daysOfStock)} days`);
    lines.push('');

    lines.push('### 2. Demand Analysis');
    lines.push(`- Data source: ${data.salesData.dataSource}`);
    lines.push(`- Period: ${data.salesData.period.days} days`);
    lines.push(`- Average daily sales: ${data.salesData.adjustedStatistics.avgDailySales} units`);

    if (data.salesData.contextAdjustments) {
      lines.push(`- Context adjustments: ${data.salesData.contextAdjustments.explanation}`);
    }
    lines.push('');

    if (data.productContext.summary && data.productContext.summary !== 'No special context recorded for this product.') {
      lines.push('### 3. Product Context');
      lines.push(data.productContext.summary);
      lines.push('');
    }

    lines.push('### 4. Reorder Calculations');
    lines.push(`- Lead time: ${data.leadTime.totalDays} days (${data.leadTime.description})`);
    lines.push(`- Reorder point: ${data.reorderPoint.reorderPoint} units`);
    lines.push(`- Safety stock: ${data.reorderPoint.safetyStock} units`);
    lines.push('');

    if (data.cnyBuffer > 0) {
      lines.push('### 5. Chinese New Year Buffer');
      lines.push(`- CNY Date: ${data.cnyInfo.cnyDate.toDateString()}`);
      lines.push(`- Order deadline: ${data.cnyInfo.orderDeadline.orderDeadline.toDateString()}`);
      lines.push(`- ${data.cnyReasoning}`);
      lines.push('');
    }

    lines.push('### RECOMMENDATION');
    lines.push(`- Target stock level: ${data.targetStock} units`);
    lines.push(`- Current available: ${data.availableStock} units`);
    lines.push(`- **Recommended order: ${data.recommendedOrder} units**`);
    lines.push(`- Urgency: ${data.urgency.toUpperCase()}`);

    if (data.urgency === 'critical') {
      lines.push('\n⚠️ CRITICAL: Stock is below safety level. Order immediately to prevent stockout!');
    } else if (data.urgency === 'high') {
      lines.push('\n⚠️ HIGH PRIORITY: Order within 7 days to maintain adequate stock levels.');
    }

    return lines.join('\n');
  }

  async _compareShippingOptions(params) {
    return this.supplyChainManager.compareShippingOptions(params);
  }

  // ==================== MOQ MANAGEMENT ====================

  async _getProductMOQ(params) {
    const { product_id } = params;
    const moq = this.supplyChainManager.getProductMOQ(product_id);

    // Also try to get from Odoo if not set locally
    if (moq.moq === 1 && this.odooClient) {
      try {
        const supplierInfo = await this._getSupplierInfo({ product_id });
        if (supplierInfo.products && supplierInfo.products.length > 0) {
          const odooMOQ = supplierInfo.products[0].minOrderQty;
          if (odooMOQ && odooMOQ > 1) {
            return {
              ...moq,
              moq: odooMOQ,
              source: 'odoo_supplier_info',
              supplierLeadTime: supplierInfo.products[0].leadTimeDays,
            };
          }
        }
      } catch (e) {
        // Ignore Odoo errors, use local config
      }
    }

    return { ...moq, source: 'local_config' };
  }

  async _setProductMOQ(params) {
    const {
      product_id,
      moq,
      moq_unit = 'units',
      units_per_carton = 1,
      cartons_per_pallet,
      order_multiple = 1,
      supplier_id,
    } = params;

    const result = this.supplyChainManager.setProductMOQ(product_id, {
      moq,
      moqUnit: moq_unit,
      unitsPerCarton: units_per_carton,
      cartonsPerPallet: cartons_per_pallet,
      orderMultiple: order_multiple,
      supplierId: supplier_id,
    });

    return {
      success: true,
      data: result,
      message: `MOQ set for product ${product_id}: ${moq} ${moq_unit}${order_multiple > 1 ? `, orders in multiples of ${order_multiple}` : ''}`,
    };
  }

  async _applyMOQConstraints(params) {
    const { product_id, desired_quantity } = params;
    return this.supplyChainManager.applyMOQConstraints({
      productId: product_id,
      desiredQuantity: desired_quantity,
    });
  }

  // ==================== PRODUCT DIMENSIONS & CONTAINER ====================

  async _getProductDimensions(params) {
    const { product_id } = params;
    const dims = this.supplyChainManager.getProductDimensions(product_id);

    if (!dims) {
      // Try to get from Odoo if available
      if (this.odooClient) {
        try {
          const products = await this.odooClient.searchRead('product.product', [
            ['id', '=', product_id],
          ], [
            'name', 'volume', 'weight',
            'product_length', 'product_width', 'product_height', // If these fields exist
          ], { limit: 1 });

          if (products.length > 0) {
            const p = products[0];
            if (p.volume || p.weight) {
              return {
                productId: product_id,
                source: 'odoo',
                volumeM3: p.volume || null,
                weightKg: p.weight || null,
                note: 'Dimensions not fully configured. Please set dimensions for accurate container calculations.',
              };
            }
          }
        } catch (e) {
          // Ignore Odoo errors
        }
      }

      return {
        error: 'No dimensions found for product',
        productId: product_id,
        note: 'Use set_product_dimensions to configure product dimensions for container optimization.',
      };
    }

    return { ...dims, source: 'local_config' };
  }

  async _setProductDimensions(params) {
    const {
      product_id,
      length_cm,
      width_cm,
      height_cm,
      weight_kg,
      units_per_carton,
      carton_length_cm,
      carton_width_cm,
      carton_height_cm,
      carton_weight_kg,
    } = params;

    const result = this.supplyChainManager.setProductDimensions(product_id, {
      lengthCm: length_cm,
      widthCm: width_cm,
      heightCm: height_cm,
      weightKg: weight_kg,
      unitsPerCarton: units_per_carton,
      cartonLengthCm: carton_length_cm,
      cartonWidthCm: carton_width_cm,
      cartonHeightCm: carton_height_cm,
      cartonWeightKg: carton_weight_kg,
    });

    return {
      success: true,
      data: result,
      message: `Dimensions set for product ${product_id}: ${result.volumeM3.toFixed(4)} m³ per unit`,
    };
  }

  async _getContainerSpecs() {
    return {
      containers: this.supplyChainManager.containerSpecs,
      note: 'Volume shown is total capacity. Usable volume is ~85% due to packing inefficiency.',
    };
  }

  async _calculateContainerCapacity(params) {
    const { product_id, container_type = '40ft' } = params;
    return this.supplyChainManager.calculateContainerCapacity(product_id, container_type);
  }

  async _optimizeOrderForContainer(params) {
    const {
      product_id,
      desired_quantity,
      preferred_container = '40ft',
      max_containers = 5,
      min_fill_percent = 70,
    } = params;

    return this.supplyChainManager.optimizeForContainer({
      productId: product_id,
      desiredQuantity: desired_quantity,
      preferredContainer: preferred_container,
      maxContainers: max_containers,
      minFillPercent: min_fill_percent,
    });
  }

  async _optimizeMultiProductContainer(params) {
    const { products, container_type = '40ft', max_containers = 1 } = params;

    return this.supplyChainManager.optimizeMultiProductContainer({
      products: products.map(p => ({
        productId: p.product_id,
        desiredQuantity: p.desired_quantity,
        priority: p.priority || 0,
      })),
      containerType: container_type,
      maxContainers: max_containers,
    });
  }

  /**
   * Complete order recommendation considering MOQ and container optimization
   */
  async _calculateOrderWithMOQAndContainer(params) {
    const { product_id, include_cny_buffer = true, optimize_container = true } = params;

    try {
      // Get base order recommendation
      const baseRecommendation = await this._calculateOrderRecommendation({
        product_id,
        include_cny_buffer,
      });

      if (baseRecommendation.error) {
        return baseRecommendation;
      }

      const baseQuantity = baseRecommendation.recommendation.orderQuantity;

      if (baseQuantity <= 0) {
        return {
          ...baseRecommendation,
          moqAdjustment: null,
          containerOptimization: null,
          finalQuantity: 0,
          finalReasoning: 'No order needed at this time.',
        };
      }

      // Apply MOQ constraints
      const moqResult = await this._applyMOQConstraints({
        product_id,
        desired_quantity: baseQuantity,
      });

      let finalQuantity = moqResult.adjustedQuantity;
      let containerResult = null;

      // Optimize for container if dimensions are available
      if (optimize_container) {
        const dims = this.supplyChainManager.getProductDimensions(product_id);
        if (dims) {
          containerResult = await this._optimizeOrderForContainer({
            product_id,
            desired_quantity: moqResult.adjustedQuantity,
          });

          if (containerResult.recommendation) {
            finalQuantity = containerResult.recommendation.quantity;
          }
        }
      }

      // Build final reasoning
      const finalReasoning = this._buildMOQContainerReasoning(
        baseQuantity,
        moqResult,
        containerResult,
        finalQuantity
      );

      return {
        ...baseRecommendation,
        baseQuantity,
        moqAdjustment: moqResult,
        containerOptimization: containerResult,
        finalRecommendation: {
          quantity: finalQuantity,
          breakdown: moqResult.breakdown,
          containerType: containerResult?.recommendation?.containerType || null,
          containerFillPercent: containerResult?.recommendation?.fillPercent || null,
        },
        finalReasoning,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  _buildMOQContainerReasoning(baseQuantity, moqResult, containerResult, finalQuantity) {
    const lines = [];

    lines.push('## FINAL ORDER QUANTITY CALCULATION\n');

    lines.push('### Step 1: Base Forecast Recommendation');
    lines.push(`- Forecasted need: ${baseQuantity} units`);
    lines.push('');

    lines.push('### Step 2: MOQ Adjustment');
    if (moqResult.moqApplied) {
      lines.push(`- MOQ: ${moqResult.moqConfig.moq} ${moqResult.moqConfig.moqUnit}`);
      if (moqResult.moqConfig.orderMultiple > 1) {
        lines.push(`- Order multiple: ${moqResult.moqConfig.orderMultiple}`);
      }
      lines.push(`- Adjusted quantity: ${moqResult.adjustedQuantity} units`);
      lines.push(`- ${moqResult.reasoning}`);
    } else {
      lines.push(`- Quantity ${baseQuantity} meets MOQ requirements`);
    }
    lines.push('');

    if (containerResult) {
      lines.push('### Step 3: Container Optimization');
      if (containerResult.recommendation) {
        const rec = containerResult.recommendation;
        lines.push(`- Container type: ${rec.containerType}`);
        lines.push(`- Containers needed: ${rec.numContainers}`);
        lines.push(`- Container fill: ${rec.fillPercent}%`);
        if (rec.extraUnits > 0) {
          lines.push(`- Extra units to fill container: +${rec.extraUnits}`);
        }
        lines.push(`- ${rec.reasoning}`);
      } else if (containerResult.error) {
        lines.push(`- Container optimization skipped: ${containerResult.error}`);
      }
      lines.push('');
    }

    lines.push('### FINAL RECOMMENDATION');
    lines.push(`**Order Quantity: ${finalQuantity} units**`);

    if (moqResult.breakdown) {
      const b = moqResult.breakdown;
      if (b.cartons > 1) {
        lines.push(`- = ${b.cartons} cartons × ${b.unitsPerCarton} units/carton`);
      }
      if (b.pallets) {
        lines.push(`- = ${b.pallets} pallets`);
      }
    }

    return lines.join('\n');
  }

  // ==================== RECOMMENDATIONS ====================

  async _getAllRecommendations(params) {
    const { urgent_only = false, limit = 30 } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    try {
      // Get low stock products
      const stockLevels = await this._getStockLevels({ low_stock_only: true });

      const recommendations = [];

      for (const product of stockLevels.products.slice(0, limit)) {
        const orderRec = await this._calculateOrderRecommendation({ product_id: product.id });

        if (orderRec.error) continue;

        if (urgent_only && orderRec.recommendation.urgency === 'none') continue;

        recommendations.push({
          product: {
            id: product.id,
            name: product.name,
            sku: product.sku,
          },
          ...orderRec.recommendation,
          currentState: orderRec.currentState,
          calculations: orderRec.calculations,
          reasoning: orderRec.reasoning,
        });
      }

      // Sort by urgency
      const urgencyOrder = { critical: 0, high: 1, moderate: 2, none: 3 };
      recommendations.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

      const supplyChainStatus = this.seasonalCalendar.isSupplyChainImpacted();

      return {
        recommendations,
        count: recommendations.length,
        summary: {
          critical: recommendations.filter(r => r.urgency === 'critical').length,
          high: recommendations.filter(r => r.urgency === 'high').length,
          moderate: recommendations.filter(r => r.urgency === 'moderate').length,
        },
        supplyChainStatus,
        generatedAt: new Date(),
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async _getProductAnalysis(params) {
    const { product_id } = params;
    return this._calculateOrderRecommendation({ product_id, include_cny_buffer: true });
  }

  // ==================== CALENDAR ====================

  async _getUpcomingSeasons(params) {
    const { months_ahead = 6 } = params;
    return {
      seasons: this.seasonalCalendar.getUpcomingSeasons(new Date(), months_ahead * 30),
      holidays: this.seasonalCalendar.getHolidays(new Date().getFullYear()),
    };
  }

  async _checkSupplyChainStatus() {
    return this.seasonalCalendar.isSupplyChainImpacted();
  }

  // ==================== SETTERS ====================

  setOdooClient(client) {
    this.odooClient = client;
  }

  setDatabase(db) {
    this.db = db;
    this.purchasingContext.setDb(db);
  }
}

module.exports = {
  PurchasingIntelligenceAgent,
};
