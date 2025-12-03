/**
 * Bol.com Retailer API MCP Integration
 *
 * Direct API client for Bol.com Retailer API V10.
 *
 * Note: The community package 'bol-retailer-api' exists but is marked as
 * "NOT ready for production usage" by its authors. This implementation
 * uses direct HTTPS calls to the official Bol.com API.
 *
 * When a production-ready SDK becomes available, consider migrating to it.
 *
 * API Documentation: https://api.bol.com/retailer/public/Retailer-API/index.html
 *
 * @module BolMCP
 */

const https = require('https');

/**
 * Bol.com API Endpoints
 */
const BOL_ENDPOINTS = {
  auth: 'login.bol.com',
  api: 'api.bol.com'
};

/**
 * Order Status Types
 */
const ORDER_STATUS = {
  OPEN: 'OPEN',
  SHIPPED: 'SHIPPED',
  ALL: 'ALL'
};

/**
 * Fulfilment Methods
 */
const FULFILMENT_METHOD = {
  FBR: 'FBR', // Fulfilled by Retailer
  FBB: 'FBB', // Fulfilled by Bol.com (LVB)
  ALL: 'ALL'
};

/**
 * Bol.com MCP Server Configuration
 */
function getBolMCPConfig() {
  return {
    name: 'bolcom',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-bolcom'],
    env: {
      BOL_CLIENT_ID: process.env.BOL_CLIENT_ID,
      BOL_CLIENT_SECRET: process.env.BOL_CLIENT_SECRET
    }
  };
}

/**
 * Bol.com Retailer API Client
 *
 * Uses OAuth 2.0 client credentials flow.
 * Automatically handles token refresh.
 */
class BolClient {
  constructor(config = {}) {
    this.clientId = config.clientId || process.env.BOL_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.BOL_CLIENT_SECRET;

    this.accessToken = null;
    this.tokenExpiry = null;

    // Validate credentials
    if (!this.clientId || !this.clientSecret) {
      console.warn('Bol.com credentials not configured. Set BOL_CLIENT_ID and BOL_CLIENT_SECRET.');
    }
  }

