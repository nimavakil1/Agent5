/**
 * SellerClient - Amazon Seller Central SP-API Client
 *
 * Handles all SP-API communication for Seller Central operations.
 * Uses a single refresh token for all 13 marketplaces (Pan-EU account).
 *
 * @module SellerClient
 */

const SellingPartner = require('amazon-sp-api');
const { getAllMarketplaceIds, getMarketplaceConfig } = require('./SellerMarketplaceConfig');

/**
 * SellerClient - SP-API client for Seller Central
 */
class SellerClient {
  /**
   * Create a SellerClient instance
   * Uses AMAZON_SELLER_REFRESH_TOKEN for all marketplaces
   */
  constructor() {
    const refreshToken = process.env.AMAZON_SELLER_REFRESH_TOKEN;
    const clientId = process.env.AMAZON_SP_LWA_CLIENT_ID;
    const clientSecret = process.env.AMAZON_SP_LWA_CLIENT_SECRET;

    if (!refreshToken) {
      throw new Error('AMAZON_SELLER_REFRESH_TOKEN is not configured');
    }
    if (!clientId || !clientSecret) {
      throw new Error('AMAZON_SP_LWA_CLIENT_ID and AMAZON_SP_LWA_CLIENT_SECRET must be configured');
    }

    this.config = {
      region: 'eu',
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: clientId,
        SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret
      },
      options: {
        auto_request_tokens: true,
        auto_request_throttled: true,
        version_fallback: true,
        use_sandbox: process.env.AMAZON_USE_SANDBOX === 'true'
      }
    };

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
      throw new Error(`Failed to initialize Seller SP-API client: ${error.message}`);
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
   * Get orders from Amazon
   * @param {Object} params - Query parameters
   * @param {string[]} params.marketplaceIds - Array of marketplace IDs to query
   * @param {string} params.createdAfter - ISO date string
   * @param {string} params.createdBefore - ISO date string
   * @param {string} params.lastUpdatedAfter - ISO date string (for polling)
   * @param {string} params.lastUpdatedBefore - ISO date string
   * @param {string[]} params.orderStatuses - Filter by order status
   * @param {string[]} params.fulfillmentChannels - Filter by fulfillment channel ('AFN' or 'MFN')
   * @param {number} params.maxResultsPerPage - Max results per page (default 100)
   * @param {string} params.nextToken - Pagination token
   */
  async getOrders(params = {}) {
    const client = await this.getClient();

    // Default to all marketplaces if not specified
    const marketplaceIds = params.marketplaceIds || getAllMarketplaceIds();

    const queryParams = {
      MarketplaceIds: marketplaceIds,
      ...(params.createdAfter && { CreatedAfter: params.createdAfter }),
      ...(params.createdBefore && { CreatedBefore: params.createdBefore }),
      ...(params.lastUpdatedAfter && { LastUpdatedAfter: params.lastUpdatedAfter }),
      ...(params.lastUpdatedBefore && { LastUpdatedBefore: params.lastUpdatedBefore }),
      ...(params.orderStatuses && { OrderStatuses: params.orderStatuses }),
      ...(params.fulfillmentChannels && { FulfillmentChannels: params.fulfillmentChannels }),
      ...(params.maxResultsPerPage && { MaxResultsPerPage: params.maxResultsPerPage }),
      ...(params.nextToken && { NextToken: params.nextToken })
    };

    return client.callAPI({
      operation: 'orders.getOrders',
      query: queryParams
    });
  }

