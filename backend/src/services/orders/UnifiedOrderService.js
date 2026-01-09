/**
 * UnifiedOrderService - Single source of truth for all sales orders
 *
 * Consolidates orders from:
 * - Amazon Seller (FBA/FBM)
 * - Amazon Vendor
 * - Bol.com (FBB/FBR)
 * - Shopware/Direct sales
 *
 * @module UnifiedOrderService
 */

const { getDb } = require('../../db');

// Channel constants
const CHANNELS = {
  AMAZON_SELLER: 'amazon-seller',
  AMAZON_VENDOR: 'amazon-vendor',
  BOL: 'bol',
  ODOO_DIRECT: 'odoo-direct'
};

const SUB_CHANNELS = {
  FBA: 'FBA',
  FBM: 'FBM',
  FBB: 'FBB',
  FBR: 'FBR',
  VENDOR: 'VENDOR',
  DIRECT: 'DIRECT'
};

// Unified status mapping
const UNIFIED_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  RETURNED: 'returned'
};

// Status mapping from source systems
const STATUS_MAP = {
  // Amazon Seller
  'Pending': UNIFIED_STATUS.PENDING,
  'Unshipped': UNIFIED_STATUS.CONFIRMED,
  'PartiallyShipped': UNIFIED_STATUS.PROCESSING,
  'Shipped': UNIFIED_STATUS.SHIPPED,
  'Cancelled': UNIFIED_STATUS.CANCELLED,
  'Canceled': UNIFIED_STATUS.CANCELLED,

  // Amazon Vendor
  'New': UNIFIED_STATUS.PENDING,
  'Acknowledged': UNIFIED_STATUS.CONFIRMED,
  'Closed': UNIFIED_STATUS.SHIPPED,

  // Bol.com
  'OPEN': UNIFIED_STATUS.CONFIRMED,
  'PARTIAL': UNIFIED_STATUS.PROCESSING,
  'SHIPPED': UNIFIED_STATUS.SHIPPED,
  'CANCELLED': UNIFIED_STATUS.CANCELLED,

  // Odoo
  'draft': UNIFIED_STATUS.PENDING,
  'sent': UNIFIED_STATUS.PENDING,
  'sale': UNIFIED_STATUS.CONFIRMED,
  'done': UNIFIED_STATUS.SHIPPED,
  'cancel': UNIFIED_STATUS.CANCELLED
};

const COLLECTION_NAME = 'unified_orders';

/**
 * Singleton instance
 */
let instance = null;

class UnifiedOrderService {
  constructor() {
    this.db = null;
    this.collection = null;
    this.initialized = false;
  }

  /**
   * Initialize the service and create indexes
   */
  async init() {
    if (this.initialized) return this;

    this.db = getDb();
    this.collection = this.db.collection(COLLECTION_NAME);

    // Create indexes
    await this._createIndexes();
    this.initialized = true;

    console.log('[UnifiedOrderService] Initialized');
    return this;
  }

  /**
   * Create required indexes
   */
  async _createIndexes() {
    const indexes = [
      // Primary unique key
      { key: { unifiedOrderId: 1 }, unique: true },

      // Source ID lookups
      { key: { 'sourceIds.amazonOrderId': 1 }, sparse: true },
      { key: { 'sourceIds.amazonVendorPONumber': 1 }, sparse: true },
      { key: { 'sourceIds.bolOrderId': 1 }, sparse: true },
      { key: { 'sourceIds.odooSaleOrderId': 1 }, sparse: true },
      { key: { 'sourceIds.odooSaleOrderName': 1 }, sparse: true },

      // Channel + date queries
      { key: { channel: 1, orderDate: -1 } },
      { key: { subChannel: 1, orderDate: -1 } },

      // Status queries
      { key: { 'status.unified': 1 } },
      { key: { 'odoo.state': 1 } },

      // Customer lookups
      { key: { 'customer.odooPartnerId': 1 }, sparse: true },

      // Date range queries
      { key: { orderDate: -1 } },
      { key: { createdAt: -1 } },
      { key: { updatedAt: -1 } },

      // Ship-by deadline queries (for ship-by overview)
      { key: { shippingDeadline: 1 }, sparse: true },
      { key: { channel: 1, subChannel: 1, shippingDeadline: 1 }, sparse: true },

      // B2B order queries
      { key: { isBusinessOrder: 1 }, sparse: true },

      // TSV import tracking
      { key: { 'tsvImport.importedAt': -1 }, sparse: true },
      { key: { 'tsvImport.fileName': 1 }, sparse: true }
    ];

    for (const index of indexes) {
      try {
        await this.collection.createIndex(index.key, {
          unique: index.unique || false,
          sparse: index.sparse || false,
          background: true
        });
      } catch (err) {
        // Ignore duplicate index errors
        if (err.code !== 85 && err.code !== 86) {
          console.error(`[UnifiedOrderService] Error creating index:`, err);
        }
      }
    }
  }

