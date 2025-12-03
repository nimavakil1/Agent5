/**
 * Amazon Selling Partner API MCP Integration
 *
 * Uses the amazon-sp-api package for reliable API access.
 * Package: https://www.npmjs.com/package/amazon-sp-api
 *
 * Features:
 * - Automatic token refresh
 * - Rate limit handling
 * - Report downloading
 *
 * @module AmazonMCP
 */

const SellingPartner = require('amazon-sp-api');

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
 * Common Report Types
 */
const REPORT_TYPES = {
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

/**
 * Amazon MCP Server Configuration
 * For use with MCP-compatible Amazon server
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
      AMAZON_MARKETPLACE_ID: process.env.AMAZON_MARKETPLACE_ID || 'A1PA6795UKMFR9',
      AMAZON_SELLER_ID: process.env.AMAZON_SELLER_ID,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_REGION: process.env.AWS_REGION || 'eu-west-1'
    }
  };
}

/**
 * Amazon SP-API Client using amazon-sp-api package
 * More reliable than custom implementation
 */
class AmazonClient {
  constructor(config = {}) {
    this.config = {
      region: config.region || process.env.AWS_REGION || 'eu',
      refresh_token: config.refreshToken || process.env.AMAZON_REFRESH_TOKEN,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: config.clientId || process.env.AMAZON_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: config.clientSecret || process.env.AMAZON_CLIENT_SECRET,
        AWS_ACCESS_KEY_ID: config.awsAccessKey || process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: config.awsSecretKey || process.env.AWS_SECRET_ACCESS_KEY,
        AWS_SELLING_PARTNER_ROLE: config.roleArn || process.env.AWS_SELLING_PARTNER_ROLE
      },
      options: {
        auto_request_tokens: true,
        auto_request_throttled: true,
        version_fallback: true,
        use_sandbox: config.sandbox || process.env.AMAZON_USE_SANDBOX === 'true'
      }
    };

    this.marketplaceId = config.marketplaceId || process.env.AMAZON_MARKETPLACE_ID || MARKETPLACE_IDS.DE;
    this.sellerId = config.sellerId || process.env.AMAZON_SELLER_ID;
    this.client = null;
  }

  /**
   * Initialize the SP-API client
   */
  async init() {
    if (this.client) return this.client;

    try {
      this.client = new SellingPartner(this.config);
      return this.client;
    } catch (error) {
      throw new Error(`Failed to initialize Amazon SP-API client: ${error.message}`);
    }
  }

  /**
   * Get client (initializes if needed)
   */
  async getClient() {
    if (!this.client) {
      await this.init();
    }
    return this.client;
  }

  // ==================== ORDERS API ====================

  /**
   * Get orders with filters
   */
  async getOrders(params = {}) {
    const client = await this.getClient();

    const queryParams = {
      MarketplaceIds: params.marketplaceIds || [this.marketplaceId],
      ...(params.createdAfter && { CreatedAfter: params.createdAfter }),
      ...(params.createdBefore && { CreatedBefore: params.createdBefore }),
      ...(params.lastUpdatedAfter && { LastUpdatedAfter: params.lastUpdatedAfter }),
      ...(params.orderStatuses && { OrderStatuses: params.orderStatuses }),
      ...(params.fulfillmentChannels && { FulfillmentChannels: params.fulfillmentChannels }),
      ...(params.maxResultsPerPage && { MaxResultsPerPage: params.maxResultsPerPage })
    };

    return client.callAPI({
      operation: 'getOrders',
      query: queryParams
    });
  }

  /**
   * Get order details
   */
  async getOrder(orderId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getOrder',
      path: { orderId }
    });
  }

  /**
   * Get order items
   */
  async getOrderItems(orderId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getOrderItems',
      path: { orderId }
    });
  }

  /**
   * Get order buyer info
   */
  async getOrderBuyerInfo(orderId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getOrderBuyerInfo',
      path: { orderId }
    });
  }

  // ==================== CATALOG ITEMS API ====================

  /**
   * Search catalog items
   */
  async searchCatalogItems(params = {}) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'searchCatalogItems',
      query: {
        marketplaceIds: params.marketplaceIds || [this.marketplaceId],
        ...(params.keywords && { keywords: params.keywords }),
        ...(params.brandNames && { brandNames: params.brandNames }),
        ...(params.includedData && { includedData: params.includedData }),
        pageSize: params.pageSize || 20
      }
    });
  }

  /**
   * Get catalog item by ASIN
   */
  async getCatalogItem(asin, includedData = ['summaries', 'attributes', 'images', 'salesRanks']) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getCatalogItem',
      path: { asin },
      query: {
        marketplaceIds: [this.marketplaceId],
        includedData: includedData
      }
    });
  }

  // ==================== INVENTORY API (FBA) ====================

  /**
   * Get FBA inventory summaries
   */
  async getInventorySummaries(params = {}) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getInventorySummaries',
      query: {
        granularityType: params.granularityType || 'Marketplace',
        granularityId: params.granularityId || this.marketplaceId,
        marketplaceIds: params.marketplaceIds || [this.marketplaceId],
        ...(params.sellerSkus && { sellerSkus: params.sellerSkus }),
        details: params.details !== false
      }
    });
  }

  // ==================== PRODUCT PRICING API ====================

  /**
   * Get competitive pricing for ASINs
   */
  async getCompetitivePricing(asins) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getCompetitivePricing',
      query: {
        MarketplaceId: this.marketplaceId,
        ItemType: 'Asin',
        Asins: Array.isArray(asins) ? asins : [asins]
      }
    });
  }

  /**
   * Get item offers (Buy Box info)
   */
  async getItemOffers(asin, itemCondition = 'New') {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getItemOffers',
      path: { Asin: asin },
      query: {
        MarketplaceId: this.marketplaceId,
        ItemCondition: itemCondition
      }
    });
  }

  // ==================== LISTINGS API ====================

  /**
   * Get listings item
   */
  async getListingsItem(sku) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getListingsItem',
      path: {
        sellerId: this.sellerId,
        sku: sku
      },
      query: {
        marketplaceIds: [this.marketplaceId],
        includedData: ['summaries', 'attributes', 'issues', 'offers', 'fulfillmentAvailability']
      }
    });
  }

  /**
   * Patch listings item
   */
  async patchListingsItem(sku, patches) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'patchListingsItem',
      path: {
        sellerId: this.sellerId,
        sku: sku
      },
      query: {
        marketplaceIds: [this.marketplaceId]
      },
      body: patches
    });
  }

  // ==================== FINANCES API ====================

  /**
   * Get financial events
   */
  async getFinancialEvents(params = {}) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'listFinancialEvents',
      query: {
        ...(params.postedAfter && { PostedAfter: params.postedAfter }),
        ...(params.postedBefore && { PostedBefore: params.postedBefore }),
        ...(params.maxResultsPerPage && { MaxResultsPerPage: params.maxResultsPerPage })
      }
    });
  }

  /**
   * Get financial events for order
   */
  async getFinancialEventsForOrder(orderId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'listFinancialEventsByOrderId',
      path: { orderId }
    });
  }

  // ==================== REPORTS API ====================

  /**
   * Create a report
   */
  async createReport(reportType, params = {}) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'createReport',
      body: {
        reportType: reportType,
        marketplaceIds: params.marketplaceIds || [this.marketplaceId],
        ...(params.dataStartTime && { dataStartTime: params.dataStartTime }),
        ...(params.dataEndTime && { dataEndTime: params.dataEndTime }),
        ...(params.reportOptions && { reportOptions: params.reportOptions })
      }
    });
  }

  /**
   * Get report
   */
  async getReport(reportId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getReport',
      path: { reportId }
    });
  }

  /**
   * Download report (with automatic decompression)
   */
  async downloadReport(params = {}) {
    const client = await this.getClient();

    // The amazon-sp-api package has built-in report downloading
    return client.downloadReport({
      body: {
        reportType: params.reportType,
        marketplaceIds: params.marketplaceIds || [this.marketplaceId],
        ...(params.dataStartTime && { dataStartTime: params.dataStartTime }),
        ...(params.dataEndTime && { dataEndTime: params.dataEndTime })
      },
      version: params.version || '2021-06-30',
      interval: params.pollInterval || 10000, // Poll every 10 seconds
      timeout: params.timeout || 600000 // 10 minute timeout
    });
  }

  // ==================== NOTIFICATIONS API ====================

  /**
   * Get subscription
   */
  async getSubscription(notificationType) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getSubscription',
      path: { notificationType }
    });
  }

  /**
   * Create subscription
   */
  async createSubscription(notificationType, destinationId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'createSubscription',
      path: { notificationType },
      body: {
        destinationId: destinationId,
        payloadVersion: '1.0'
      }
    });
  }

  // ==================== FBA INBOUND ====================

  /**
   * Get inbound shipments
   */
  async getShipments(params = {}) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'getShipments',
      query: {
        MarketplaceId: this.marketplaceId,
        ...(params.shipmentStatusList && { ShipmentStatusList: params.shipmentStatusList }),
        ...(params.shipmentIdList && { ShipmentIdList: params.shipmentIdList }),
        ...(params.lastUpdatedAfter && { LastUpdatedAfter: params.lastUpdatedAfter }),
        ...(params.lastUpdatedBefore && { LastUpdatedBefore: params.lastUpdatedBefore }),
        QueryType: params.queryType || 'SHIPMENT'
      }
    });
  }

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
    const orderList = orders.Orders || [];

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
    const summaries = inventory.inventorySummaries || [];

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

  /**
   * Get pending orders that need attention
   */
  async getPendingOrders() {
    const orders = await this.getOrders({
      orderStatuses: ['Unshipped', 'PartiallyShipped']
    });

    return {
      count: orders.Orders?.length || 0,
      orders: orders.Orders || []
    };
  }
}

// Backwards compatibility alias
const AmazonDirectClient = AmazonClient;

module.exports = {
  getAmazonMCPConfig,
  AmazonClient,
  AmazonDirectClient,
  MARKETPLACE_IDS,
  REPORT_TYPES
};
