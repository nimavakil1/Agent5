/**
 * SellerOrderImporter - Import Amazon Seller Central Orders
 *
 * Handles:
 * - Polling orders from Amazon SP-API
 * - Storing orders in MongoDB with full item details
 * - Tracking import status and Odoo sync status
 * - Historical import with safeguards
 *
 * @module SellerOrderImporter
 */

const { getDb } = require('../../../db');
const { getSellerClient } = require('./SellerClient');
const {
  getMarketplaceConfig,
  getCountryFromMarketplace,
  getWarehouseId,
  getOrderPrefix,
  FULFILLMENT_CHANNELS,
  getAllMarketplaceIds
} = require('./SellerMarketplaceConfig');

// Collection name for seller orders
const COLLECTION_NAME = 'seller_orders';

// Historical cutoff date - orders before this won't auto-import to Odoo
const HISTORICAL_CUTOFF = new Date('2024-01-01T00:00:00Z');

/**
 * SellerOrderImporter - Core order import logic
 */
class SellerOrderImporter {
  constructor() {
    this.client = null;
    this.collection = null;
    this.lastPollTime = null;
    this.isPolling = false;
  }

  /**
   * Initialize the importer
   */
  async init() {
    if (this.client && this.collection) return;

    this.client = getSellerClient();
    await this.client.init();

    const db = getDb();
    this.collection = db.collection(COLLECTION_NAME);

    // Ensure indexes
    await this.ensureIndexes();
  }

  /**
   * Create MongoDB indexes for efficient querying
   */
  async ensureIndexes() {
    try {
      await this.collection.createIndex({ amazonOrderId: 1 }, { unique: true });
      await this.collection.createIndex({ marketplaceId: 1 });
      await this.collection.createIndex({ purchaseDate: -1 });
      await this.collection.createIndex({ orderStatus: 1 });
      await this.collection.createIndex({ fulfillmentChannel: 1 });
      await this.collection.createIndex({ 'odoo.saleOrderId': 1 });
      await this.collection.createIndex({ autoImportEligible: 1 });
      await this.collection.createIndex({ lastUpdateDate: -1 });
      console.log('[SellerOrderImporter] Indexes ensured');
    } catch (error) {
      console.error('[SellerOrderImporter] Error creating indexes:', error.message);
    }
  }

  /**
   * Poll for new/updated orders since last poll
   * @param {Object} options - Polling options
   * @param {number} options.hoursBack - Hours to look back (default 6)
   * @param {string[]} options.marketplaceIds - Specific marketplaces to poll
   */
  async poll(options = {}) {
    if (this.isPolling) {
      console.log('[SellerOrderImporter] Poll already in progress, skipping');
      return { skipped: true, reason: 'Poll in progress' };
    }

    this.isPolling = true;
    const result = {
      polledAt: new Date(),
      ordersFound: 0,
      ordersUpserted: 0,
      itemsFetched: 0,
      errors: []
    };

    try {
      await this.init();

      // Calculate last updated time
      const hoursBack = options.hoursBack || 6;
      const lastUpdatedAfter = options.lastUpdatedAfter ||
        new Date(Date.now() - hoursBack * 60 * 60 * 1000);

      console.log(`[SellerOrderImporter] Polling orders since ${lastUpdatedAfter.toISOString()}`);

      // Fetch orders from Amazon
      const allOrders = [];
      let nextToken = null;
      let hasMore = true;

      while (hasMore) {
        const response = await this.client.getOrders({
          lastUpdatedAfter: lastUpdatedAfter.toISOString(),
          marketplaceIds: options.marketplaceIds || getAllMarketplaceIds(),
          maxResultsPerPage: 100,
          ...(nextToken && { nextToken })
        });

        if (response.Orders && response.Orders.length > 0) {
          allOrders.push(...response.Orders);
        }

        nextToken = response.NextToken;
        hasMore = !!nextToken;

        // Safety limit
        if (allOrders.length > 2000) {
          console.warn('[SellerOrderImporter] Reached 2000 order limit, stopping pagination');
          break;
        }
      }

      result.ordersFound = allOrders.length;
      console.log(`[SellerOrderImporter] Found ${allOrders.length} orders`);

      // Process each order
      for (const order of allOrders) {
        try {
          await this.upsertOrder(order);
          result.ordersUpserted++;
        } catch (error) {
          result.errors.push({
            orderId: order.AmazonOrderId,
            error: error.message
          });
        }
      }

      // Fetch items for orders that don't have them yet
      const ordersNeedingItems = await this.collection.find({
        itemsFetched: { $ne: true },
        amazonOrderId: { $in: allOrders.map(o => o.AmazonOrderId) }
      }).limit(50).toArray();

      for (const order of ordersNeedingItems) {
        try {
          await this.fetchOrderItems(order.amazonOrderId);
          result.itemsFetched++;
        } catch (error) {
          console.error(`[SellerOrderImporter] Error fetching items for ${order.amazonOrderId}:`, error.message);
        }
      }

      this.lastPollTime = new Date();

    } catch (error) {
      result.errors.push({ error: error.message });
      console.error('[SellerOrderImporter] Poll error:', error);
    } finally {
      this.isPolling = false;
    }

    return result;
  }

