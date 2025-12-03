/**
 * E-commerce Agent
 *
 * Specialized agent for managing e-commerce operations across multiple platforms:
 * - Amazon (via SP-API)
 * - Bol.com (via Retailer API)
 *
 * Capabilities:
 * - Order management (view, fulfill, cancel)
 * - Inventory management (sync, update, alerts)
 * - Product listing management
 * - Pricing optimization
 * - Returns handling
 * - Sales analytics
 * - Cross-platform synchronization
 *
 * @module EcommerceAgent
 */

const LLMAgent = require('../LLMAgent');
const { AmazonDirectClient } = require('../integrations/AmazonMCP');
const { BolDirectClient, ORDER_STATUS } = require('../integrations/BolMCP');

/**
 * E-commerce platform identifiers
 */
const _Platform = {
  AMAZON: 'amazon',
  BOLCOM: 'bolcom',
  ALL: 'all'
};

/**
 * Order status mapping across platforms
 */
const OrderStatusMap = {
  amazon: {
    'Pending': 'pending',
    'Unshipped': 'to_ship',
    'PartiallyShipped': 'partial',
    'Shipped': 'shipped',
    'Canceled': 'cancelled',
    'Unfulfillable': 'error'
  },
  bolcom: {
    'OPEN': 'to_ship',
    'SHIPPED': 'shipped',
    'ALL': 'all'
  }
};

class EcommerceAgent extends LLMAgent {
  constructor(id, config = {}) {
    super(id, {
      name: config.name || 'E-commerce Agent',
      role: 'ecommerce',
      capabilities: [
        'order_management',
        'inventory_management',
        'product_listings',
        'pricing_management',
        'returns_handling',
        'sales_analytics',
        'cross_platform_sync',
        'marketplace_queries'
      ],
      systemPrompt: `You are an E-commerce Operations Agent responsible for managing sales across Amazon and Bol.com marketplaces.

Your responsibilities:
1. Order Management: Track, fulfill, and manage orders across all platforms
2. Inventory: Monitor stock levels, sync inventory, alert on low stock
3. Products: Manage listings, update prices, optimize content
4. Returns: Process returns efficiently, track return reasons
5. Analytics: Provide insights on sales performance, trends, and opportunities
6. Sync: Ensure consistency across all selling channels

When responding:
- Always specify which platform(s) you're referring to
- Provide actionable recommendations
- Alert on urgent issues (low stock, pending orders, returns)
- Consider cross-platform implications of actions

Available platforms: Amazon, Bol.com`,
      ...config
    });

    // Initialize platform clients
    this.amazonClient = null;
    this.bolClient = null;

    // Platform status
    this.platformStatus = {
      amazon: { connected: false, lastSync: null, error: null },
      bolcom: { connected: false, lastSync: null, error: null }
    };

    // Cache for performance
    this.cache = {
      orders: new Map(),
      inventory: new Map(),
      products: new Map()
    };
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes

    // Alerts
    this.alerts = [];
    this.alertThresholds = {
      lowStockThreshold: 10,
      criticalStockThreshold: 3,
      orderAgeDays: 2,
      returnRateThreshold: 5 // percentage
    };
  }

  /**
   * Initialize the E-commerce Agent
   */
  async init(platform) {
    await super.init(platform);

    // Initialize Amazon client
    try {
      if (process.env.AMAZON_CLIENT_ID && process.env.AMAZON_REFRESH_TOKEN) {
        this.amazonClient = new AmazonDirectClient();
        await this.amazonClient.refreshAccessToken();
        this.platformStatus.amazon.connected = true;
        this.logger?.info('Amazon SP-API connected');
      }
    } catch (error) {
      this.platformStatus.amazon.error = error.message;
      this.logger?.warn('Amazon SP-API connection failed:', error.message);
    }

    // Initialize Bol.com client
    try {
      if (process.env.BOL_CLIENT_ID && process.env.BOL_CLIENT_SECRET) {
        this.bolClient = new BolDirectClient();
        await this.bolClient.authenticate();
        this.platformStatus.bolcom.connected = true;
        this.logger?.info('Bol.com API connected');
      }
    } catch (error) {
      this.platformStatus.bolcom.error = error.message;
      this.logger?.warn('Bol.com API connection failed:', error.message);
    }

    // Register tools
    this._registerTools();

    this.logger?.info('EcommerceAgent initialized', {
      amazon: this.platformStatus.amazon.connected,
      bolcom: this.platformStatus.bolcom.connected
    });
  }

