/**
 * Amazon Selling Partner API MCP Integration
 *
 * Provides MCP server configuration and direct API client for Amazon SP-API.
 * Supports: Orders, Inventory, Products, Reports, Finances, Notifications
 *
 * @module AmazonMCP
 */

const crypto = require('crypto');
const https = require('https');

/**
 * Amazon SP-API MCP Server Configuration
 * For use with MCP-compatible Amazon server (when available)
 */
function getAmazonMCPConfig() {
  return {
    name: 'amazon',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-amazon-sp'],
    env: {
      AMAZON_REFRESH_TOKEN: process.env.AMAZON_REFRESH_TOKEN,
      AMAZON_CLIENT_ID: process.env.AMAZON_CLIENT_ID,
      AMAZON_CLIENT_SECRET: process.env.AMAZON_CLIENT_SECRET,
      AMAZON_MARKETPLACE_ID: process.env.AMAZON_MARKETPLACE_ID || 'A1PA6795UKMFR9', // DE default
      AMAZON_SELLER_ID: process.env.AMAZON_SELLER_ID,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_REGION: process.env.AWS_REGION || 'eu-west-1'
    }
  };
}

/**
 * Amazon Marketplace IDs
 */
const MARKETPLACE_IDS = {
  // North America
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',

  // Europe
  UK: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYBER',
  IT: 'APJ6JRA9NG5V4',
  ES: 'A1RKKUPIHCS9HS',
  NL: 'A1805IZSGTT6HS',
  SE: 'A2NODRKZP88ZB9',
  PL: 'A1C3SOZRARQ6R3',
  BE: 'AMEN7PMS3EDWL',

  // Far East
  JP: 'A1VC38T7YXB528',
  AU: 'A39IBJ37TRP1C6',
  SG: 'A19VAU5U5O7RUS',
  IN: 'A21TJRUUN4KGV',

  // Middle East
  AE: 'A2VIGQ35RCS4UG',
  SA: 'A17E79C6D8DWNP',
  TR: 'A33AVAJ2PDY3EV'
};

/**
 * Amazon SP-API Endpoints by Region
 */
const ENDPOINTS = {
  'na': 'sellingpartnerapi-na.amazon.com',
  'eu': 'sellingpartnerapi-eu.amazon.com',
  'fe': 'sellingpartnerapi-fe.amazon.com'
};

/**
 * Direct Amazon SP-API Client
 * Fallback when MCP server is not available
 */