  /**
   * Upsert an order to MongoDB
   * @param {Object} amazonOrder - Order from Amazon API
   */
  async upsertOrder(amazonOrder) {
    const marketplaceConfig = getMarketplaceConfig(amazonOrder.MarketplaceId);
    const purchaseDate = new Date(amazonOrder.PurchaseDate);

    // Determine if order is eligible for auto-import to Odoo
    const autoImportEligible = purchaseDate >= HISTORICAL_CUTOFF;

    const orderDoc = {
      amazonOrderId: amazonOrder.AmazonOrderId,
      marketplaceId: amazonOrder.MarketplaceId,
      marketplaceCountry: marketplaceConfig?.country || getCountryFromMarketplace(amazonOrder.MarketplaceId),
      orderStatus: amazonOrder.OrderStatus,
      fulfillmentChannel: amazonOrder.FulfillmentChannel,
      purchaseDate: purchaseDate,
      lastUpdateDate: new Date(amazonOrder.LastUpdateDate),

      // Buyer info
      buyerEmail: amazonOrder.BuyerInfo?.BuyerEmail || null,
      buyerName: amazonOrder.BuyerInfo?.BuyerName || null,

      // Shipping address (if available)
      shippingAddress: amazonOrder.ShippingAddress ? {
        name: amazonOrder.ShippingAddress.Name,
        addressLine1: amazonOrder.ShippingAddress.AddressLine1,
        addressLine2: amazonOrder.ShippingAddress.AddressLine2 || null,
        city: amazonOrder.ShippingAddress.City,
        stateOrRegion: amazonOrder.ShippingAddress.StateOrRegion,
        postalCode: amazonOrder.ShippingAddress.PostalCode,
        countryCode: amazonOrder.ShippingAddress.CountryCode,
        phone: amazonOrder.ShippingAddress.Phone || null
      } : null,

      // Financial
      orderTotal: amazonOrder.OrderTotal ? {
        currencyCode: amazonOrder.OrderTotal.CurrencyCode,
        amount: amazonOrder.OrderTotal.Amount
      } : null,

      // Order metadata
      salesChannel: amazonOrder.SalesChannel,
      orderChannel: amazonOrder.OrderChannel,
      shipServiceLevel: amazonOrder.ShipServiceLevel,
      shipmentServiceLevelCategory: amazonOrder.ShipmentServiceLevelCategory,
      isPrime: amazonOrder.IsPrime || false,
      isBusinessOrder: amazonOrder.IsBusinessOrder || false,
      isPremiumOrder: amazonOrder.IsPremiumOrder || false,
      isGlobalExpressEnabled: amazonOrder.IsGlobalExpressEnabled || false,

      // Tracking
      autoImportEligible,
      updatedAt: new Date()
    };

    // Upsert to MongoDB
    const result = await this.collection.updateOne(
      { amazonOrderId: amazonOrder.AmazonOrderId },
      {
        $set: orderDoc,
        $setOnInsert: {
          importedAt: new Date(),
          itemsFetched: false,
          odoo: {
            partnerId: null,
            saleOrderId: null,
            saleOrderName: null,
            invoiceId: null,
            invoiceName: null,
            pickingId: null,
            createdAt: null,
            syncError: null
          }
        }
      },
      { upsert: true }
    );

    return result;
  }