  /**
   * Generate unified order ID from channel and source ID
   */
  generateUnifiedOrderId(channel, sourceId) {
    return `${channel}:${sourceId}`;
  }

  /**
   * Map source status to unified status
   */
  mapStatus(sourceStatus) {
    return STATUS_MAP[sourceStatus] || UNIFIED_STATUS.PENDING;
  }

  // ============================================
  // Core CRUD Operations
  // ============================================

  /**
   * Get order by unified ID
   */
  async getByUnifiedId(unifiedOrderId) {
    await this.init();
    return this.collection.findOne({ unifiedOrderId });
  }

  /**
   * Get order by Amazon order ID
   */
  async getByAmazonOrderId(amazonOrderId) {
    await this.init();
    return this.collection.findOne({ 'sourceIds.amazonOrderId': amazonOrderId });
  }

  /**
   * Get order by Amazon Vendor PO number
   */
  async getByVendorPONumber(poNumber) {
    await this.init();
    return this.collection.findOne({ 'sourceIds.amazonVendorPONumber': poNumber });
  }

  /**
   * Get order by Bol order ID
   */
  async getByBolOrderId(bolOrderId) {
    await this.init();
    return this.collection.findOne({ 'sourceIds.bolOrderId': bolOrderId });
  }

  /**
   * Get order by Odoo sale order ID
   */
  async getByOdooSaleOrderId(odooId) {
    await this.init();
    return this.collection.findOne({ 'sourceIds.odooSaleOrderId': odooId });
  }

  /**
   * Get order by Odoo sale order name
   */
  async getByOdooSaleOrderName(name) {
    await this.init();
    return this.collection.findOne({ 'sourceIds.odooSaleOrderName': name });
  }

  /**
   * Upsert an order
   */
  async upsert(unifiedOrderId, orderData) {
    await this.init();

    const now = new Date();

    // Remove timestamp fields from data - we handle these separately
    // to avoid MongoDB $set/$setOnInsert conflict
    const { createdAt, updatedAt, ...dataWithoutTimestamps } = orderData;

    const update = {
      $set: {
        ...dataWithoutTimestamps,
        unifiedOrderId,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: createdAt || now  // Preserve original createdAt on insert
      }
    };

    const result = await this.collection.updateOne(
      { unifiedOrderId },
      update,
      { upsert: true }
    );

    return {
      unifiedOrderId,
      upserted: result.upsertedCount > 0,
      modified: result.modifiedCount > 0
    };
  }

  /**
   * Update Odoo data for an order
   */
  async updateOdooData(unifiedOrderId, odooData) {
    await this.init();

    const result = await this.collection.updateOne(
      { unifiedOrderId },
      {
        $set: {
          odoo: {
            ...odooData,
            syncedAt: new Date()
          },
          'sourceIds.odooSaleOrderId': odooData.saleOrderId,
          'sourceIds.odooSaleOrderName': odooData.saleOrderName,
          updatedAt: new Date()
        }
      }
    );

    return result.modifiedCount > 0;
  }