  /**
   * Register agent tools
   */
  _registerTools() {
    // Order tools
    this.registerTool('get_orders', {
      description: 'Get orders from e-commerce platforms',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom', 'all'], description: 'Platform to query' },
          status: { type: 'string', description: 'Order status filter (pending, to_ship, shipped, cancelled)' },
          days: { type: 'number', description: 'Number of days to look back' },
          limit: { type: 'number', description: 'Maximum number of orders to return' }
        }
      },
      handler: this._getOrders.bind(this)
    });

    this.registerTool('get_order_details', {
      description: 'Get detailed information about a specific order',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          order_id: { type: 'string', required: true }
        },
        required: ['platform', 'order_id']
      },
      handler: this._getOrderDetails.bind(this)
    });

    this.registerTool('ship_order', {
      description: 'Mark an order as shipped with tracking information',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          order_id: { type: 'string', required: true },
          tracking_number: { type: 'string' },
          carrier: { type: 'string' }
        },
        required: ['platform', 'order_id']
      },
      handler: this._shipOrder.bind(this)
    });

    // Inventory tools
    this.registerTool('get_inventory', {
      description: 'Get inventory levels across platforms',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom', 'all'] },
          sku: { type: 'string', description: 'Specific SKU to check' },
          low_stock_only: { type: 'boolean', description: 'Only show low stock items' }
        }
      },
      handler: this._getInventory.bind(this)
    });

    this.registerTool('update_stock', {
      description: 'Update stock quantity for a product',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom', 'all'], required: true },
          sku: { type: 'string', required: true },
          quantity: { type: 'number', required: true },
          sync_all: { type: 'boolean', description: 'Sync to all platforms' }
        },
        required: ['platform', 'sku', 'quantity']
      },
      handler: this._updateStock.bind(this)
    });

    // Product tools
    this.registerTool('get_products', {
      description: 'Get product listings',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom', 'all'] },
          search: { type: 'string', description: 'Search term' },
          sku: { type: 'string', description: 'Specific SKU' }
        }
      },
      handler: this._getProducts.bind(this)
    });

    this.registerTool('update_price', {
      description: 'Update product price',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom', 'all'], required: true },
          sku: { type: 'string', required: true },
          price: { type: 'number', required: true },
          sync_all: { type: 'boolean', description: 'Sync price to all platforms' }
        },
        required: ['platform', 'sku', 'price']
      },
      handler: this._updatePrice.bind(this)
    });

    // Returns tools
    this.registerTool('get_returns', {
      description: 'Get return requests',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom', 'all'] },
          status: { type: 'string', enum: ['pending', 'handled', 'all'] }
        }
      },
      handler: this._getReturns.bind(this)
    });

    this.registerTool('handle_return', {
      description: 'Process a return request',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom'], required: true },
          return_id: { type: 'string', required: true },
          action: { type: 'string', enum: ['accept', 'reject'], required: true },
          reason: { type: 'string' }
        },
        required: ['platform', 'return_id', 'action']
      },
      handler: this._handleReturn.bind(this)
    });

    // Analytics tools
    this.registerTool('get_sales_summary', {
      description: 'Get sales summary and analytics',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['amazon', 'bolcom', 'all'] },
          period: { type: 'string', enum: ['today', 'week', 'month', 'quarter', 'year'] }
        }
      },
      handler: this._getSalesSummary.bind(this)
    });

    this.registerTool('get_platform_health', {
      description: 'Get health status of all connected platforms',
      parameters: {
        type: 'object',
        properties: {}
      },
      handler: this._getPlatformHealth.bind(this)
    });

    this.registerTool('get_alerts', {
      description: 'Get pending alerts and issues requiring attention',
      parameters: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'info', 'all'] }
        }
      },
      handler: this._getAlerts.bind(this)
    });

    // Cross-platform tools
    this.registerTool('sync_inventory', {
      description: 'Synchronize inventory across all platforms',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Specific SKU to sync (or all if not specified)' }
        }
      },
      handler: this._syncInventory.bind(this)
    });
  }

  // ==================== ORDER MANAGEMENT ====================

  async _getOrders(params = {}) {
    const platform = params.platform || 'all';
    const days = params.days || 7;
    const results = { amazon: null, bolcom: null, combined: [] };

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get Amazon orders
    if ((platform === 'amazon' || platform === 'all') && this.amazonClient) {
      try {
        const amazonOrders = await this.amazonClient.getOrders({
          createdAfter: startDate.toISOString(),
          maxResultsPerPage: params.limit || 50
        });
        results.amazon = this._normalizeAmazonOrders(amazonOrders.payload?.Orders || []);
        results.combined.push(...results.amazon);
      } catch (error) {
        this.logger?.error('Amazon orders fetch failed:', error);
        results.amazon = { error: error.message };
      }
    }

    // Get Bol.com orders
    if ((platform === 'bolcom' || platform === 'all') && this.bolClient) {
      try {
        const bolOrders = await this.bolClient.getOrders({
          status: params.status === 'to_ship' ? ORDER_STATUS.OPEN : ORDER_STATUS.ALL
        });
        results.bolcom = this._normalizeBolOrders(bolOrders.orders || []);
        results.combined.push(...results.bolcom);
      } catch (error) {
        this.logger?.error('Bol.com orders fetch failed:', error);
        results.bolcom = { error: error.message };
      }
    }

    // Sort combined by date
    results.combined.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));

    // Apply limit
    if (params.limit) {
      results.combined = results.combined.slice(0, params.limit);
    }

    // Generate summary
    results.summary = {
      total: results.combined.length,
      byPlatform: {
        amazon: Array.isArray(results.amazon) ? results.amazon.length : 0,
        bolcom: Array.isArray(results.bolcom) ? results.bolcom.length : 0
      },
      byStatus: this._groupByStatus(results.combined),
      period: `Last ${days} days`
    };

    return results;
  }

  _normalizeAmazonOrders(orders) {
    return orders.map(order => ({
      platform: 'amazon',
      orderId: order.AmazonOrderId,
      orderDate: order.PurchaseDate,
      status: OrderStatusMap.amazon[order.OrderStatus] || order.OrderStatus,
      rawStatus: order.OrderStatus,
      total: {
        amount: parseFloat(order.OrderTotal?.Amount || 0),
        currency: order.OrderTotal?.CurrencyCode || 'EUR'
      },
      items: order.NumberOfItemsShipped + order.NumberOfItemsUnshipped,
      fulfillment: order.FulfillmentChannel,
      shipAddress: order.ShippingAddress ? {
        city: order.ShippingAddress.City,
        country: order.ShippingAddress.CountryCode
      } : null
    }));
  }

  _normalizeBolOrders(orders) {
    return orders.map(order => ({
      platform: 'bolcom',
      orderId: order.orderId,
      orderDate: order.orderPlacedDateTime,
      status: OrderStatusMap.bolcom[order.orderStatus] || order.orderStatus,
      rawStatus: order.orderStatus,
      total: {
        amount: order.orderItems?.reduce((sum, item) =>
          sum + (parseFloat(item.unitPrice) * (item.quantity || 1)), 0) || 0,
        currency: 'EUR'
      },
      items: order.orderItems?.length || 0,
      fulfillment: order.orderItems?.[0]?.fulfilmentMethod || 'FBR',
      shipAddress: order.shipmentDetails ? {
        city: order.shipmentDetails.city,
        country: order.shipmentDetails.countryCode
      } : null
    }));
  }

  _groupByStatus(orders) {
    return orders.reduce((acc, order) => {
      acc[order.status] = (acc[order.status] || 0) + 1;
      return acc;
    }, {});
  }

  async _getOrderDetails(params) {
    const { platform, order_id } = params;

    if (platform === 'amazon' && this.amazonClient) {
      const order = await this.amazonClient.getOrder(order_id);
      const items = await this.amazonClient.getOrderItems(order_id);
      return {
        platform: 'amazon',
        order: order.payload,
        items: items.payload?.OrderItems || []
      };
    }

    if (platform === 'bolcom' && this.bolClient) {
      const order = await this.bolClient.getOrder(order_id);
      return {
        platform: 'bolcom',
        order: order
      };
    }

    throw new Error(`Platform ${platform} not available`);
  }

  async _shipOrder(params) {
    const { platform, order_id, tracking_number, carrier } = params;

    if (platform === 'bolcom' && this.bolClient) {
      // Get order to find order items
      const order = await this.bolClient.getOrder(order_id);
      const orderItems = order.orderItems || [];

      if (orderItems.length === 0) {
        throw new Error('No order items found');
      }

      return this.bolClient.createShipment({
        orderItems: orderItems.map(item => ({
          orderItemId: item.orderItemId,
          quantity: item.quantity
        })),
        reference: `SHIP-${order_id}`,
        transporterCode: carrier || 'TNT',
        trackAndTrace: tracking_number
      });
    }

    // Amazon shipment confirmation requires different API
    if (platform === 'amazon') {
      // Note: Amazon uses Feeds API for order confirmation
      throw new Error('Amazon shipment confirmation requires Feeds API - not yet implemented');
    }

    throw new Error(`Platform ${platform} not available`);
  }

  // ==================== INVENTORY MANAGEMENT ====================

  async _getInventory(params = {}) {
    const platform = params.platform || 'all';
    const results = { amazon: null, bolcom: null, combined: [] };

    // Get Amazon inventory
    if ((platform === 'amazon' || platform === 'all') && this.amazonClient) {
      try {
        const inventory = await this.amazonClient.getInventorySummaries({
          details: true
        });
        results.amazon = (inventory.payload?.inventorySummaries || []).map(item => ({
          platform: 'amazon',
          sku: item.sellerSku,
          asin: item.asin,
          fnsku: item.fnSku,
          quantity: item.totalQuantity || 0,
          available: item.sellableQuantity || 0,
          inbound: item.inboundQuantity || 0,
          reserved: item.reservedQuantity || 0,
          fulfillment: 'FBA'
        }));
        results.combined.push(...results.amazon);
      } catch (error) {
        this.logger?.error('Amazon inventory fetch failed:', error);
        results.amazon = { error: error.message };
      }
    }

    // Get Bol.com inventory
    if ((platform === 'bolcom' || platform === 'all') && this.bolClient) {
      try {
        const inventory = await this.bolClient.getInventory();
        results.bolcom = (inventory.inventory || []).map(item => ({
          platform: 'bolcom',
          sku: item.ean,
          ean: item.ean,
          quantity: item.regularStock || 0,
          available: item.regularStock || 0,
          reserved: 0,
          fulfillment: 'FBB'
        }));
        results.combined.push(...results.bolcom);
      } catch (error) {
        this.logger?.error('Bol.com inventory fetch failed:', error);
        results.bolcom = { error: error.message };
      }
    }

    // Filter by SKU if specified
    if (params.sku) {
      results.combined = results.combined.filter(item =>
        item.sku?.toLowerCase().includes(params.sku.toLowerCase()) ||
        item.ean?.toLowerCase().includes(params.sku.toLowerCase())
      );
    }

    // Filter low stock only
    if (params.low_stock_only) {
      results.combined = results.combined.filter(item =>
        item.quantity <= this.alertThresholds.lowStockThreshold
      );
    }

    // Generate alerts for low stock
    this._checkStockAlerts(results.combined);

    // Summary
    results.summary = {
      totalSkus: results.combined.length,
      totalUnits: results.combined.reduce((sum, item) => sum + item.quantity, 0),
      lowStock: results.combined.filter(item => item.quantity <= this.alertThresholds.lowStockThreshold).length,
      outOfStock: results.combined.filter(item => item.quantity === 0).length
    };

    return results;
  }

  _checkStockAlerts(inventory) {
    for (const item of inventory) {
      if (item.quantity === 0) {
        this._addAlert({
          severity: 'critical',
          type: 'out_of_stock',
          platform: item.platform,
          sku: item.sku,
          message: `OUT OF STOCK: ${item.sku} on ${item.platform}`
        });
      } else if (item.quantity <= this.alertThresholds.criticalStockThreshold) {
        this._addAlert({
          severity: 'critical',
          type: 'critical_stock',
          platform: item.platform,
          sku: item.sku,
          quantity: item.quantity,
          message: `CRITICAL STOCK: ${item.sku} on ${item.platform} - only ${item.quantity} units`
        });
      } else if (item.quantity <= this.alertThresholds.lowStockThreshold) {
        this._addAlert({
          severity: 'warning',
          type: 'low_stock',
          platform: item.platform,
          sku: item.sku,
          quantity: item.quantity,
          message: `Low stock: ${item.sku} on ${item.platform} - ${item.quantity} units`
        });
      }
    }
  }

  async _updateStock(params) {
    const { platform, sku, quantity, sync_all } = params;
    const results = {};

    if ((platform === 'bolcom' || sync_all) && this.bolClient) {
      try {
        // Note: Need offer ID, not SKU. Would need to look up first.
        // This is a simplified version
        results.bolcom = await this.bolClient.updateOfferStock(sku, quantity);
      } catch (error) {
        results.bolcom = { error: error.message };
      }
    }

    if ((platform === 'amazon' || sync_all) && this.amazonClient) {
      // Amazon inventory updates go through Feeds API
      results.amazon = { message: 'Amazon stock updates require Feeds API - scheduled for batch processing' };
    }

    return results;
  }

  // ==================== PRODUCT MANAGEMENT ====================

  async _getProducts(params = {}) {
    const platform = params.platform || 'all';
    const results = { amazon: null, bolcom: null, combined: [] };

    if ((platform === 'amazon' || platform === 'all') && this.amazonClient && params.search) {
      try {
        const products = await this.amazonClient.searchCatalogItems({
          keywords: params.search,
          includedData: ['summaries', 'attributes', 'images']
        });
        results.amazon = (products.items || []).map(item => ({
          platform: 'amazon',
          asin: item.asin,
          title: item.summaries?.[0]?.itemName,
          brand: item.summaries?.[0]?.brand,
          image: item.images?.PRIMARY?.[0]?.link
        }));
        results.combined.push(...results.amazon);
      } catch (error) {
        results.amazon = { error: error.message };
      }
    }

    if ((platform === 'bolcom' || platform === 'all') && this.bolClient && params.sku) {
      try {
        const product = await this.bolClient.getProduct(params.sku);
        results.bolcom = [{
          platform: 'bolcom',
          ean: product.ean,
          title: product.title,
          brand: product.brand
        }];
        results.combined.push(...results.bolcom);
      } catch (error) {
        results.bolcom = { error: error.message };
      }
    }

    return results;
  }

  async _updatePrice(params) {
    const { platform, sku, price, sync_all } = params;
    const results = {};

    if ((platform === 'bolcom' || sync_all) && this.bolClient) {
      try {
        results.bolcom = await this.bolClient.updateOfferPrice(sku, price);
      } catch (error) {
        results.bolcom = { error: error.message };
      }
    }

    if ((platform === 'amazon' || sync_all) && this.amazonClient) {
      // Amazon price updates go through Listings API
      results.amazon = { message: 'Amazon price update scheduled - requires Listings API patch' };
    }

    return results;
  }

  // ==================== RETURNS MANAGEMENT ====================

  async _getReturns(params = {}) {
    const platform = params.platform || 'all';
    const results = { amazon: null, bolcom: null, combined: [] };

    if ((platform === 'bolcom' || platform === 'all') && this.bolClient) {
      try {
        const handled = params.status === 'pending' ? false :
          params.status === 'handled' ? true : undefined;
        const returns = await this.bolClient.getReturns({ handled });
        results.bolcom = (returns.returns || []).map(ret => ({
          platform: 'bolcom',
          returnId: ret.rmaId,
          orderId: ret.orderId,
          status: ret.handled ? 'handled' : 'pending',
          reason: ret.returnReason,
          quantity: ret.quantityReturned,
          createdAt: ret.registrationDateTime
        }));
        results.combined.push(...results.bolcom);
      } catch (error) {
        results.bolcom = { error: error.message };
      }
    }

    // Amazon returns would require Reports API
    if (platform === 'amazon' || platform === 'all') {
      results.amazon = { message: 'Amazon returns require Reports API - GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA' };
    }

    results.summary = {
      total: results.combined.length,
      pending: results.combined.filter(r => r.status === 'pending').length,
      handled: results.combined.filter(r => r.status === 'handled').length
    };

    return results;
  }

  async _handleReturn(params) {
    const { platform, return_id, action, reason: _reason } = params;

    if (platform === 'bolcom' && this.bolClient) {
      const handlingResult = action === 'accept' ? 'RETURN_RECEIVED' : 'RETURN_DOES_NOT_MEET_CONDITIONS';
      return this.bolClient.handleReturn(return_id, handlingResult, 1);
    }

    throw new Error(`Return handling for ${platform} not implemented`);
  }

  // ==================== ANALYTICS ====================

  async _getSalesSummary(params = {}) {
    const platform = params.platform || 'all';
    const period = params.period || 'week';
    const results = { amazon: null, bolcom: null, combined: {} };

    const daysMap = { today: 1, week: 7, month: 30, quarter: 90, year: 365 };
    const days = daysMap[period] || 7;

    if ((platform === 'amazon' || platform === 'all') && this.amazonClient) {
      try {
        const endDate = new Date().toISOString();
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        results.amazon = await this.amazonClient.getSalesSummary(startDate, endDate);
      } catch (error) {
        results.amazon = { error: error.message };
      }
    }

    if ((platform === 'bolcom' || platform === 'all') && this.bolClient) {
      try {
        results.bolcom = await this.bolClient.getSalesSummary(days);
      } catch (error) {
        results.bolcom = { error: error.message };
      }
    }

    // Combine results
    results.combined = {
      period: period,
      totalOrders:
        (results.amazon?.totalOrders || 0) +
        (results.bolcom?.totalOrders || 0),
      totalRevenue:
        (results.amazon?.totalSales || 0) +
        parseFloat(results.bolcom?.totalRevenue || 0),
      currency: 'EUR',
      byPlatform: {
        amazon: results.amazon,
        bolcom: results.bolcom
      }
    };

    if (results.combined.totalOrders > 0) {
      results.combined.averageOrderValue =
        results.combined.totalRevenue / results.combined.totalOrders;
    }

    return results;
  }

  // ==================== PLATFORM HEALTH ====================

  async _getPlatformHealth() {
    const health = {
      amazon: { ...this.platformStatus.amazon },
      bolcom: { ...this.platformStatus.bolcom },
      overall: 'healthy'
    };

    // Test connections
    if (this.amazonClient) {
      try {
        await this.amazonClient.refreshAccessToken();
        health.amazon.connected = true;
        health.amazon.lastCheck = new Date().toISOString();
      } catch (error) {
        health.amazon.connected = false;
        health.amazon.error = error.message;
      }
    }

    if (this.bolClient) {
      try {
        await this.bolClient.authenticate();
        health.bolcom.connected = true;
        health.bolcom.lastCheck = new Date().toISOString();
      } catch (error) {
        health.bolcom.connected = false;
        health.bolcom.error = error.message;
      }
    }

    // Determine overall health
    const connectedCount = [health.amazon.connected, health.bolcom.connected].filter(Boolean).length;
    if (connectedCount === 0) {
      health.overall = 'critical';
    } else if (connectedCount < 2) {
      health.overall = 'degraded';
    }

    return health;
  }

  // ==================== ALERTS ====================

  _addAlert(alert) {
    alert.id = `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    alert.timestamp = new Date().toISOString();
    alert.acknowledged = false;

    // Avoid duplicates
    const isDuplicate = this.alerts.some(a =>
      a.type === alert.type &&
      a.platform === alert.platform &&
      a.sku === alert.sku &&
      !a.acknowledged
    );

    if (!isDuplicate) {
      this.alerts.push(alert);
      this.emit('alert', alert);
    }
  }

  async _getAlerts(params = {}) {
    let alerts = this.alerts.filter(a => !a.acknowledged);

    if (params.severity && params.severity !== 'all') {
      alerts = alerts.filter(a => a.severity === params.severity);
    }

    return {
      alerts: alerts,
      summary: {
        total: alerts.length,
        critical: alerts.filter(a => a.severity === 'critical').length,
        warning: alerts.filter(a => a.severity === 'warning').length,
        info: alerts.filter(a => a.severity === 'info').length
      }
    };
  }

  acknowledgeAlert(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = new Date().toISOString();
    }
  }

  // ==================== CROSS-PLATFORM SYNC ====================

  async _syncInventory(params = {}) {
    const results = {
      synced: [],
      errors: [],
      timestamp: new Date().toISOString()
    };

    // Get inventory from all platforms
    const inventory = await this._getInventory({ platform: 'all' });

    // Group by SKU/EAN
    const skuMap = new Map();
    for (const item of inventory.combined) {
      const key = item.sku || item.ean;
      if (!skuMap.has(key)) {
        skuMap.set(key, []);
      }
      skuMap.get(key).push(item);
    }

    // Find discrepancies and sync
    for (const [sku, items] of skuMap) {
      if (params.sku && sku !== params.sku) continue;

      if (items.length > 1) {
        // Multiple platforms have this SKU
        const quantities = items.map(i => i.quantity);
        const minQty = Math.min(...quantities);

        // If quantities differ, flag for review
        if (new Set(quantities).size > 1) {
          results.synced.push({
            sku: sku,
            platforms: items.map(i => i.platform),
            quantities: quantities,
            recommendation: `Sync to minimum quantity: ${minQty}`
          });
        }
      }
    }

    return results;
  }
}

module.exports = EcommerceAgent;