  /**
   * Authenticate and get access token
   */
  async authenticate() {
    // Return cached token if still valid
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: BOL_ENDPOINTS.auth,
        port: 443,
        path: '/token?grant_type=client_credentials',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.access_token) {
              this.accessToken = response.access_token;
              this.tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;
              resolve(this.accessToken);
            } else {
              reject(new Error(`Bol.com auth failed: ${data}`));
            }
          } catch (e) {
            reject(new Error(`Bol.com auth parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Make authenticated API request
   */
  async request(method, path, body = null, apiVersion = 'v10') {
    await this.authenticate();

    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Accept': `application/vnd.retailer.${apiVersion}+json`,
      'Content-Type': `application/vnd.retailer.${apiVersion}+json`
    };

    const payload = body ? JSON.stringify(body) : '';

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: BOL_ENDPOINTS.api,
        port: 443,
        path: `/retailer${path}`,
        method: method,
        headers: headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (!data || data.trim() === '') {
              resolve({ success: true, statusCode: res.statusCode });
              return;
            }

            const response = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              reject(new Error(`Bol.com API Error ${res.statusCode}: ${JSON.stringify(response)}`));
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ raw: data, statusCode: res.statusCode });
            } else {
              reject(new Error(`Bol.com Parse error: ${e.message}, Data: ${data}`));
            }
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ==================== ORDERS ====================

  /**
   * Get orders
   */
  async getOrders(params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1,
      ...(params.fulfilmentMethod && { 'fulfilment-method': params.fulfilmentMethod }),
      ...(params.status && { status: params.status })
    });
    return this.request('GET', `/orders?${query}`);
  }

  /**
   * Get single order
   */
  async getOrder(orderId) {
    return this.request('GET', `/orders/${orderId}`);
  }

  /**
   * Cancel order item
   */
  async cancelOrderItem(orderItemId, reasonCode = 'OUT_OF_STOCK') {
    return this.request('PUT', '/orders/cancellation', {
      orderItems: [{ orderItemId, reasonCode }]
    });
  }

  // ==================== SHIPMENTS ====================

  /**
   * Get shipments
   */
  async getShipments(params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1,
      ...(params.fulfilmentMethod && { 'fulfilment-method': params.fulfilmentMethod }),
      ...(params.orderId && { 'order-id': params.orderId })
    });
    return this.request('GET', `/shipments?${query}`);
  }

  /**
   * Get single shipment
   */
  async getShipment(shipmentId) {
    return this.request('GET', `/shipments/${shipmentId}`);
  }

  /**
   * Create shipment
   */
  async createShipment(data) {
    return this.request('POST', '/shipments', {
      orderItems: data.orderItems.map(item => ({
        orderItemId: item.orderItemId,
        quantity: item.quantity || 1
      })),
      shipmentReference: data.reference,
      transport: {
        transporterCode: data.transporterCode,
        trackAndTrace: data.trackAndTrace
      }
    });
  }

  // ==================== OFFERS ====================

  /**
   * Get offer by ID
   */
  async getOffer(offerId) {
    return this.request('GET', `/offers/${offerId}`);
  }

  /**
   * Create offer
   */
  async createOffer(data) {
    return this.request('POST', '/offers', {
      ean: data.ean,
      condition: {
        name: data.condition || 'NEW',
        category: data.conditionCategory || 'NEW'
      },
      pricing: {
        bundlePrices: [{ quantity: 1, unitPrice: data.price }]
      },
      stock: {
        amount: data.stock,
        managedByRetailer: true
      },
      fulfilment: {
        method: data.fulfilmentMethod || 'FBR',
        deliveryCode: data.deliveryCode || '1-2d'
      }
    });
  }

  /**
   * Update offer price
   */
  async updateOfferPrice(offerId, price) {
    return this.request('PUT', `/offers/${offerId}/price`, {
      pricing: {
        bundlePrices: [{ quantity: 1, unitPrice: price }]
      }
    });
  }

  /**
   * Update offer stock
   */
  async updateOfferStock(offerId, amount) {
    return this.request('PUT', `/offers/${offerId}/stock`, {
      amount: amount,
      managedByRetailer: true
    });
  }

  /**
   * Delete offer
   */
  async deleteOffer(offerId) {
    return this.request('DELETE', `/offers/${offerId}`);
  }

  // ==================== INVENTORY (FBB/LVB) ====================

  /**
   * Get LVB/FBB inventory
   */
  async getInventory(params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1,
      ...(params.quantity && { quantity: params.quantity }),
      ...(params.stock && { stock: params.stock }),
      ...(params.state && { state: params.state }),
      ...(params.query && { query: params.query })
    });
    return this.request('GET', `/inventory?${query}`);
  }

  // ==================== RETURNS ====================

  /**
   * Get returns
   */
  async getReturns(params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1,
      ...(params.handled !== undefined && { handled: params.handled }),
      ...(params.fulfilmentMethod && { 'fulfilment-method': params.fulfilmentMethod })
    });
    return this.request('GET', `/returns?${query}`);
  }

  /**
   * Get single return
   */
  async getReturn(returnId) {
    return this.request('GET', `/returns/${returnId}`);
  }

  /**
   * Handle return
   */
  async handleReturn(rmaId, handlingResult, quantityReturned) {
    return this.request('PUT', `/returns/${rmaId}`, {
      handlingResult,
      quantityReturned
    });
  }

  // ==================== PRODUCTS ====================

  /**
   * Get product by EAN
   */
  async getProduct(ean) {
    return this.request('GET', `/products/${ean}`);
  }

  /**
   * Get product assets
   */
  async getProductAssets(ean) {
    return this.request('GET', `/products/${ean}/assets`);
  }

  // ==================== INSIGHTS ====================

  /**
   * Get performance indicators
   */
  async getPerformanceIndicators(params = {}) {
    const query = new URLSearchParams({
      ...(params.name && { name: params.name.join(',') }),
      ...(params.year && { year: params.year }),
      ...(params.week && { week: params.week })
    });
    return this.request('GET', `/insights/performance/indicator?${query}`);
  }

  /**
   * Get sales forecast
   */
  async getSalesForecast(offerId, weeksAhead = 12) {
    return this.request('GET', `/insights/sales-forecast?offer-id=${offerId}&weeks-ahead=${weeksAhead}`);
  }

  // ==================== COMMISSIONS ====================

  /**
   * Get commission for EAN
   */
  async getCommission(ean, condition = 'NEW', price) {
    const query = new URLSearchParams({
      ean,
      condition,
      'unit-price': price
    });
    return this.request('GET', `/commission?${query}`);
  }

  /**
   * Get commissions (bulk)
   */
  async getCommissions(products) {
    return this.request('POST', '/commission', {
      commissionQueries: products.map(p => ({
        ean: p.ean,
        condition: p.condition || 'NEW',
        unitPrice: p.price
      }))
    });
  }

  // ==================== SUBSCRIPTIONS (Webhooks) ====================

  /**
   * Get subscriptions
   */
  async getSubscriptions() {
    return this.request('GET', '/subscriptions');
  }

  /**
   * Create subscription
   */
  async createSubscription(resourceType, url) {
    return this.request('POST', '/subscriptions', {
      resources: [resourceType],
      url
    });
  }

  /**
   * Delete subscription
   */
  async deleteSubscription(subscriptionId) {
    return this.request('DELETE', `/subscriptions/${subscriptionId}`);
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Get sales summary
   */
  async getSalesSummary(daysBack = 30) {
    let allOrders = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 10) {
      const response = await this.getOrders({ page, status: ORDER_STATUS.ALL });
      const orders = response.orders || [];
      allOrders = allOrders.concat(orders);
      hasMore = orders.length > 0;
      page++;
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    let totalRevenue = 0;
    let orderCount = 0;
    let itemCount = 0;

    for (const order of allOrders) {
      const orderDate = new Date(order.orderPlacedDateTime);
      if (orderDate >= startDate) {
        orderCount++;
        for (const item of (order.orderItems || [])) {
          totalRevenue += parseFloat(item.unitPrice || 0) * (item.quantity || 1);
          itemCount += item.quantity || 1;
        }
      }
    }

    return {
      period: `Last ${daysBack} days`,
      startDate: startDate.toISOString(),
      endDate: new Date().toISOString(),
      totalOrders: orderCount,
      totalItems: itemCount,
      totalRevenue: totalRevenue.toFixed(2),
      currency: 'EUR',
      averageOrderValue: orderCount > 0 ? (totalRevenue / orderCount).toFixed(2) : '0.00'
    };
  }

  /**
   * Get pending actions
   */
  async getPendingActions() {
    const [openOrders, unresolvedReturns] = await Promise.all([
      this.getOrders({ status: ORDER_STATUS.OPEN, fulfilmentMethod: FULFILMENT_METHOD.FBR }),
      this.getReturns({ handled: false })
    ]);

    return {
      ordersToShip: (openOrders.orders || []).length,
      returnsToHandle: (unresolvedReturns.returns || []).length,
      timestamp: new Date().toISOString()
    };
  }
}

// Backwards compatibility alias
const BolDirectClient = BolClient;

module.exports = {
  getBolMCPConfig,
  BolClient,
  BolDirectClient,
  ORDER_STATUS,
  FULFILMENT_METHOD,
  BOL_ENDPOINTS
};