  /**
   * Update TSV-specific data for an order
   * Used when importing orders via TSV file
   * @param {string} unifiedOrderId - Unified order ID
   * @param {Object} tsvData - TSV-specific data to update
   * @param {Object} tsvData.billingAddress - Billing address from TSV
   * @param {Object} tsvData.addressCleaningResult - AI-cleaned address data
   * @param {boolean} tsvData.isBusinessOrder - B2B order indicator
   * @param {string} tsvData.buyerCompanyName - Company name for B2B orders
   * @param {Object} tsvData.tsvImport - TSV import tracking data
   */
  async updateTsvData(unifiedOrderId, tsvData) {
    await this.init();

    const update = {
      $set: {
        updatedAt: new Date()
      }
    };

    if (tsvData.billingAddress !== undefined) {
      update.$set.billingAddress = tsvData.billingAddress;
    }

    if (tsvData.addressCleaningResult !== undefined) {
      update.$set.addressCleaningResult = tsvData.addressCleaningResult;
    }

    if (tsvData.isBusinessOrder !== undefined) {
      update.$set.isBusinessOrder = tsvData.isBusinessOrder;
    }

    if (tsvData.buyerCompanyName !== undefined) {
      update.$set.buyerCompanyName = tsvData.buyerCompanyName;
    }

    if (tsvData.tsvImport !== undefined) {
      update.$set.tsvImport = tsvData.tsvImport;
    }

    const result = await this.collection.updateOne(
      { unifiedOrderId },
      update
    );

    return result.modifiedCount > 0;
  }

  /**
   * Update status for an order
   */
  async updateStatus(unifiedOrderId, sourceStatus, odooState = null) {
    await this.init();

    const update = {
      $set: {
        'status.unified': this.mapStatus(sourceStatus),
        'status.source': sourceStatus,
        updatedAt: new Date()
      }
    };

    if (odooState) {
      update.$set['status.odoo'] = odooState;
      update.$set['odoo.state'] = odooState;
    }

    const result = await this.collection.updateOne(
      { unifiedOrderId },
      update
    );

    return result.modifiedCount > 0;
  }

  // ============================================
  // Query Operations
  // ============================================

  /**
   * Query orders with filters
   */
  async query(filters = {}, options = {}) {
    await this.init();

    const {
      limit = 50,
      skip = 0,
      sort = { orderDate: -1 },
      projection = null
    } = options;

    const query = this._buildQuery(filters);

    let cursor = this.collection.find(query);

    if (projection) {
      cursor = cursor.project(projection);
    }

    cursor = cursor.sort(sort).skip(skip).limit(limit);

    return cursor.toArray();
  }

  /**
   * Count orders matching filters
   */
  async count(filters = {}) {
    await this.init();
    const query = this._buildQuery(filters);
    return this.collection.countDocuments(query);
  }

  /**
   * Build MongoDB query from filters
   */
  _buildQuery(filters) {
    const query = {};

    if (filters.channel) {
      query.channel = filters.channel;
    }

    if (filters.subChannel) {
      query.subChannel = filters.subChannel;
    }

    if (filters.channels) {
      query.channel = { $in: filters.channels };
    }

    if (filters.status) {
      query['status.unified'] = filters.status;
    }

    if (filters.statuses) {
      query['status.unified'] = { $in: filters.statuses };
    }

    if (filters.odooState) {
      query['odoo.state'] = filters.odooState;
    }

    if (filters.marketplace) {
      query['marketplace.code'] = filters.marketplace;
    }

    if (filters.dateFrom) {
      query.orderDate = query.orderDate || {};
      query.orderDate.$gte = new Date(filters.dateFrom);
    }

    if (filters.dateTo) {
      query.orderDate = query.orderDate || {};
      query.orderDate.$lte = new Date(filters.dateTo);
    }

    if (filters.hasOdooOrder !== undefined) {
      if (filters.hasOdooOrder) {
        query['sourceIds.odooSaleOrderId'] = { $ne: null };
      } else {
        query['sourceIds.odooSaleOrderId'] = null;
      }
    }

    if (filters.customerId) {
      query['customer.odooPartnerId'] = filters.customerId;
    }

    if (filters.search) {
      query.$or = [
        { 'sourceIds.amazonOrderId': { $regex: filters.search, $options: 'i' } },
        { 'sourceIds.odooSaleOrderName': { $regex: filters.search, $options: 'i' } },
        { 'sourceIds.bolOrderId': { $regex: filters.search, $options: 'i' } },
        { 'customer.name': { $regex: filters.search, $options: 'i' } }
      ];
    }

    // B2B order filter
    if (filters.isBusinessOrder !== undefined) {
      query.isBusinessOrder = filters.isBusinessOrder;
    }

    // TSV import filter
    if (filters.hasTsvImport !== undefined) {
      if (filters.hasTsvImport) {
        query['tsvImport.importedAt'] = { $ne: null };
      } else {
        query['tsvImport.importedAt'] = null;
      }
    }

    // TSV file name filter
    if (filters.tsvFileName) {
      query['tsvImport.fileName'] = filters.tsvFileName;
    }

    return query;
  }

