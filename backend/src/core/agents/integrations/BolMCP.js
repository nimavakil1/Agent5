/**
 * Bol.com Retailer API MCP Integration
 *
 * Provides MCP server configuration and direct API client for Bol.com.
 * Supports: Orders, Offers, Inventory, Shipments, Returns, Insights
 *
 * API Documentation: https://api.bol.com/retailer/public/redoc/v10
 *
 * @module BolMCP
 */

const https = require('https');

/**
 * Bol.com MCP Server Configuration
 * For use with MCP-compatible Bol.com server (when available)
 */
function getBolMCPConfig() {
  return {
    name: 'bolcom',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-bolcom'],
    env: {
      BOL_CLIENT_ID: process.env.BOL_CLIENT_ID,
      BOL_CLIENT_SECRET: process.env.BOL_CLIENT_SECRET,
      BOL_ENVIRONMENT: process.env.BOL_ENVIRONMENT || 'production' // 'test' or 'production'
    }
  };
}

/**
 * Bol.com API Endpoints
 */
const BOL_ENDPOINTS = {
  auth: 'login.bol.com',
  api_test: 'api.bol.com',
  api_prod: 'api.bol.com'
};

/**
 * Bol.com Order Status Types
 */
const ORDER_STATUS = {
  OPEN: 'OPEN',
  SHIPPED: 'SHIPPED',
  ALL: 'ALL'
};

/**
 * Bol.com Fulfilment Methods
 */
const FULFILMENT_METHOD = {
  FBR: 'FBR', // Fulfilled by Retailer
  FBB: 'FBB', // Fulfilled by Bol.com (LVB)
  ALL: 'ALL'
};

/**
 * Direct Bol.com Retailer API Client
 * Fallback when MCP server is not available
 */
