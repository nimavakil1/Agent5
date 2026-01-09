/**
 * SellerOrderImporter - Import Amazon Seller Central Orders
 *
 * Handles:
 * - Polling orders from Amazon SP-API
 * - Storing orders in unified_orders MongoDB collection
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
  getWarehouseId: _getWarehouseId,
  getOrderPrefix: _getOrderPrefix,
  FULFILLMENT_CHANNELS: _FULFILLMENT_CHANNELS,
  getAllMarketplaceIds
} = require('./SellerMarketplaceConfig');
const { getUnifiedOrderService, CHANNELS, SUB_CHANNELS } = require('../../orders/UnifiedOrderService');
const { transformAmazonApiOrder, getMarketplaceCountry } = require('../../orders/transformers/SellerOrderTransformer');

// Collection name - uses unified_orders now
const COLLECTION_NAME = 'unified_orders';

// Historical cutoff date - orders before this won't auto-import to Odoo
const HISTORICAL_CUTOFF = new Date('2024-01-01T00:00:00Z');

/**
 * SellerOrderImporter - Core order import logic
 */
class SellerOrderImporter {
  constructor() {
    this.client = null;
    this.unifiedService = null;
    this.collection = null;  // Direct collection access for complex queries
    this.lastPollTime = null;
    this.isPolling = false;
  }