class AmazonDirectClient {
  constructor(config = {}) {
    this.refreshToken = config.refreshToken || process.env.AMAZON_REFRESH_TOKEN;
    this.clientId = config.clientId || process.env.AMAZON_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.AMAZON_CLIENT_SECRET;
    this.sellerId = config.sellerId || process.env.AMAZON_SELLER_ID;
    this.marketplaceId = config.marketplaceId || process.env.AMAZON_MARKETPLACE_ID || MARKETPLACE_IDS.DE;
    this.awsAccessKey = config.awsAccessKey || process.env.AWS_ACCESS_KEY_ID;
    this.awsSecretKey = config.awsSecretKey || process.env.AWS_SECRET_ACCESS_KEY;
    this.region = config.region || process.env.AWS_REGION || 'eu-west-1';

    this.endpoint = this._getEndpointForRegion(this.region);
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /**
   * Get SP-API endpoint based on AWS region
   */
  _getEndpointForRegion(region) {
    if (region.startsWith('us-') || region.startsWith('ca-') || region === 'sa-east-1') {
      return ENDPOINTS.na;
    } else if (region.startsWith('eu-') || region.startsWith('me-') || region === 'af-south-1') {
      return ENDPOINTS.eu;
    } else {
      return ENDPOINTS.fe;
    }
  }

  /**
   * Refresh access token using LWA (Login with Amazon)
   */
  async refreshAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.amazon.com',
        port: 443,
        path: '/auth/o2/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(params.toString())
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
              reject(new Error(`Token refresh failed: ${data}`));
            }
          } catch (e) {
            reject(new Error(`Token parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(params.toString());
      req.end();
    });
  }

  /**
   * Sign request with AWS Signature V4
   */
  _signRequest(method, path, headers, payload = '') {
    const service = 'execute-api';
    const algorithm = 'AWS4-HMAC-SHA256';
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = date.substring(0, 8);

    headers['x-amz-date'] = date;
    headers['host'] = this.endpoint;

    // Create canonical request
    const sortedHeaders = Object.keys(headers).sort();
    const signedHeaders = sortedHeaders.map(k => k.toLowerCase()).join(';');
    const canonicalHeaders = sortedHeaders.map(k => `${k.toLowerCase()}:${headers[k].trim()}`).join('\n') + '\n';
    const payloadHash = crypto.createHash('sha256').update(payload || '').digest('hex');

    const canonicalRequest = [
      method,
      path,
      '', // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    // Create string to sign
    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const stringToSign = [
      algorithm,
      date,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex')
    ].join('\n');

    // Calculate signature
    const kDate = crypto.createHmac('sha256', `AWS4${this.awsSecretKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(this.region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    headers['Authorization'] = `${algorithm} Credential=${this.awsAccessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return headers;
  }

  /**
   * Make authenticated API request
   */
  async _request(method, path, body = null) {
    await this.refreshAccessToken();

    const headers = {
      'x-amz-access-token': this.accessToken,
      'Content-Type': 'application/json'
    };

    const payload = body ? JSON.stringify(body) : '';
    const signedHeaders = this._signRequest(method, path, headers, payload);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: this.endpoint,
        port: 443,
        path: path,
        method: method,
        headers: signedHeaders
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              reject(new Error(`API Error ${res.statusCode}: ${JSON.stringify(response)}`));
            }
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}, Data: ${data}`));
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
      MarketplaceIds: params.marketplaceIds || this.marketplaceId,
      ...(params.createdAfter && { CreatedAfter: params.createdAfter }),
      ...(params.createdBefore && { CreatedBefore: params.createdBefore }),
      ...(params.lastUpdatedAfter && { LastUpdatedAfter: params.lastUpdatedAfter }),
      ...(params.orderStatuses && { OrderStatuses: params.orderStatuses.join(',') }),
      ...(params.fulfillmentChannels && { FulfillmentChannels: params.fulfillmentChannels.join(',') }),
      ...(params.maxResultsPerPage && { MaxResultsPerPage: params.maxResultsPerPage })
    });

    return this._request('GET', `/orders/v0/orders?${queryParams}`);
  }

  /**
   * Get order details
   */
  async getOrder(orderId) {
    return this._request('GET', `/orders/v0/orders/${orderId}`);
  }

  /**
   * Get order items
   */
  async getOrderItems(orderId) {
    return this._request('GET', `/orders/v0/orders/${orderId}/orderItems`);
  }

  /**
   * Get order buyer info (PII restricted)
   */
  async getOrderBuyerInfo(orderId) {
    return this._request('GET', `/orders/v0/orders/${orderId}/buyerInfo`);
  }

  // ==================== CATALOG ITEMS API ====================

  /**
   * Search catalog items
   */
  async searchCatalogItems(params = {}) {
    const queryParams = new URLSearchParams({
      marketplaceIds: params.marketplaceIds || this.marketplaceId,
      ...(params.keywords && { keywords: params.keywords }),
      ...(params.brandNames && { brandNames: params.brandNames.join(',') }),
      ...(params.classificationIds && { classificationIds: params.classificationIds.join(',') }),
      ...(params.includedData && { includedData: params.includedData.join(',') }),
      pageSize: params.pageSize || 20
    });

    return this._request('GET', `/catalog/2022-04-01/items?${queryParams}`);
  }

  /**
   * Get catalog item by ASIN
   */
  async getCatalogItem(asin, includedData = ['summaries', 'attributes', 'images', 'salesRanks']) {
    const queryParams = new URLSearchParams({
      marketplaceIds: this.marketplaceId,
      includedData: includedData.join(',')
    });

    return this._request('GET', `/catalog/2022-04-01/items/${asin}?${queryParams}`);
  }

  // ==================== INVENTORY API (FBA) ====================

  /**
   * Get FBA inventory summaries
   */
  async getInventorySummaries(params = {}) {
    const queryParams = new URLSearchParams({
      granularityType: params.granularityType || 'Marketplace',
      granularityId: params.granularityId || this.marketplaceId,
      marketplaceIds: params.marketplaceIds || this.marketplaceId,
      ...(params.sellerSkus && { sellerSkus: params.sellerSkus.join(',') }),
      ...(params.startDateTime && { startDateTime: params.startDateTime }),
      details: params.details || true
    });

    return this._request('GET', `/fba/inventory/v1/summaries?${queryParams}`);
  }

  // ==================== PRODUCT PRICING API ====================

  /**
   * Get competitive pricing for ASINs
   */
  async getCompetitivePricing(asins) {
    const queryParams = new URLSearchParams({
      MarketplaceId: this.marketplaceId,
      ItemType: 'Asin',
      Asins: asins.join(',')
    });

    return this._request('GET', `/products/pricing/v0/competitivePrice?${queryParams}`);
  }

  /**
   * Get item offers (Buy Box info)
   */
  async getItemOffers(asin, itemCondition = 'New') {
    const queryParams = new URLSearchParams({
      MarketplaceId: this.marketplaceId,
      ItemCondition: itemCondition
    });

    return this._request('GET', `/products/pricing/v0/items/${asin}/offers?${queryParams}`);
  }

  // ==================== LISTINGS API ====================

  /**
   * Get listings item (your product listing)
   */
  async getListingsItem(sku) {
    const queryParams = new URLSearchParams({
      marketplaceIds: this.marketplaceId,
      includedData: 'summaries,attributes,issues,offers,fulfillmentAvailability'
    });

    return this._request('GET', `/listings/2021-08-01/items/${this.sellerId}/${encodeURIComponent(sku)}?${queryParams}`);
  }

  /**
   * Update listings item
   */
  async patchListingsItem(sku, patches) {
    const queryParams = new URLSearchParams({
      marketplaceIds: this.marketplaceId
    });

    return this._request('PATCH', `/listings/2021-08-01/items/${this.sellerId}/${encodeURIComponent(sku)}?${queryParams}`, {
      productType: patches.productType,
      patches: patches.patches
    });
  }

  // ==================== FINANCES API ====================

  /**
   * Get financial events (settlements, refunds, etc.)
   */
  async getFinancialEvents(params = {}) {
    const queryParams = new URLSearchParams({
      ...(params.postedAfter && { PostedAfter: params.postedAfter }),
      ...(params.postedBefore && { PostedBefore: params.postedBefore }),
      ...(params.maxResultsPerPage && { MaxResultsPerPage: params.maxResultsPerPage })
    });

    return this._request('GET', `/finances/v0/financialEvents?${queryParams}`);
  }

  /**
   * Get financial events for order
   */
  async getFinancialEventsForOrder(orderId) {
    return this._request('GET', `/finances/v0/orders/${orderId}/financialEvents`);
  }

  // ==================== REPORTS API ====================

  /**
   * Create a report
   */
  async createReport(reportType, params = {}) {
    return this._request('POST', '/reports/2021-06-30/reports', {
      reportType: reportType,
      marketplaceIds: params.marketplaceIds || [this.marketplaceId],
      ...(params.dataStartTime && { dataStartTime: params.dataStartTime }),
      ...(params.dataEndTime && { dataEndTime: params.dataEndTime }),
      ...(params.reportOptions && { reportOptions: params.reportOptions })
    });
  }

  /**
   * Get report status
   */
  async getReport(reportId) {
    return this._request('GET', `/reports/2021-06-30/reports/${reportId}`);
  }

  /**
   * Get report document
   */
  async getReportDocument(reportDocumentId) {
    return this._request('GET', `/reports/2021-06-30/documents/${reportDocumentId}`);
  }

  /**
   * Common report types
   */
  static REPORT_TYPES = {
    // Inventory
    FBA_INVENTORY: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA',
    MERCHANT_INVENTORY: 'GET_MERCHANT_LISTINGS_ALL_DATA',

    // Orders
    UNSHIPPED_ORDERS: 'GET_FLAT_FILE_ACTIONABLE_ORDER_DATA_SHIPPING',
    ALL_ORDERS: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',

    // Financial
    SETTLEMENT: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    DATE_RANGE_FINANCIAL: 'GET_DATE_RANGE_FINANCIAL_TRANSACTION_DATA',

    // Sales
    SALES_TRAFFIC: 'GET_SALES_AND_TRAFFIC_REPORT',

    // Performance
    FEEDBACK: 'GET_SELLER_FEEDBACK_DATA',
    RETURNS: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'
  };

  // ==================== NOTIFICATIONS API ====================

  /**
   * Get subscription for notification type
   */
  async getSubscription(notificationType) {
    return this._request('GET', `/notifications/v1/subscriptions/${notificationType}`);
  }

  /**
   * Create subscription for notifications
   */
  async createSubscription(notificationType, destinationId) {
    return this._request('POST', `/notifications/v1/subscriptions/${notificationType}`, {
      destinationId: destinationId,
      payloadVersion: '1.0'
    });
  }

  /**
   * Common notification types
   */
  static NOTIFICATION_TYPES = {
    ORDER_CHANGE: 'ORDER_CHANGE',
    FEED_PROCESSING_FINISHED: 'FEED_PROCESSING_FINISHED',
    REPORT_PROCESSING_FINISHED: 'REPORT_PROCESSING_FINISHED',
    PRICING_HEALTH: 'PRICING_HEALTH',
    ITEM_INVENTORY_EVENT_CHANGE: 'ITEM_INVENTORY_EVENT_CHANGE',
    FBA_OUTBOUND_SHIPMENT_STATUS: 'FBA_OUTBOUND_SHIPMENT_STATUS'
  };

  // ==================== UTILITY METHODS ====================

  /**
   * Get sales summary for date range
   */
  async getSalesSummary(startDate, endDate) {
    const orders = await this.getOrders({
      createdAfter: startDate,
      createdBefore: endDate,
      orderStatuses: ['Shipped', 'Unshipped', 'PartiallyShipped']
    });

    let totalSales = 0;
    let orderCount = 0;
    const orderList = orders.payload?.Orders || [];

    for (const order of orderList) {
      if (order.OrderTotal) {
        totalSales += parseFloat(order.OrderTotal.Amount || 0);
      }
      orderCount++;
    }

    return {
      startDate,
      endDate,
      totalOrders: orderCount,
      totalSales: totalSales,
      currency: orderList[0]?.OrderTotal?.CurrencyCode || 'EUR',
      averageOrderValue: orderCount > 0 ? totalSales / orderCount : 0
    };
  }

  /**
   * Get inventory health summary
   */
  async getInventoryHealth() {
    const inventory = await this.getInventorySummaries({ details: true });
    const summaries = inventory.payload?.inventorySummaries || [];

    let totalUnits = 0;
    let inStockSkus = 0;
    let lowStockSkus = 0;
    let outOfStockSkus = 0;

    for (const item of summaries) {
      const qty = item.totalQuantity || 0;
      totalUnits += qty;

      if (qty === 0) {
        outOfStockSkus++;
      } else if (qty < 10) {
        lowStockSkus++;
      } else {
        inStockSkus++;
      }
    }

    return {
      totalSkus: summaries.length,
      totalUnits,
      inStockSkus,
      lowStockSkus,
      outOfStockSkus,
      healthScore: summaries.length > 0 ? (inStockSkus / summaries.length * 100).toFixed(1) : 0
    };
  }
}

module.exports = {
  getAmazonMCPConfig,
  AmazonDirectClient,
  MARKETPLACE_IDS,
  ENDPOINTS
};