  /**
   * Fetch and store order items
   * @param {string} amazonOrderId - Amazon Order ID
   */
  async fetchOrderItems(amazonOrderId) {
    await this.init();

    const items = await this.client.getAllOrderItems(amazonOrderId);

    const formattedItems = items.map(item => ({
      orderItemId: item.OrderItemId,
      asin: item.ASIN,
      sellerSku: item.SellerSKU,
      title: item.Title,
      quantityOrdered: item.QuantityOrdered,
      quantityShipped: item.QuantityShipped || 0,
      itemPrice: item.ItemPrice ? {
        currencyCode: item.ItemPrice.CurrencyCode,
        amount: item.ItemPrice.Amount
      } : null,
      itemTax: item.ItemTax ? {
        currencyCode: item.ItemTax.CurrencyCode,
        amount: item.ItemTax.Amount
      } : null,
      shippingPrice: item.ShippingPrice ? {
        currencyCode: item.ShippingPrice.CurrencyCode,
        amount: item.ShippingPrice.Amount
      } : null,
      shippingTax: item.ShippingTax ? {
        currencyCode: item.ShippingTax.CurrencyCode,
        amount: item.ShippingTax.Amount
      } : null,
      promotionDiscount: item.PromotionDiscount ? {
        currencyCode: item.PromotionDiscount.CurrencyCode,
        amount: item.PromotionDiscount.Amount
      } : null,
      shippingDiscount: item.ShippingDiscount ? {
        currencyCode: item.ShippingDiscount.CurrencyCode,
        amount: item.ShippingDiscount.Amount
      } : null,
      isGift: item.IsGift || false,
      conditionNote: item.ConditionNote || null,
      conditionId: item.ConditionId || null,
      conditionSubtypeId: item.ConditionSubtypeId || null
    }));

    // Update order with items
    await this.collection.updateOne(
      { amazonOrderId },
      {
        $set: {
          items: formattedItems,
          itemsFetched: true,
          itemsFetchedAt: new Date()
        }
      }
    );

    return formattedItems;
  }

  /**
   * Import historical orders from a specific date
   * @param {Date} fromDate - Start date
   * @param {Date} toDate - End date (default: now)
   */
  async importHistorical(fromDate, toDate = new Date()) {
    await this.init();

    const result = {
      startedAt: new Date(),
      fromDate,
      toDate,
      ordersFound: 0,
      ordersUpserted: 0,
      errors: []
    };

    console.log(`[SellerOrderImporter] Historical import from ${fromDate.toISOString()} to ${toDate.toISOString()}`);

    try {
      // Amazon API allows max 3 months at a time, but we'll chunk by week for reliability
      const oneWeek = 7 * 24 * 60 * 60 * 1000;
      let currentStart = new Date(fromDate);

      while (currentStart < toDate) {
        const currentEnd = new Date(Math.min(currentStart.getTime() + oneWeek, toDate.getTime()));

        console.log(`[SellerOrderImporter] Fetching ${currentStart.toISOString()} to ${currentEnd.toISOString()}`);

        try {
          const orders = await this.client.getAllOrders({
            createdAfter: currentStart.toISOString(),
            createdBefore: currentEnd.toISOString(),
            marketplaceIds: getAllMarketplaceIds()
          });

          result.ordersFound += orders.length;

          for (const order of orders) {
            try {
              await this.upsertOrder(order);
              result.ordersUpserted++;
            } catch (error) {
              result.errors.push({
                orderId: order.AmazonOrderId,
                error: error.message
              });
            }
          }

          // Rate limiting - wait between chunks
          await new Promise(r => setTimeout(r, 2000));

        } catch (error) {
          result.errors.push({
            period: `${currentStart.toISOString()} - ${currentEnd.toISOString()}`,
            error: error.message
          });
        }

        currentStart = currentEnd;
      }

    } catch (error) {
      result.errors.push({ error: error.message });
    }

    result.completedAt = new Date();
    return result;
  }

  // ==================== QUERY METHODS ====================