  /**
   * Initialize the importer
   */
  async init() {
    if (this.client && this.unifiedService) return;

    this.client = getSellerClient();
    await this.client.init();

    // Initialize unified order service
    this.unifiedService = getUnifiedOrderService();
    await this.unifiedService.init();

    // Direct collection access for complex queries
    const db = getDb();
    this.collection = db.collection(COLLECTION_NAME);
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
          includePII: true,  // Request buyer name and shipping address via RDT
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
        channel: CHANNELS.AMAZON_SELLER,
        'amazonSeller.itemsFetched': { $ne: true },
        'sourceIds.amazonOrderId': { $in: allOrders.map(o => o.AmazonOrderId) }
      }).limit(50).toArray();

      for (const order of ordersNeedingItems) {
        try {
          await this.fetchOrderItems(order.sourceIds.amazonOrderId);
          result.itemsFetched++;
        } catch (error) {
          console.error(`[SellerOrderImporter] Error fetching items for ${order.sourceIds.amazonOrderId}:`, error.message);
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
   * Upsert an order to MongoDB (unified_orders collection)
   * @param {Object} amazonOrder - Order from Amazon API
   */
  async upsertOrder(amazonOrder) {
    // Transform Amazon API order to unified format
    const unifiedOrder = transformAmazonApiOrder(amazonOrder, []);  // Items fetched separately

    // Preserve existing Odoo data if updating
    const existing = await this.unifiedService.getByAmazonOrderId(amazonOrder.AmazonOrderId);
    if (existing) {
      // Preserve Odoo link data
      if (existing.odoo) {
        unifiedOrder.odoo = existing.odoo;
        unifiedOrder.sourceIds.odooSaleOrderId = existing.sourceIds.odooSaleOrderId;
        unifiedOrder.sourceIds.odooSaleOrderName = existing.sourceIds.odooSaleOrderName;
      }
      // Preserve imported items if already fetched
      if (existing.items && existing.items.length > 0) {
        unifiedOrder.items = existing.items;
        unifiedOrder.amazonSeller.itemsFetched = true;
      }
      // Preserve original import date
      unifiedOrder.createdAt = existing.createdAt;
    }

    // Upsert to unified_orders
    const result = await this.unifiedService.upsert(unifiedOrder.unifiedOrderId, unifiedOrder);

    return result;
  }

  /**
   * Fetch and store order items
   * @param {string} amazonOrderId - Amazon Order ID
   */
  async fetchOrderItems(amazonOrderId) {
    await this.init();

    const rawItems = await this.client.getAllOrderItems(amazonOrderId);

    // Transform items to unified format, filtering out promotion/discount items
    // @type {import('./SellerOrderSchema').AmazonOrderItem[]}
    // IMPORTANT: Use 'quantity' field (not 'quantityOrdered') - see SellerOrderSchema.js
    const items = rawItems
      .filter(item => {
        // Skip promotion/discount items
        const sku = item.SellerSKU || '';
        const qty = item.QuantityOrdered || 0;
        const price = parseFloat(item.ItemPrice?.Amount) || 0;

        // Skip items with zero quantity
        if (qty === 0) {
          console.log(`[SellerOrderImporter] Skipping zero-qty item: SKU=${sku}`);
          return false;
        }

        // Skip items that look like promotion codes (alphanumeric, 5-10 chars, ends with letter, has letters and numbers)
        const isAlphanumericOnly = /^[A-Z0-9]+$/i.test(sku);
        const hasNoDashes = !sku.includes('-') && !sku.includes('_');
        const length5to10 = sku.length >= 5 && sku.length <= 10;
        const endsWithLetter = /[A-Za-z]$/.test(sku);
        const hasLettersAndNumbers = /[A-Za-z]/.test(sku) && /[0-9]/.test(sku);

        if (isAlphanumericOnly && hasNoDashes && length5to10 && endsWithLetter && hasLettersAndNumbers && price <= 0) {
          console.log(`[SellerOrderImporter] Skipping promotion item: SKU=${sku}, price=${price}`);
          return false;
        }

        return true;
      })
      .map(item => {
        const itemPrice = parseFloat(item.ItemPrice?.Amount) || 0;
        const itemTax = parseFloat(item.ItemTax?.Amount) || 0;
        const qty = item.QuantityOrdered || 1;

        return {
          sku: item.SellerSKU,
          sellerSku: item.SellerSKU, // Alias for compatibility
          asin: item.ASIN,
          ean: null,
          name: item.Title,
          title: item.Title, // Alias for compatibility
          quantity: qty, // ALWAYS use 'quantity', never 'quantityOrdered'
          quantityShipped: item.QuantityShipped || 0,
          unitPrice: itemPrice / qty,
          lineTotal: itemPrice,
          tax: itemTax,
          orderItemId: item.OrderItemId
        };
      });

    // Calculate totals
    let subtotal = 0;
    let taxTotal = 0;
    items.forEach(item => {
      subtotal += item.lineTotal;
      taxTotal += item.tax;
    });

    // Get the unified order ID for this amazon order
    const unifiedOrderId = `${CHANNELS.AMAZON_SELLER}:${amazonOrderId}`;

    // Update order with items in unified collection
    await this.collection.updateOne(
      { unifiedOrderId },
      {
        $set: {
          items,
          'totals.subtotal': subtotal,
          'totals.tax': taxTotal,
          'amazonSeller.itemsFetched': true,
          updatedAt: new Date()
        }
      }
    );

    return items;
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
            marketplaceIds: getAllMarketplaceIds(),
            includePII: true  // Request buyer name and shipping address via RDT
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
   * Get orders from MongoDB (unified_orders collection)
   * @param {Object} filters - Query filters
   * @param {Object} options - Query options
   */
  async getOrders(filters = {}, options = {}) {
    await this.init();

    const query = this.buildQuery(filters);
    const limit = options.limit || 50;
    const skip = options.skip || 0;

    return this.collection.find(query)
      .sort({ orderDate: -1 })
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
    return this.unifiedService.getByAmazonOrderId(amazonOrderId);
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
   * Build MongoDB query from filters (for unified_orders collection)
   */
  buildQuery(filters) {
    // Always filter to Amazon Seller channel
    const query = {
      channel: CHANNELS.AMAZON_SELLER
    };

    if (filters.orderId) {
      query['sourceIds.amazonOrderId'] = { $regex: filters.orderId, $options: 'i' };
    }

    if (filters.customer) {
      query.$or = [
        { 'shippingAddress.name': { $regex: filters.customer, $options: 'i' } },
        { 'customer.name': { $regex: filters.customer, $options: 'i' } }
      ];
    }

    if (filters.marketplace) {
      query['marketplace.code'] = filters.marketplace;
    }

    if (filters.marketplaceId) {
      query['marketplace.id'] = filters.marketplaceId;
    }

    if (filters.status) {
      // Support comma-separated values (e.g., "Unshipped,Shipped")
      if (filters.status.includes(',')) {
        query['status.source'] = { $in: filters.status.split(',') };
      }
      // Support negation with ! prefix (e.g., "!Pending" means not Pending)
      else if (filters.status.startsWith('!')) {
        query['status.source'] = { $ne: filters.status.substring(1) };
      } else {
        query['status.source'] = filters.status;
      }
    }

    if (filters.fulfillmentChannel) {
      query['amazonSeller.fulfillmentChannel'] = filters.fulfillmentChannel;
    }

    if (filters.hasOdooOrder !== undefined) {
      if (filters.hasOdooOrder) {
        query['sourceIds.odooSaleOrderId'] = { $ne: null };
      } else {
        query['sourceIds.odooSaleOrderId'] = null;
      }
    }

    if (filters.autoImportEligible !== undefined) {
      query['amazonSeller.autoImportEligible'] = filters.autoImportEligible;
    }

    if (filters.dateFrom || filters.dateTo) {
      query.orderDate = {};
      if (filters.dateFrom) {
        query.orderDate.$gte = new Date(filters.dateFrom);
      }
      if (filters.dateTo) {
        query.orderDate.$lte = new Date(filters.dateTo);
      }
    }

    return query;
  }

  /**
   * Get orders pending Odoo creation
   * Only returns orders that can be auto-imported:
   * - FBA orders (AFN) - can use generic customers since Amazon handles fulfillment
   * - FBM orders (MFN) with complete shipping address (name + street)
   *
   * FBM orders without complete addresses should be imported via TSV upload
   *
   * @param {number} limit - Max orders to return
   */
  async getPendingOdooOrders(limit = 50) {
    await this.init();

    return this.collection.find({
      channel: CHANNELS.AMAZON_SELLER,
      'sourceIds.odooSaleOrderId': null,
      'amazonSeller.autoImportEligible': true,
      'status.source': { $in: ['Unshipped', 'Shipped', 'PartiallyShipped'] },
      'amazonSeller.itemsFetched': true,
      // Only auto-import if:
      // 1. FBA order (AFN) - Amazon handles fulfillment, generic customer OK
      // 2. FBM order (MFN) with complete address (name AND street must exist)
      $or: [
        { 'amazonSeller.fulfillmentChannel': 'AFN' },  // FBA orders always eligible
        {
          'amazonSeller.fulfillmentChannel': 'MFN',
          'shippingAddress.name': { $exists: true, $nin: [null, ''] },
          'shippingAddress.street': { $exists: true, $nin: [null, ''] }
        }
      ]
    })
      .sort({ orderDate: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Get FBM orders that need manual import via TSV
   * These are FBM orders without complete shipping addresses
   * @param {number} limit - Max orders to return
   */
  async getFbmOrdersPendingManualImport(limit = 100) {
    await this.init();

    return this.collection.find({
      channel: CHANNELS.AMAZON_SELLER,
      'sourceIds.odooSaleOrderId': null,
      'amazonSeller.autoImportEligible': true,
      'amazonSeller.fulfillmentChannel': 'MFN',
      'status.source': { $in: ['Unshipped', 'Shipped', 'PartiallyShipped'] },
      'amazonSeller.itemsFetched': true,
      // Missing name OR missing street
      $or: [
        { 'shippingAddress.name': { $in: [null, ''] } },
        { 'shippingAddress.name': { $exists: false } },
        { 'shippingAddress.street': { $in: [null, ''] } },
        { 'shippingAddress.street': { $exists: false } }
      ]
    })
      .sort({ orderDate: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Count FBM orders pending manual import
   * Used for displaying badge/notification in UI
   * @returns {Object} { count, orderIds } - Count and list of Amazon order IDs
   */
  async countFbmOrdersPendingManualImport() {
    await this.init();

    const query = {
      channel: CHANNELS.AMAZON_SELLER,
      'sourceIds.odooSaleOrderId': null,
      'amazonSeller.autoImportEligible': true,
      'amazonSeller.fulfillmentChannel': 'MFN',
      'status.source': { $in: ['Unshipped', 'Shipped', 'PartiallyShipped'] },
      'amazonSeller.itemsFetched': true,
      $or: [
        { 'shippingAddress.name': { $in: [null, ''] } },
        { 'shippingAddress.name': { $exists: false } },
        { 'shippingAddress.street': { $in: [null, ''] } },
        { 'shippingAddress.street': { $exists: false } }
      ]
    };

    // Get both count and order IDs
    const orders = await this.collection.find(query)
      .project({ 'sourceIds.amazonOrderId': 1 })
      .sort({ orderDate: -1 })
      .limit(50) // Limit to 50 for display
      .toArray();

    return {
      count: orders.length,
      orderIds: orders.map(o => o.sourceIds.amazonOrderId)
    };
  }

  /**
   * Update Odoo order info for an order
   * @param {string} amazonOrderId - Amazon Order ID
   * @param {Object} odooInfo - Odoo order info (can include partnerName to update UI display)
   */
  async updateOdooInfo(amazonOrderId, odooInfo) {
    await this.init();

    const unifiedOrderId = `${CHANNELS.AMAZON_SELLER}:${amazonOrderId}`;

    const updateData = {
      'sourceIds.odooSaleOrderId': odooInfo.saleOrderId || null,
      'sourceIds.odooSaleOrderName': odooInfo.saleOrderName || null,
      'odoo.saleOrderId': odooInfo.saleOrderId || null,
      'odoo.saleOrderName': odooInfo.saleOrderName || null,
      'odoo.partnerId': odooInfo.partnerId || null,
      'odoo.partnerName': odooInfo.partnerName || null,
      'odoo.state': odooInfo.state || null,
      'odoo.invoiceStatus': odooInfo.invoiceStatus || null,
      'odoo.syncedAt': new Date(),
      'odoo.syncError': odooInfo.syncError || null,
      updatedAt: new Date()
    };

    // If partner name is provided, update the customer display fields
    if (odooInfo.partnerName) {
      updateData['customer.name'] = odooInfo.partnerName;
      updateData['customer.odooPartnerId'] = odooInfo.partnerId;
      updateData['customer.odooPartnerName'] = odooInfo.partnerName;
      updateData['shippingAddress.name'] = odooInfo.partnerName;
    }

    return this.collection.updateOne(
      { unifiedOrderId },
      { $set: updateData }
    );
  }

  /**
   * Get import statistics
   */
  async getStats() {
    await this.init();

    // All queries filtered to Amazon Seller channel
    const baseFilter = { channel: CHANNELS.AMAZON_SELLER };

    const [
      total,
      pendingOdoo,
      withOdoo,
      fba,
      fbm,
      byStatus
    ] = await Promise.all([
      this.collection.countDocuments(baseFilter),
      this.collection.countDocuments({
        ...baseFilter,
        'sourceIds.odooSaleOrderId': null,
        'amazonSeller.autoImportEligible': true
      }),
      this.collection.countDocuments({
        ...baseFilter,
        'sourceIds.odooSaleOrderId': { $ne: null }
      }),
      this.collection.countDocuments({
        ...baseFilter,
        'amazonSeller.fulfillmentChannel': 'AFN'
      }),
      this.collection.countDocuments({
        ...baseFilter,
        'amazonSeller.fulfillmentChannel': 'MFN'
      }),
      this.collection.aggregate([
        { $match: baseFilter },
        { $group: { _id: '$status.source', count: { $sum: 1 } } }
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
      initialized: !!this.unifiedService
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