class BolDirectClient {
  constructor(config = {}) {
    this.clientId = config.clientId || process.env.BOL_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.BOL_CLIENT_SECRET;
    this.environment = config.environment || process.env.BOL_ENVIRONMENT || 'production';

    this.apiHost = BOL_ENDPOINTS.api_prod;
    this.authHost = BOL_ENDPOINTS.auth;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /**
   * Get access token using client credentials
   */
  async authenticate() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: this.authHost,
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
              // Token expires in 'expires_in' seconds, refresh 60s before
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
  async _request(method, path, body = null, apiVersion = 'v10') {
    await this.authenticate();

    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Accept': 'application/vnd.retailer.' + apiVersion + '+json',
      'Content-Type': 'application/vnd.retailer.' + apiVersion + '+json'
    };

    const payload = body ? JSON.stringify(body) : '';

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: this.apiHost,
        port: 443,
        path: `/retailer${path}`,
        method: method,
        headers: headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            // Handle empty responses (204 No Content)
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
            // If response is not JSON, return raw data
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

  // ==================== ORDERS API ====================

  /**
   * Get orders with filters
   */
  async getOrders(params = {}) {
    const queryParams = new URLSearchParams({
      page: params.page || 1,
      ...(params.fulfilmentMethod && { 'fulfilment-method': params.fulfilmentMethod }),
      ...(params.status && { status: params.status }),
      ...(params.changeIntervalMinute && { 'change-interval-minute': params.changeIntervalMinute }),
      ...(params.latestChangeDate && { 'latest-change-date': params.latestChangeDate })
    });

    return this._request('GET', `/orders?${queryParams}`);
  }

  /**
   * Get single order by ID
   */
  async getOrder(orderId) {
    return this._request('GET', `/orders/${orderId}`);
  }

  /**
   * Cancel order item
   */
  async cancelOrderItem(orderItemId, reasonCode = 'OUT_OF_STOCK') {
    return this._request('PUT', `/orders/cancellation`, {
      orderItems: [{
        orderItemId: orderItemId,
        reasonCode: reasonCode
      }]
    });
  }

  // ==================== SHIPMENTS API ====================

  /**
   * Get shipments
   */
  async getShipments(params = {}) {
    const queryParams = new URLSearchParams({
      page: params.page || 1,
      ...(params.fulfilmentMethod && { 'fulfilment-method': params.fulfilmentMethod }),
      ...(params.orderId && { 'order-id': params.orderId })
    });

    return this._request('GET', `/shipments?${queryParams}`);
  }

  /**
   * Get single shipment
   */
  async getShipment(shipmentId) {
    return this._request('GET', `/shipments/${shipmentId}`);
  }

  /**
   * Create shipment (ship order items)
   */
  async createShipment(shipmentData) {
    return this._request('POST', '/shipments', {
      orderItems: shipmentData.orderItems.map(item => ({
        orderItemId: item.orderItemId,
        quantity: item.quantity || 1
      })),
      shipmentReference: shipmentData.reference,
      transport: {
        transporterCode: shipmentData.transporterCode,
        trackAndTrace: shipmentData.trackAndTrace
      }
    });
  }

  /**
   * Get shipping labels
   */
  async getShippingLabel(orderId) {
    return this._request('GET', `/shipping-labels/orders/${orderId}`);
  }

  // ==================== OFFERS API ====================

  /**
   * Get all offers (your product listings)
   */
  async getOffers(params = {}) {
    const queryParams = new URLSearchParams({
      page: params.page || 1,
      ...(params.status && { status: params.status })
    });

    return this._request('GET', `/offers/export?${queryParams}`);
  }

  /**
   * Get single offer by offer ID
   */
  async getOffer(offerId) {
    return this._request('GET', `/offers/${offerId}`);
  }

  /**
   * Create new offer
   */
  async createOffer(offerData) {
    return this._request('POST', '/offers', {
      ean: offerData.ean,
      condition: {
        name: offerData.condition || 'NEW',
        category: offerData.conditionCategory || 'NEW'
      },
      pricing: {
        bundlePrices: [{
          quantity: 1,
          unitPrice: offerData.price
        }]
      },
      stock: {
        amount: offerData.stock,
        managedByRetailer: true
      },
      fulfilment: {
        method: offerData.fulfilmentMethod || 'FBR',
        deliveryCode: offerData.deliveryCode || '1-2d'
      }
    });
  }

  /**
   * Update offer
   */
  async updateOffer(offerId, updates) {
    return this._request('PUT', `/offers/${offerId}`, updates);
  }

  /**
   * Update offer price
   */
  async updateOfferPrice(offerId, price) {
    return this._request('PUT', `/offers/${offerId}/price`, {
      pricing: {
        bundlePrices: [{
          quantity: 1,
          unitPrice: price
        }]
      }
    });
  }

  /**
   * Update offer stock
   */
  async updateOfferStock(offerId, amount, managedByRetailer = true) {
    return this._request('PUT', `/offers/${offerId}/stock`, {
      amount: amount,
      managedByRetailer: managedByRetailer
    });
  }

  /**
   * Delete offer
   */
  async deleteOffer(offerId) {
    return this._request('DELETE', `/offers/${offerId}`);
  }

  // ==================== INVENTORY API (FBB/LVB) ====================

  /**
   * Get LVB/FBB inventory
   */
  async getInventory(params = {}) {
    const queryParams = new URLSearchParams({
      page: params.page || 1,
      ...(params.quantity && { quantity: params.quantity }), // 0-10, 10-100, 100+
      ...(params.stock && { stock: params.stock }), // sufficient, insufficient
      ...(params.state && { state: params.state }), // saleable, unsaleable
      ...(params.query && { query: params.query })
    });

    return this._request('GET', `/inventory?${queryParams}`);
  }

  // ==================== RETURNS API ====================

  /**
   * Get returns
   */
  async getReturns(params = {}) {
    const queryParams = new URLSearchParams({
      page: params.page || 1,
      ...(params.handled && { handled: params.handled }),
      ...(params.fulfilmentMethod && { 'fulfilment-method': params.fulfilmentMethod })
    });

    return this._request('GET', `/returns?${queryParams}`);
  }

  /**
   * Get single return
   */
  async getReturn(returnId) {
    return this._request('GET', `/returns/${returnId}`);
  }

  /**
   * Handle return (accept or reject)
   */
  async handleReturn(rmaId, handlingResult, quantityReturned) {
    return this._request('PUT', `/returns/${rmaId}`, {
      handlingResult: handlingResult, // 'RETURN_RECEIVED', 'EXCHANGE_PRODUCT', 'RETURN_DOES_NOT_MEET_CONDITIONS', 'REPAIR_PRODUCT', 'CUSTOMER_KEEPS_PRODUCT_PAID', 'STILL_APPROVED'
      quantityReturned: quantityReturned
    });
  }

  // ==================== PRODUCTS API ====================

  /**
   * Get product by EAN
   */
  async getProduct(ean) {
    return this._request('GET', `/products/${ean}`);
  }

  /**
   * Get product assets (images, etc.)
   */
  async getProductAssets(ean) {
    return this._request('GET', `/products/${ean}/assets`);
  }

  /**
   * Get product placement (category info)
   */
  async getProductPlacement(ean) {
    return this._request('GET', `/products/${ean}/placement`);
  }

  // ==================== INSIGHTS API ====================

  /**
   * Get performance indicators
   */
  async getPerformanceIndicators(params = {}) {
    const queryParams = new URLSearchParams({
      ...(params.name && { name: params.name.join(',') }),
      ...(params.year && { year: params.year }),
      ...(params.week && { week: params.week })
    });

    return this._request('GET', `/insights/performance/indicator?${queryParams}`);
  }

  /**
   * Get sales forecast
   */
  async getSalesForecast(offerId, weeksAhead = 12) {
    return this._request('GET', `/insights/sales-forecast?offer-id=${offerId}&weeks-ahead=${weeksAhead}`);
  }

  /**
   * Get search terms (what customers search for)
   */
  async getSearchTerms(params = {}) {
    const queryParams = new URLSearchParams({
      ...(params.searchTerm && { 'search-term': params.searchTerm }),
      ...(params.period && { period: params.period }), // DAY, WEEK, MONTH
      ...(params.numberOfPeriods && { 'number-of-periods': params.numberOfPeriods }),
      ...(params.relatedSearchTerms && { 'related-search-terms': params.relatedSearchTerms })
    });

    return this._request('GET', `/insights/search-terms?${queryParams}`);
  }

  // ==================== COMMISSIONS API ====================

  /**
   * Get commission for EAN
   */
  async getCommission(ean, condition = 'NEW', price) {
    const queryParams = new URLSearchParams({
      ean: ean,
      condition: condition,
      'unit-price': price
    });

    return this._request('GET', `/commission?${queryParams}`);
  }

  /**
   * Get commission list (bulk)
   */
  async getCommissions(products) {
    return this._request('POST', '/commission', {
      commissionQueries: products.map(p => ({
        ean: p.ean,
        condition: p.condition || 'NEW',
        unitPrice: p.price
      }))
    });
  }

  // ==================== REPLENISHMENTS API (FBB/LVB) ====================

  /**
   * Get replenishments
   */
  async getReplenishments(params = {}) {
    const queryParams = new URLSearchParams({
      page: params.page || 1,
      ...(params.state && { state: params.state.join(',') }),
      ...(params.reference && { reference: params.reference })
    });

    return this._request('GET', `/replenishments?${queryParams}`);
  }

  /**
   * Create replenishment (send stock to Bol.com warehouse)
   */
  async createReplenishment(replenishmentData) {
    return this._request('POST', '/replenishments', {
      reference: replenishmentData.reference,
      deliveryInfo: {
        expectedDeliveryDate: replenishmentData.expectedDeliveryDate,
        transporterCode: replenishmentData.transporterCode
      },
      labelingByBol: replenishmentData.labelingByBol || false,
      numberOfLoadCarriers: replenishmentData.numberOfLoadCarriers || 1,
      lines: replenishmentData.lines.map(line => ({
        ean: line.ean,
        quantity: line.quantity
      }))
    });
  }

  // ==================== SUBSCRIPTIONS API (Webhooks) ====================

  /**
   * Get push notification subscriptions
   */
  async getSubscriptions() {
    return this._request('GET', '/subscriptions');
  }

  /**
   * Create subscription (webhook)
   */
  async createSubscription(resourceType, url) {
    return this._request('POST', '/subscriptions', {
      resources: [resourceType],
      url: url
    });
  }

  /**
   * Delete subscription
   */
  async deleteSubscription(subscriptionId) {
    return this._request('DELETE', `/subscriptions/${subscriptionId}`);
  }

  /**
   * Subscription resource types
   */
  static SUBSCRIPTION_TYPES = {
    ORDER_PLACED: 'ORDER_PLACED',
    ORDER_CANCELLED: 'ORDER_CANCELLED',
    SHIPMENT_CREATED: 'SHIPMENT_CREATED',
    RETURN_CREATED: 'RETURN_CREATED',
    RETURN_STATUS_CHANGED: 'RETURN_STATUS_CHANGED',
    OFFER_STOCK_CHANGED: 'OFFER_STOCK_CHANGED',
    PROCESS_STATUS: 'PROCESS_STATUS'
  };

  // ==================== UTILITY METHODS ====================

  /**
   * Get sales summary for period
   */
  async getSalesSummary(daysBack = 30) {
    let allOrders = [];
    let page = 1;
    let hasMore = true;

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    while (hasMore && page <= 10) { // Max 10 pages to prevent infinite loops
      const response = await this.getOrders({
        page: page,
        status: ORDER_STATUS.ALL
      });

      const orders = response.orders || [];
      allOrders = allOrders.concat(orders);

      hasMore = orders.length > 0;
      page++;
    }

    // Filter orders within date range and calculate totals
    let totalRevenue = 0;
    let orderCount = 0;
    let itemCount = 0;

    for (const order of allOrders) {
      const orderDate = new Date(order.orderPlacedDateTime);
      if (orderDate >= startDate && orderDate <= endDate) {
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
      endDate: endDate.toISOString(),
      totalOrders: orderCount,
      totalItems: itemCount,
      totalRevenue: totalRevenue.toFixed(2),
      currency: 'EUR',
      averageOrderValue: orderCount > 0 ? (totalRevenue / orderCount).toFixed(2) : '0.00'
    };
  }

  /**
   * Get stock health overview
   */
  async getStockHealth() {
    let page = 1;
    let allOffers = [];
    let hasMore = true;

    // Note: This is a simplified version - full implementation would use offers export
    const response = await this.getOffers({ page: 1 });

    // Count stock levels
    let inStock = 0;
    let lowStock = 0;
    let outOfStock = 0;

    // The actual response structure depends on Bol.com API
    // This is a placeholder for the concept
    return {
      totalOffers: allOffers.length,
      inStock: inStock,
      lowStock: lowStock,
      outOfStock: outOfStock,
      healthScore: allOffers.length > 0 ? ((inStock / allOffers.length) * 100).toFixed(1) : 0
    };
  }

  /**
   * Get pending actions summary
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

module.exports = {
  getBolMCPConfig,
  BolDirectClient,
  ORDER_STATUS,
  FULFILMENT_METHOD,
  BOL_ENDPOINTS
};