  /**
   * Get orders from MongoDB
   * @param {Object} filters - Query filters
   * @param {Object} options - Query options
   */
  async getOrders(filters = {}, options = {}) {
    await this.init();

    const query = this.buildQuery(filters);
    const limit = options.limit || 50;
    const skip = options.skip || 0;

    return this.collection.find(query)
      .sort({ purchaseDate: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
  }

  /**
   * Get a single order
   * @param {string} amazonOrderId - Amazon Order ID
   */
  async getOrder(amazonOrderId) {
    await this.init();
    return this.collection.findOne({ amazonOrderId });
  }

  /**
   * Count orders matching filters
   * @param {Object} filters - Query filters
   */
  async countOrders(filters = {}) {
    await this.init();
    const query = this.buildQuery(filters);
    return this.collection.countDocuments(query);
  }

  /**
   * Build MongoDB query from filters
   */
  buildQuery(filters) {
    const query = {};

    if (filters.orderId) {
      query.amazonOrderId = { $regex: filters.orderId, $options: 'i' };
    }

    if (filters.customer) {
      query.$or = [
        { 'shippingAddress.name': { $regex: filters.customer, $options: 'i' } },
        { buyerName: { $regex: filters.customer, $options: 'i' } }
      ];
    }

    if (filters.marketplace) {
      query.marketplaceCountry = filters.marketplace;
    }

    if (filters.marketplaceId) {
      query.marketplaceId = filters.marketplaceId;
    }

    if (filters.status) {
      query.orderStatus = filters.status;
    }

    if (filters.fulfillmentChannel) {
      query.fulfillmentChannel = filters.fulfillmentChannel;
    }

    if (filters.hasOdooOrder !== undefined) {
      if (filters.hasOdooOrder) {
        query['odoo.saleOrderId'] = { $ne: null };
      } else {
        query['odoo.saleOrderId'] = null;
      }
    }

    if (filters.autoImportEligible !== undefined) {
      query.autoImportEligible = filters.autoImportEligible;
    }

    if (filters.dateFrom || filters.dateTo) {
      query.purchaseDate = {};
      if (filters.dateFrom) {
        query.purchaseDate.$gte = new Date(filters.dateFrom);
      }
      if (filters.dateTo) {
        query.purchaseDate.$lte = new Date(filters.dateTo);
      }
    }

    return query;
  }

  /**
   * Get orders pending Odoo creation
   * Orders that are eligible for auto-import but don't have Odoo orders yet
   * @param {number} limit - Max orders to return
   */
  async getPendingOdooOrders(limit = 50) {
    await this.init();

    return this.collection.find({
      'odoo.saleOrderId': null,
      autoImportEligible: true,
      orderStatus: { $in: ['Unshipped', 'Shipped', 'PartiallyShipped'] },
      itemsFetched: true
    })
      .sort({ purchaseDate: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Update Odoo order info for an order
   * @param {string} amazonOrderId - Amazon Order ID
   * @param {Object} odooInfo - Odoo order info
   */
  async updateOdooInfo(amazonOrderId, odooInfo) {
    await this.init();

    return this.collection.updateOne(
      { amazonOrderId },
      {
        $set: {
          'odoo.partnerId': odooInfo.partnerId || null,
          'odoo.saleOrderId': odooInfo.saleOrderId || null,
          'odoo.saleOrderName': odooInfo.saleOrderName || null,
          'odoo.invoiceId': odooInfo.invoiceId || null,
          'odoo.invoiceName': odooInfo.invoiceName || null,
          'odoo.pickingId': odooInfo.pickingId || null,
          'odoo.createdAt': odooInfo.createdAt || new Date(),
          'odoo.syncError': odooInfo.syncError || null,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Get import statistics
   */
  async getStats() {
    await this.init();

    const [
      total,
      pendingOdoo,
      withOdoo,
      fba,
      fbm,
      byStatus
    ] = await Promise.all([
      this.collection.countDocuments({}),
      this.collection.countDocuments({ 'odoo.saleOrderId': null, autoImportEligible: true }),
      this.collection.countDocuments({ 'odoo.saleOrderId': { $ne: null } }),
      this.collection.countDocuments({ fulfillmentChannel: 'AFN' }),
      this.collection.countDocuments({ fulfillmentChannel: 'MFN' }),
      this.collection.aggregate([
        { $group: { _id: '$orderStatus', count: { $sum: 1 } } }
      ]).toArray()
    ]);

    const statusCounts = {};
    byStatus.forEach(s => { statusCounts[s._id] = s.count; });

    return {
      total,
      pendingOdoo,
      withOdoo,
      fba,
      fbm,
      byStatus: statusCounts,
      lastPollTime: this.lastPollTime
    };
  }

  /**
   * Get status (for scheduler monitoring)
   */
  getStatus() {
    return {
      isPolling: this.isPolling,
      lastPollTime: this.lastPollTime,
      initialized: !!this.collection
    };
  }
}

// Singleton instance
let sellerOrderImporterInstance = null;

/**
 * Get the singleton SellerOrderImporter instance
 */
async function getSellerOrderImporter() {
  if (!sellerOrderImporterInstance) {
    sellerOrderImporterInstance = new SellerOrderImporter();
    await sellerOrderImporterInstance.init();
  }
  return sellerOrderImporterInstance;
}

module.exports = {
  SellerOrderImporter,
  getSellerOrderImporter,
  COLLECTION_NAME,
  HISTORICAL_CUTOFF
};