  /**
   * Get orders by channel
   */
  async getByChannel(channel, options = {}) {
    return this.query({ channel }, options);
  }

  /**
   * Get Amazon Seller orders (FBA + FBM)
   */
  async getAmazonSellerOrders(options = {}) {
    return this.query({ channel: CHANNELS.AMAZON_SELLER }, options);
  }

  /**
   * Get Amazon Vendor orders
   */
  async getAmazonVendorOrders(options = {}) {
    return this.query({ channel: CHANNELS.AMAZON_VENDOR }, options);
  }

  /**
   * Get Bol.com orders
   */
  async getBolOrders(options = {}) {
    return this.query({ channel: CHANNELS.BOL }, options);
  }

  /**
   * Get orders pending Odoo import
   */
  async getPendingOdooImport(channel = null) {
    const filters = {
      hasOdooOrder: false,
      statuses: [UNIFIED_STATUS.CONFIRMED, UNIFIED_STATUS.PROCESSING, UNIFIED_STATUS.SHIPPED]
    };

    if (channel) {
      filters.channel = channel;
    }

    return this.query(filters, { limit: 500 });
  }

  /**
   * Get orders needing status sync with Odoo
   */
  async getOrdersNeedingOdooSync(limit = 100) {
    await this.init();

    // Orders where Odoo data hasn't been synced in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    return this.collection.find({
      'sourceIds.odooSaleOrderId': { $ne: null },
      $or: [
        { 'odoo.syncedAt': { $lt: oneHourAgo } },
        { 'odoo.syncedAt': null }
      ]
    })
      .limit(limit)
      .toArray();
  }

  // ============================================
  // Statistics
  // ============================================

  /**
   * Get order statistics
   */
  async getStats(filters = {}) {
    await this.init();

    const matchQuery = this._buildQuery(filters);

    const pipeline = [
      { $match: matchQuery },
      {
        $group: {
          _id: {
            channel: '$channel',
            subChannel: '$subChannel',
            status: '$status.unified'
          },
          count: { $sum: 1 },
          totalAmount: { $sum: '$totals.total' }
        }
      },
      {
        $group: {
          _id: { channel: '$_id.channel', subChannel: '$_id.subChannel' },
          statuses: {
            $push: {
              status: '$_id.status',
              count: '$count',
              totalAmount: '$totalAmount'
            }
          },
          totalCount: { $sum: '$count' },
          totalAmount: { $sum: '$totalAmount' }
        }
      }
    ];

    const results = await this.collection.aggregate(pipeline).toArray();

    // Format results
    const stats = {
      byChannel: {},
      total: { count: 0, amount: 0 }
    };

    for (const row of results) {
      const key = `${row._id.channel}:${row._id.subChannel}`;
      stats.byChannel[key] = {
        channel: row._id.channel,
        subChannel: row._id.subChannel,
        totalCount: row.totalCount,
        totalAmount: row.totalAmount,
        byStatus: {}
      };

      for (const s of row.statuses) {
        stats.byChannel[key].byStatus[s.status] = {
          count: s.count,
          amount: s.totalAmount
        };
      }

      stats.total.count += row.totalCount;
      stats.total.amount += row.totalAmount;
    }

    return stats;
  }

  /**
   * Get daily order counts
   */
  async getDailyStats(days = 30, channel = null) {
    await this.init();

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const matchQuery = {
      orderDate: { $gte: startDate }
    };

    if (channel) {
      matchQuery.channel = channel;
    }

    const pipeline = [
      { $match: matchQuery },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$orderDate' } },
            channel: '$channel'
          },
          count: { $sum: 1 },
          amount: { $sum: '$totals.total' }
        }
      },
      { $sort: { '_id.date': 1 } }
    ];

    return this.collection.aggregate(pipeline).toArray();
  }
}

/**
 * Get singleton instance
 */
function getUnifiedOrderService() {
  if (!instance) {
    instance = new UnifiedOrderService();
  }
  return instance;
}

module.exports = {
  UnifiedOrderService,
  getUnifiedOrderService,
  CHANNELS,
  SUB_CHANNELS,
  UNIFIED_STATUS,
  STATUS_MAP,
  COLLECTION_NAME
};
