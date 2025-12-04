/**
 * Product Development Agent
 *
 * Manages product lifecycle and development:
 * - Product catalog management
 * - New product ideation and tracking
 * - Competitor analysis
 * - Product performance monitoring
 * - Inventory optimization recommendations
 * - Pricing strategy support
 * - Product roadmap tracking
 *
 * Integrates with:
 * - Odoo Products/Inventory
 * - E-commerce platforms (Amazon, Bol.com)
 * - Market data
 *
 * @module ProductDevelopmentAgent
 */

const LLMAgent = require('../LLMAgent');

/**
 * Product lifecycle stages
 */
const ProductStage = {
  IDEATION: 'ideation',
  DEVELOPMENT: 'development',
  TESTING: 'testing',
  LAUNCH: 'launch',
  GROWTH: 'growth',
  MATURITY: 'maturity',
  DECLINE: 'decline',
  DISCONTINUED: 'discontinued'
};

/**
 * Product categories
 */
const ProductCategory = {
  STAR: 'star',           // High growth, high market share
  CASH_COW: 'cash_cow',   // Low growth, high market share
  QUESTION_MARK: 'question_mark', // High growth, low market share
  DOG: 'dog'              // Low growth, low market share
};

class ProductDevelopmentAgent extends LLMAgent {
  constructor(id, config = {}) {
    super(id, {
      name: config.name || 'Product Development Agent',
      role: 'product_development',
      capabilities: [
        'product_catalog_management',
        'product_performance_analysis',
        'competitor_tracking',
        'pricing_optimization',
        'inventory_recommendations',
        'product_roadmap',
        'market_analysis'
      ],
      ...config
    });

    // Odoo client
    this.odooClient = config.odooClient || null;

    // E-commerce clients
    this.amazonClient = config.amazonClient || null;
    this.bolClient = config.bolClient || null;

    // Product tracking
    this.productCache = new Map();
    this.competitorData = new Map();
    this.roadmapItems = [];

    // Settings
    this.settings = {
      lowStockThreshold: config.lowStockThreshold || 10,
      highMarginThreshold: config.highMarginThreshold || 0.3,
      lowMarginThreshold: config.lowMarginThreshold || 0.1,
      slowMovingDays: config.slowMovingDays || 90
    };

    this._initializeTools();
  }