  /**
   * Get a specific order by Amazon Order ID
   * @param {string} orderId - Amazon Order ID (e.g., "403-1234567-8901234")
   */
  async getOrder(orderId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'orders.getOrder',
      path: { orderId }
    });
  }

  /**
   * Get order items for an order
   * @param {string} orderId - Amazon Order ID
   * @param {string} nextToken - Pagination token
   */
  async getOrderItems(orderId, nextToken = null) {
    const client = await this.getClient();

    const queryParams = {};
    if (nextToken) {
      queryParams.NextToken = nextToken;
    }

    return client.callAPI({
      operation: 'orders.getOrderItems',
      path: { orderId },
      query: queryParams
    });
  }

  /**
   * Get all order items (handles pagination)
   * @param {string} orderId - Amazon Order ID
   */
  async getAllOrderItems(orderId) {
    const allItems = [];
    let nextToken = null;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getOrderItems(orderId, nextToken);

      if (response.OrderItems && response.OrderItems.length > 0) {
        allItems.push(...response.OrderItems);
      }

      nextToken = response.NextToken;
      hasMore = !!nextToken;

      // Safety limit
      if (allItems.length > 500) {
        console.warn(`SellerClient: Reached 500 item limit for order ${orderId}, stopping pagination`);
        break;
      }
    }

    return allItems;
  }

  /**
   * Get order buyer info (requires additional permissions)
   * @param {string} orderId - Amazon Order ID
   */
  async getOrderBuyerInfo(orderId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'orders.getOrderBuyerInfo',
      path: { orderId }
    });
  }

  /**
   * Get order address (requires additional permissions)
   * @param {string} orderId - Amazon Order ID
   */
  async getOrderAddress(orderId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'orders.getOrderAddress',
      path: { orderId }
    });
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Poll for orders updated since a specific time
   * This is the main polling method for order sync
   * @param {Date|string} lastUpdatedAfter - Date or ISO string
   * @param {Object} options - Additional options
   */
  async pollOrdersSince(lastUpdatedAfter, options = {}) {
    const since = lastUpdatedAfter instanceof Date
      ? lastUpdatedAfter.toISOString()
      : lastUpdatedAfter;

    return this.getOrders({
      lastUpdatedAfter: since,
      marketplaceIds: options.marketplaceIds || getAllMarketplaceIds(),
      maxResultsPerPage: options.maxResultsPerPage || 100
    });
  }

  /**
   * Get all orders with pagination
   * @param {Object} params - Query parameters
   */
  async getAllOrders(params = {}) {
    const allOrders = [];
    let nextToken = null;
    let hasMore = true;

    while (hasMore) {
      const queryParams = {
        ...params,
        ...(nextToken && { nextToken })
      };

      const response = await this.getOrders(queryParams);

      if (response.Orders && response.Orders.length > 0) {
        allOrders.push(...response.Orders);
      }

      nextToken = response.NextToken;
      hasMore = !!nextToken;

      // Safety limit
      if (allOrders.length > 1000) {
        console.warn('SellerClient: Reached 1000 order limit, stopping pagination');
        break;
      }
    }

    return allOrders;
  }

  /**
   * Get order with full details including items
   * @param {string} orderId - Amazon Order ID
   */
  async getOrderWithItems(orderId) {
    const [orderResponse, items] = await Promise.all([
      this.getOrder(orderId),
      this.getAllOrderItems(orderId)
    ]);

    return {
      ...orderResponse,
      OrderItems: items
    };
  }

  /**
   * Test connection by fetching recent orders
   */
  async testConnection() {
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    try {
      const result = await this.getOrders({
        lastUpdatedAfter: oneDayAgo.toISOString(),
        maxResultsPerPage: 1
      });

      return {
        success: true,
        message: 'Connection successful',
        ordersFound: result.Orders?.length || 0
      };
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  }

  // ==================== SHIPMENT CONFIRMATION ====================

  /**
   * Confirm shipment for an FBM order (push tracking to Amazon)
   * Uses the Orders API confirmShipment operation
   * @param {string} orderId - Amazon Order ID
   * @param {string} marketplaceId - Marketplace ID
   * @param {Object} packageDetail - Package details with tracking info
   */
  async confirmShipment(orderId, marketplaceId, packageDetail) {
    const client = await this.getClient();

    try {
      const response = await client.callAPI({
        operation: 'orders.confirmShipment',
        path: {
          orderId
        },
        body: {
          marketplaceId,
          packageDetail
        }
      });

      return { success: true, response };

    } catch (error) {
      console.error(`[SellerClient] confirmShipment error for ${orderId}:`, error.message);

      // Parse specific error types
      if (error.message.includes('InvalidInput')) {
        return { success: false, error: 'Invalid input: ' + error.message };
      }
      if (error.message.includes('InvalidOrderState')) {
        return { success: false, error: 'Invalid order state - order may already be shipped or cancelled' };
      }
      if (error.message.includes('OrderAlreadyShipped')) {
        return { success: false, error: 'Order already shipped', alreadyShipped: true };
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Update order shipment (alternative method using updateShipmentStatus)
   * @param {string} orderId - Amazon Order ID
   * @param {string} marketplaceId - Marketplace ID
   * @param {string} shipmentStatus - Status: "ReadyForPickup" or "PickedUp"
   */
  async updateShipmentStatus(orderId, marketplaceId, shipmentStatus) {
    const client = await this.getClient();

    try {
      const response = await client.callAPI({
        operation: 'orders.updateShipmentStatus',
        path: {
          orderId
        },
        body: {
          marketplaceId,
          shipmentStatus
        }
      });

      return { success: true, response };
    } catch (error) {
      console.error(`[SellerClient] updateShipmentStatus error for ${orderId}:`, error.message);
      return { success: false, error: error.message };
    }
  }
}

// Singleton instance
let sellerClientInstance = null;

/**
 * Get the singleton SellerClient instance
 */
function getSellerClient() {
  if (!sellerClientInstance) {
    sellerClientInstance = new SellerClient();
  }
  return sellerClientInstance;
}

module.exports = {
  SellerClient,
  getSellerClient
};