  _initializeTools() {
    this.tools = [
      // ==================== PRODUCT CATALOG ====================
      {
        name: 'get_all_products',
        description: 'Get all products from catalog',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by category' },
            active_only: { type: 'boolean', default: true },
            limit: { type: 'number', default: 100 }
          }
        },
        handler: this._getAllProducts.bind(this)
      },
      {
        name: 'get_product_details',
        description: 'Get detailed information about a product',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number' }
          },
          required: ['product_id']
        },
        handler: this._getProductDetails.bind(this)
      },
      {
        name: 'search_products',
        description: 'Search products by name, SKU, or description',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' }
          },
          required: ['query']
        },
        handler: this._searchProducts.bind(this)
      },
      {
        name: 'create_product',
        description: 'Create a new product (requires approval)',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            sku: { type: 'string' },
            description: { type: 'string' },
            category_id: { type: 'number' },
            list_price: { type: 'number' },
            cost: { type: 'number' }
          },
          required: ['name']
        },
        handler: this._createProduct.bind(this)
      },
      {
        name: 'update_product',
        description: 'Update product information',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number' },
            updates: { type: 'object' }
          },
          required: ['product_id', 'updates']
        },
        handler: this._updateProduct.bind(this)
      },

      // ==================== PERFORMANCE ANALYSIS ====================
      {
        name: 'get_product_performance',
        description: 'Analyze product sales performance',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number' },
            period_days: { type: 'number', default: 30 }
          },
          required: ['product_id']
        },
        handler: this._getProductPerformance.bind(this)
      },
      {
        name: 'get_top_performers',
        description: 'Get best performing products',
        parameters: {
          type: 'object',
          properties: {
            metric: { type: 'string', enum: ['revenue', 'units', 'margin'], default: 'revenue' },
            period_days: { type: 'number', default: 30 },
            limit: { type: 'number', default: 20 }
          }
        },
        handler: this._getTopPerformers.bind(this)
      },
      {
        name: 'get_underperformers',
        description: 'Get underperforming products needing attention',
        parameters: {
          type: 'object',
          properties: {
            period_days: { type: 'number', default: 30 }
          }
        },
        handler: this._getUnderperformers.bind(this)
      },
      {
        name: 'get_product_portfolio_analysis',
        description: 'BCG matrix analysis of product portfolio',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getPortfolioAnalysis.bind(this)
      },

      // ==================== INVENTORY ====================
      {
        name: 'get_inventory_status',
        description: 'Get inventory status across all products',
        parameters: {
          type: 'object',
          properties: {
            include_forecasts: { type: 'boolean', default: true }
          }
        },
        handler: this._getInventoryStatus.bind(this)
      },
      {
        name: 'get_slow_moving_products',
        description: 'Identify slow-moving inventory',
        parameters: {
          type: 'object',
          properties: {
            days_threshold: { type: 'number', default: 90 }
          }
        },
        handler: this._getSlowMovingProducts.bind(this)
      },
      {
        name: 'get_stock_recommendations',
        description: 'Get stock level optimization recommendations',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getStockRecommendations.bind(this)
      },

      // ==================== PRICING ====================
      {
        name: 'analyze_pricing',
        description: 'Analyze product pricing and margins',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number' }
          }
        },
        handler: this._analyzePricing.bind(this)
      },
      {
        name: 'get_margin_analysis',
        description: 'Get margin analysis across products',
        parameters: {
          type: 'object',
          properties: {
            threshold: { type: 'string', enum: ['low', 'high', 'all'], default: 'all' }
          }
        },
        handler: this._getMarginAnalysis.bind(this)
      },
      {
        name: 'suggest_price_optimization',
        description: 'Get AI-powered pricing suggestions',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number' },
            goal: { type: 'string', enum: ['maximize_revenue', 'maximize_margin', 'increase_volume'], default: 'maximize_margin' }
          },
          required: ['product_id']
        },
        handler: this._suggestPriceOptimization.bind(this)
      },

      // ==================== MARKETPLACE ====================
      {
        name: 'get_marketplace_performance',
        description: 'Get product performance across marketplaces',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number' },
            marketplace: { type: 'string', enum: ['amazon', 'bolcom', 'all'], default: 'all' }
          }
        },
        handler: this._getMarketplacePerformance.bind(this)
      },
      {
        name: 'sync_marketplace_listings',
        description: 'Check synchronization status with marketplaces',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._syncMarketplaceListings.bind(this)
      },

      // ==================== PRODUCT DEVELOPMENT ====================
      {
        name: 'get_product_roadmap',
        description: 'Get product development roadmap',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['planned', 'in_progress', 'completed', 'all'], default: 'all' }
          }
        },
        handler: this._getProductRoadmap.bind(this)
      },
      {
        name: 'add_roadmap_item',
        description: 'Add item to product roadmap',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            type: { type: 'string', enum: ['new_product', 'improvement', 'variant', 'discontinue'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            target_date: { type: 'string' }
          },
          required: ['title', 'type']
        },
        handler: this._addRoadmapItem.bind(this)
      },
      {
        name: 'get_product_ideas',
        description: 'Get AI-generated product ideas based on market trends',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Product category to focus on' }
          }
        },
        handler: this._getProductIdeas.bind(this)
      },

      // ==================== COMPETITOR ANALYSIS ====================
      {
        name: 'track_competitor_product',
        description: 'Add a competitor product to track',
        parameters: {
          type: 'object',
          properties: {
            competitor_name: { type: 'string' },
            product_name: { type: 'string' },
            url: { type: 'string' },
            price: { type: 'number' }
          },
          required: ['competitor_name', 'product_name']
        },
        handler: this._trackCompetitorProduct.bind(this)
      },
      {
        name: 'get_competitor_analysis',
        description: 'Get competitor product analysis',
        parameters: {
          type: 'object',
          properties: {
            product_id: { type: 'number', description: 'Your product to compare' }
          }
        },
        handler: this._getCompetitorAnalysis.bind(this)
      },

      // ==================== REPORTS ====================
      {
        name: 'generate_product_report',
        description: 'Generate comprehensive product report',
        parameters: {
          type: 'object',
          properties: {
            report_type: { type: 'string', enum: ['overview', 'performance', 'inventory', 'all'], default: 'overview' }
          }
        },
        handler: this._generateProductReport.bind(this)
      }
    ];
  }

  // ==================== PRODUCT CATALOG ====================

  async _getAllProducts(params = {}) {
    const { category, active_only = true, limit = 100 } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const domain = [['type', '=', 'product']];
    if (active_only) domain.push(['active', '=', true]);
    if (category) domain.push(['categ_id.name', 'ilike', category]);

    const products = await this.odooClient.searchRead('product.product', domain, [
      'name', 'default_code', 'categ_id', 'list_price', 'standard_price',
      'qty_available', 'virtual_available', 'active', 'description_sale'
    ], { limit });

    return {
      products: products.map(p => ({
        id: p.id,
        name: p.name,
        sku: p.default_code,
        category: p.categ_id?.[1],
        price: p.list_price,
        cost: p.standard_price,
        margin: p.list_price > 0 ? ((p.list_price - p.standard_price) / p.list_price * 100).toFixed(1) + '%' : 'N/A',
        stockOnHand: p.qty_available,
        stockForecast: p.virtual_available,
        active: p.active
      })),
      count: products.length
    };
  }

  async _getProductDetails(params) {
    const { product_id } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const product = await this.odooClient.read('product.product', [product_id], [
      'name', 'default_code', 'categ_id', 'list_price', 'standard_price',
      'qty_available', 'virtual_available', 'description', 'description_sale',
      'seller_ids', 'image_128', 'barcode', 'weight', 'volume'
    ]);

    if (!product.length) return { error: 'Product not found' };

    const p = product[0];

    // Get sales data
    const sales = await this._getProductSalesData(product_id, 30);

    return {
      id: p.id,
      name: p.name,
      sku: p.default_code,
      barcode: p.barcode,
      category: p.categ_id?.[1],
      pricing: {
        listPrice: p.list_price,
        cost: p.standard_price,
        margin: p.list_price > 0 ? ((p.list_price - p.standard_price) / p.list_price * 100).toFixed(1) + '%' : 'N/A'
      },
      inventory: {
        onHand: p.qty_available,
        forecast: p.virtual_available,
        status: p.qty_available <= 0 ? 'out_of_stock' :
                p.qty_available < this.settings.lowStockThreshold ? 'low_stock' : 'in_stock'
      },
      physical: {
        weight: p.weight,
        volume: p.volume
      },
      description: p.description_sale || p.description,
      supplierCount: p.seller_ids?.length || 0,
      salesLast30Days: sales
    };
  }

  async _searchProducts(params) {
    const { query } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const domain = [
      '|', '|',
      ['name', 'ilike', query],
      ['default_code', 'ilike', query],
      ['description', 'ilike', query]
    ];

    const products = await this.odooClient.searchRead('product.product', domain, [
      'name', 'default_code', 'list_price', 'qty_available'
    ], { limit: 50 });

    return {
      query,
      results: products.map(p => ({
        id: p.id,
        name: p.name,
        sku: p.default_code,
        price: p.list_price,
        stock: p.qty_available
      })),
      count: products.length
    };
  }

  async _createProduct(params) {
    const { name, sku, description, category_id, list_price, cost } = params;

    return {
      status: 'pending_approval',
      message: 'Product creation requires human approval',
      productDetails: { name, sku, description, category_id, list_price, cost }
    };
  }

  async _updateProduct(params) {
    const { product_id, updates } = params;

    return {
      status: 'pending_approval',
      message: 'Product update requires human approval',
      productId: product_id,
      updates
    };
  }

  // ==================== PERFORMANCE ANALYSIS ====================

  async _getProductSalesData(productId, days) {
    if (!this.odooClient) return null;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    try {
      const orderLines = await this.odooClient.searchRead('sale.order.line', [
        ['product_id', '=', productId],
        ['order_id.state', 'in', ['sale', 'done']],
        ['order_id.date_order', '>=', cutoffDate.toISOString().split('T')[0]]
      ], ['product_uom_qty', 'price_subtotal']);

      const totalUnits = orderLines.reduce((sum, l) => sum + (l.product_uom_qty || 0), 0);
      const totalRevenue = orderLines.reduce((sum, l) => sum + (l.price_subtotal || 0), 0);

      return {
        units: totalUnits,
        revenue: totalRevenue,
        orders: orderLines.length
      };
    } catch (_e) {
      return null;
    }
  }

  async _getProductPerformance(params) {
    const { product_id, period_days = 30 } = params;

    const details = await this._getProductDetails({ product_id });
    if (details.error) return details;

    const sales = await this._getProductSalesData(product_id, period_days);

    return {
      product: {
        id: product_id,
        name: details.name,
        sku: details.sku
      },
      period: `${period_days} days`,
      performance: {
        unitsSold: sales?.units || 0,
        revenue: sales?.revenue || 0,
        orders: sales?.orders || 0,
        avgOrderValue: sales?.orders > 0 ? (sales.revenue / sales.orders).toFixed(2) : 0
      },
      inventory: details.inventory,
      pricing: details.pricing
    };
  }

  async _getTopPerformers(params = {}) {
    const { metric = 'revenue', period_days = 30, limit = 20 } = params;

    const allProducts = await this._getAllProducts({ limit: 200 });
    if (allProducts.error) return allProducts;

    const performanceData = [];

    for (const product of allProducts.products.slice(0, 50)) {  // Limit to avoid too many queries
      const sales = await this._getProductSalesData(product.id, period_days);
      if (sales) {
        performanceData.push({
          ...product,
          unitsSold: sales.units,
          revenue: sales.revenue,
          margin: ((product.price - product.cost) * sales.units)
        });
      }
    }

    // Sort by metric
    performanceData.sort((a, b) => b[metric] - a[metric]);

    return {
      metric,
      period: `${period_days} days`,
      topProducts: performanceData.slice(0, limit),
      count: Math.min(performanceData.length, limit)
    };
  }

  async _getUnderperformers(params = {}) {
    const { period_days = 30 } = params;

    const allProducts = await this._getAllProducts({ limit: 200 });
    if (allProducts.error) return allProducts;

    const underperformers = [];

    for (const product of allProducts.products) {
      const sales = await this._getProductSalesData(product.id, period_days);

      const issues = [];
      if (!sales || sales.units === 0) issues.push('No sales');
      if (product.stockOnHand > 50 && (!sales || sales.units < 5)) issues.push('High stock, low sales');

      const marginPct = parseFloat(product.margin);
      if (marginPct < this.settings.lowMarginThreshold * 100) issues.push('Low margin');

      if (issues.length > 0) {
        underperformers.push({
          ...product,
          sales: sales || { units: 0, revenue: 0 },
          issues
        });
      }
    }

    return {
      period: `${period_days} days`,
      underperformers,
      count: underperformers.length
    };
  }

  async _getPortfolioAnalysis(_params = {}) {
    // BCG Matrix analysis
    const products = await this._getAllProducts({ limit: 100 });
    if (products.error) return products;

    const analysis = {
      stars: [],
      cashCows: [],
      questionMarks: [],
      dogs: []
    };

    for (const product of products.products) {
      const sales = await this._getProductSalesData(product.id, 90);
      const growth = 0;  // Would need historical data
      const marketShare = sales?.revenue || 0;

      if (marketShare > 1000) {
        if (growth > 10) {
          analysis.stars.push(product);
        } else {
          analysis.cashCows.push(product);
        }
      } else {
        if (growth > 10) {
          analysis.questionMarks.push(product);
        } else {
          analysis.dogs.push(product);
        }
      }
    }

    return {
      analysis,
      summary: {
        stars: analysis.stars.length,
        cashCows: analysis.cashCows.length,
        questionMarks: analysis.questionMarks.length,
        dogs: analysis.dogs.length
      },
      recommendations: [
        `Invest in ${analysis.stars.length} star products`,
        `Maintain ${analysis.cashCows.length} cash cows`,
        `Evaluate ${analysis.questionMarks.length} question marks`,
        `Consider discontinuing ${analysis.dogs.length} dogs`
      ]
    };
  }

  // ==================== INVENTORY ====================

  async _getInventoryStatus(params = {}) {
    const { include_forecasts = true } = params;

    const products = await this._getAllProducts({ limit: 500 });
    if (products.error) return products;

    const status = {
      outOfStock: [],
      lowStock: [],
      healthy: [],
      overstocked: []
    };

    for (const product of products.products) {
      if (product.stockOnHand <= 0) {
        status.outOfStock.push(product);
      } else if (product.stockOnHand < this.settings.lowStockThreshold) {
        status.lowStock.push(product);
      } else if (product.stockOnHand > 100) {
        status.overstocked.push(product);
      } else {
        status.healthy.push(product);
      }
    }

    return {
      summary: {
        outOfStock: status.outOfStock.length,
        lowStock: status.lowStock.length,
        healthy: status.healthy.length,
        overstocked: status.overstocked.length
      },
      alerts: [
        ...status.outOfStock.map(p => `OUT OF STOCK: ${p.name}`),
        ...status.lowStock.slice(0, 10).map(p => `Low stock: ${p.name} (${p.stockOnHand} units)`)
      ],
      details: include_forecasts ? status : undefined
    };
  }

  async _getSlowMovingProducts(params = {}) {
    const { days_threshold = 90 } = params;

    const products = await this._getAllProducts({ limit: 200 });
    if (products.error) return products;

    const slowMoving = [];

    for (const product of products.products) {
      if (product.stockOnHand > 0) {
        const sales = await this._getProductSalesData(product.id, days_threshold);
        if (!sales || sales.units < 5) {
          slowMoving.push({
            ...product,
            salesInPeriod: sales?.units || 0,
            stockValue: product.stockOnHand * product.cost
          });
        }
      }
    }

    const totalValue = slowMoving.reduce((sum, p) => sum + p.stockValue, 0);

    return {
      period: `${days_threshold} days`,
      slowMovingProducts: slowMoving,
      count: slowMoving.length,
      totalStockValue: totalValue,
      recommendation: totalValue > 10000 ? 'Consider clearance sales or promotions' : 'Monitor these products'
    };
  }

  async _getStockRecommendations(_params = {}) {
    const inventory = await this._getInventoryStatus({});
    const slowMoving = await this._getSlowMovingProducts({});

    const recommendations = [];

    if (inventory.summary.outOfStock > 0) {
      recommendations.push({
        priority: 'high',
        action: 'Reorder',
        products: inventory.summary.outOfStock,
        reason: 'Products out of stock'
      });
    }

    if (inventory.summary.lowStock > 0) {
      recommendations.push({
        priority: 'medium',
        action: 'Reorder',
        products: inventory.summary.lowStock,
        reason: 'Stock below threshold'
      });
    }

    if (slowMoving.count > 0) {
      recommendations.push({
        priority: 'low',
        action: 'Reduce or promote',
        products: slowMoving.count,
        reason: 'Slow-moving inventory',
        value: slowMoving.totalStockValue
      });
    }

    return { recommendations };
  }

  // ==================== PRICING ====================

  async _analyzePricing(params = {}) {
    const { product_id } = params;

    if (product_id) {
      const details = await this._getProductDetails({ product_id });
      if (details.error) return details;

      return {
        product: details.name,
        pricing: details.pricing,
        recommendation: this._getPricingRecommendation(details.pricing)
      };
    }

    return this._getMarginAnalysis({});
  }

  async _getMarginAnalysis(params = {}) {
    const { threshold = 'all' } = params;

    const products = await this._getAllProducts({ limit: 200 });
    if (products.error) return products;

    const analysis = {
      highMargin: [],
      mediumMargin: [],
      lowMargin: [],
      negative: []
    };

    for (const product of products.products) {
      const marginPct = product.price > 0 ? (product.price - product.cost) / product.price : 0;

      if (marginPct < 0) {
        analysis.negative.push({ ...product, marginPct: (marginPct * 100).toFixed(1) + '%' });
      } else if (marginPct < this.settings.lowMarginThreshold) {
        analysis.lowMargin.push({ ...product, marginPct: (marginPct * 100).toFixed(1) + '%' });
      } else if (marginPct > this.settings.highMarginThreshold) {
        analysis.highMargin.push({ ...product, marginPct: (marginPct * 100).toFixed(1) + '%' });
      } else {
        analysis.mediumMargin.push({ ...product, marginPct: (marginPct * 100).toFixed(1) + '%' });
      }
    }

    const result = { summary: {
      highMargin: analysis.highMargin.length,
      mediumMargin: analysis.mediumMargin.length,
      lowMargin: analysis.lowMargin.length,
      negative: analysis.negative.length
    }};

    if (threshold === 'low' || threshold === 'all') {
      result.lowMarginProducts = analysis.lowMargin.slice(0, 20);
      result.negativeMarginProducts = analysis.negative;
    }
    if (threshold === 'high' || threshold === 'all') {
      result.highMarginProducts = analysis.highMargin.slice(0, 20);
    }

    return result;
  }

  _getPricingRecommendation(pricing) {
    const margin = pricing.listPrice > 0 ? (pricing.listPrice - pricing.cost) / pricing.listPrice : 0;

    if (margin < 0) return 'CRITICAL: Price below cost. Increase price immediately.';
    if (margin < 0.1) return 'Low margin. Consider price increase or cost reduction.';
    if (margin > 0.5) return 'High margin. Price may be optimal or could test lower price for volume.';
    return 'Margin is healthy.';
  }

  async _suggestPriceOptimization(params) {
    const { product_id, goal = 'maximize_margin' } = params;

    const details = await this._getProductDetails({ product_id });
    if (details.error) return details;

    const sales = await this._getProductSalesData(product_id, 30);

    const prompt = `Suggest optimal pricing for this product:

Product: ${details.name}
Current Price: €${details.pricing.listPrice}
Cost: €${details.pricing.cost}
Current Margin: ${details.pricing.margin}
Units Sold (30 days): ${sales?.units || 0}
Revenue (30 days): €${sales?.revenue || 0}

Goal: ${goal}

Provide pricing recommendation with rationale.`;

    const suggestion = await this._generateWithLLM(prompt);

    return {
      product: details.name,
      currentPricing: details.pricing,
      goal,
      suggestion,
      disclaimer: 'This is an AI suggestion. Review market conditions before implementing.'
    };
  }

  // ==================== MARKETPLACE ====================

  async _getMarketplacePerformance(params = {}) {
    const { product_id, marketplace = 'all' } = params;

    const performance = {};

    if ((marketplace === 'all' || marketplace === 'amazon') && this.amazonClient) {
      performance.amazon = { message: 'Amazon integration pending' };
    }

    if ((marketplace === 'all' || marketplace === 'bolcom') && this.bolClient) {
      performance.bolcom = { message: 'Bol.com integration pending' };
    }

    return {
      productId: product_id,
      marketplaces: performance
    };
  }

  async _syncMarketplaceListings(_params = {}) {
    return {
      message: 'Marketplace sync check requires integration with platform APIs',
      status: 'pending_implementation'
    };
  }

  // ==================== PRODUCT DEVELOPMENT ====================

  async _getProductRoadmap(params = {}) {
    const { status = 'all' } = params;

    let items = this.roadmapItems;
    if (status !== 'all') {
      items = items.filter(i => i.status === status);
    }

    return {
      items,
      count: items.length,
      byStatus: {
        planned: this.roadmapItems.filter(i => i.status === 'planned').length,
        in_progress: this.roadmapItems.filter(i => i.status === 'in_progress').length,
        completed: this.roadmapItems.filter(i => i.status === 'completed').length
      }
    };
  }

  async _addRoadmapItem(params) {
    const { title, description, type, priority = 'medium', target_date } = params;

    const item = {
      id: `roadmap_${Date.now()}`,
      title,
      description,
      type,
      priority,
      targetDate: target_date,
      status: 'planned',
      createdAt: new Date().toISOString()
    };

    this.roadmapItems.push(item);

    return {
      success: true,
      item
    };
  }

  async _getProductIdeas(params = {}) {
    const { category } = params;

    const prompt = `Generate 3 product ideas for an e-commerce business${category ? ` in the ${category} category` : ''}:

Consider:
- Market trends
- Customer needs
- Profitability potential

For each idea provide:
1. Product name/concept
2. Target market
3. Estimated margin potential
4. Competition level`;

    const ideas = await this._generateWithLLM(prompt);

    return {
      category: category || 'general',
      ideas,
      generatedAt: new Date().toISOString()
    };
  }

  // ==================== COMPETITOR ANALYSIS ====================

  async _trackCompetitorProduct(params) {
    const { competitor_name, product_name, url, price } = params;

    const key = `${competitor_name}_${product_name}`;
    this.competitorData.set(key, {
      competitor: competitor_name,
      product: product_name,
      url,
      price,
      trackedSince: new Date().toISOString(),
      priceHistory: [{ price, date: new Date().toISOString() }]
    });

    return {
      success: true,
      message: `Now tracking ${product_name} from ${competitor_name}`
    };
  }

  async _getCompetitorAnalysis(params = {}) {
    const { product_id } = params;

    const trackedProducts = Array.from(this.competitorData.values());

    return {
      yourProduct: product_id ? await this._getProductDetails({ product_id }) : null,
      competitorProducts: trackedProducts,
      count: trackedProducts.length
    };
  }

  // ==================== REPORTS ====================

  async _generateProductReport(params = {}) {
    const { report_type = 'overview' } = params;

    const report = {
      generatedAt: new Date().toISOString(),
      type: report_type
    };

    if (report_type === 'overview' || report_type === 'all') {
      const products = await this._getAllProducts({});
      report.catalog = {
        totalProducts: products.count,
        activeProducts: products.products.filter(p => p.active).length
      };
    }

    if (report_type === 'performance' || report_type === 'all') {
      const top = await this._getTopPerformers({ limit: 10 });
      const under = await this._getUnderperformers({});
      report.performance = {
        topPerformers: top.topProducts?.slice(0, 5),
        underperformers: under.count
      };
    }

    if (report_type === 'inventory' || report_type === 'all') {
      const inventory = await this._getInventoryStatus({});
      report.inventory = inventory.summary;
    }

    return report;
  }

  // ==================== HELPERS ====================

  async _generateWithLLM(prompt) {
    try {
      const response = await this.llmClient.chat.completions.create({
        model: this.config.model || 'gpt-4',
        messages: [{ role: 'user', content: prompt }]
      });
      return response.choices[0].message.content;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  }

  // ==================== LIFECYCLE ====================

  async init() {
    await super.init();
    console.log('Product Development Agent initialized');
  }

  setOdooClient(client) { this.odooClient = client; }
  setAmazonClient(client) { this.amazonClient = client; }
  setBolClient(client) { this.bolClient = client; }
}

module.exports = {
  ProductDevelopmentAgent,
  ProductStage,
  ProductCategory
};
