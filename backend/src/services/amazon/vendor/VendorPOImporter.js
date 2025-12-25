/**
 * VendorPOImporter - Import Purchase Orders from Amazon Vendor Central
 *
 * Fetches POs from Amazon SP-API and stores them in MongoDB.
 * Supports all 9 EU marketplaces with per-marketplace tokens.
 *
 * Flow:
 * 1. Poll Amazon for new/updated POs
 * 2. Store/update POs in MongoDB
 * 3. Optionally create Odoo sale orders
 *
 * @module VendorPOImporter
 */

const { getDb } = require('../../../db');
const { VendorClient, VENDOR_TOKEN_MAP, MARKETPLACE_IDS, PO_STATES } = require('./VendorClient');

/**
 * MongoDB collection name for vendor purchase orders
 */
const COLLECTION_NAME = 'vendor_purchase_orders';

class VendorPOImporter {
  constructor() {
    this.db = null;
    this.clients = {};
  }

  /**
   * Initialize the importer
   */
  async init() {
    this.db = getDb();

    // Create indexes
    await this.ensureIndexes();

    // Initialize clients for all configured marketplaces
    this.initializeClients();

    return this;
  }

  /**
   * Initialize VendorClient instances for all configured marketplaces
   */
  initializeClients() {
    for (const marketplace of Object.keys(VENDOR_TOKEN_MAP)) {
      // Skip DE_FR variant
      if (marketplace === 'DE_FR') continue;

      try {
        this.clients[marketplace] = new VendorClient(marketplace);
      } catch (error) {
        console.warn(`[VendorPOImporter] Could not create client for ${marketplace}: ${error.message}`);
      }
    }

    console.log(`[VendorPOImporter] Initialized clients for: ${Object.keys(this.clients).join(', ')}`);
  }

  /**
   * Ensure MongoDB indexes exist
   */
  async ensureIndexes() {
    const collection = this.db.collection(COLLECTION_NAME);

    await collection.createIndexes([
      { key: { purchaseOrderNumber: 1 }, unique: true },
      { key: { marketplaceId: 1, purchaseOrderState: 1 } },
      { key: { purchaseOrderDate: -1 } },
      { key: { 'acknowledgment.acknowledged': 1 } },
      { key: { 'odoo.saleOrderId': 1 } },
      { key: { createdAt: -1 } },
      { key: { updatedAt: -1 } }
    ]);
  }

  /**
   * Poll all marketplaces for new purchase orders
   * @param {Object} options - Polling options
   * @param {number} options.daysBack - Days to look back (default 7)
   * @param {string} options.state - PO state filter (default: all)
   * @returns {Object} Summary of imported/updated POs
   */
  async pollAllMarketplaces(options = {}) {
    const results = {
      marketplaces: {},
      totalNew: 0,
      totalUpdated: 0,
      totalErrors: 0
    };

    for (const [marketplace, client] of Object.entries(this.clients)) {
      try {
        const result = await this.pollMarketplace(marketplace, options);
        results.marketplaces[marketplace] = result;
        results.totalNew += result.new;
        results.totalUpdated += result.updated;
      } catch (error) {
        console.error(`[VendorPOImporter] Error polling ${marketplace}:`, error.message);
        results.marketplaces[marketplace] = { error: error.message };
        results.totalErrors++;
      }
    }

    return results;
  }

  /**
   * Poll a specific marketplace for purchase orders
   * @param {string} marketplace - Marketplace code (FR, DE, etc.)
   * @param {Object} options - Polling options
   */
  async pollMarketplace(marketplace, options = {}) {
    const client = this.clients[marketplace];
    if (!client) {
      throw new Error(`No client configured for marketplace: ${marketplace}`);
    }

    const daysBack = options.daysBack || 7;
    const createdAfter = new Date();
    createdAfter.setDate(createdAfter.getDate() - daysBack);

    const params = {
      createdAfter: createdAfter.toISOString(),
      ...(options.state && { purchaseOrderState: options.state })
    };

    console.log(`[VendorPOImporter] Polling ${marketplace} for POs since ${createdAfter.toISOString()}`);

    const response = await client.getPurchaseOrders(params);
    const orders = response.orders || [];

    console.log(`[VendorPOImporter] Found ${orders.length} POs for ${marketplace}`);

    let newCount = 0;
    let updatedCount = 0;

    for (const order of orders) {
      const result = await this.upsertPurchaseOrder(order, marketplace);
      if (result.isNew) {
        newCount++;
      } else {
        updatedCount++;
      }
    }

    return {
      marketplace,
      fetched: orders.length,
      new: newCount,
      updated: updatedCount
    };
  }

  /**
   * Upsert a purchase order to MongoDB
   * @param {Object} order - Purchase order from Amazon API
   * @param {string} marketplace - Marketplace code
   */
  async upsertPurchaseOrder(order, marketplace) {
    const collection = this.db.collection(COLLECTION_NAME);

    const poNumber = order.purchaseOrderNumber;
    const existing = await collection.findOne({ purchaseOrderNumber: poNumber });

    const document = this.transformPurchaseOrder(order, marketplace);

    if (existing) {
      // Update existing
      await collection.updateOne(
        { purchaseOrderNumber: poNumber },
        {
          $set: {
            ...document,
            updatedAt: new Date()
          }
        }
      );
      return { isNew: false, purchaseOrderNumber: poNumber };
    } else {
      // Insert new
      await collection.insertOne({
        ...document,
        acknowledgment: { acknowledged: false },
        odoo: { saleOrderId: null, saleOrderName: null, invoiceId: null },
        shipments: [],
        invoices: [],
        createdAt: new Date(),
        updatedAt: new Date()
      });
      return { isNew: true, purchaseOrderNumber: poNumber };
    }
  }

  /**
   * Transform Amazon PO to our MongoDB schema
   */
  transformPurchaseOrder(order, marketplace) {
    return {
      purchaseOrderNumber: order.purchaseOrderNumber,
      marketplaceId: marketplace,
      amazonMarketplaceId: MARKETPLACE_IDS[marketplace],
      purchaseOrderState: order.purchaseOrderState,
      purchaseOrderType: order.purchaseOrderType || 'RegularOrder',
      purchaseOrderDate: new Date(order.purchaseOrderDate),

      // Delivery window
      deliveryWindow: order.deliveryWindow ? {
        startDate: order.deliveryWindow.startDate ? new Date(order.deliveryWindow.startDate) : null,
        endDate: order.deliveryWindow.endDate ? new Date(order.deliveryWindow.endDate) : null
      } : null,

      // Parties
      buyingParty: order.buyingParty ? {
        partyId: order.buyingParty.partyId,
        address: order.buyingParty.address
      } : null,

      sellingParty: order.sellingParty ? {
        partyId: order.sellingParty.partyId,
        address: order.sellingParty.address
      } : null,

      shipToParty: order.shipToParty ? {
        partyId: order.shipToParty.partyId,
        address: order.shipToParty.address
      } : null,

      billToParty: order.billToParty ? {
        partyId: order.billToParty.partyId,
        address: order.billToParty.address
      } : null,

      // Items with acknowledgment fields
      items: (order.items || []).map(item => ({
        itemSequenceNumber: item.itemSequenceNumber,
        amazonProductIdentifier: item.amazonProductIdentifier, // ASIN
        vendorProductIdentifier: item.vendorProductIdentifier, // SKU
        orderedQuantity: item.orderedQuantity ? {
          amount: item.orderedQuantity.amount,
          unitOfMeasure: item.orderedQuantity.unitOfMeasure,
          unitSize: item.orderedQuantity.unitSize
        } : null,
        isBackOrderAllowed: item.isBackOrderAllowed,
        netCost: item.netCost ? {
          currencyCode: item.netCost.currencyCode,
          amount: item.netCost.amount
        } : null,
        listPrice: item.listPrice ? {
          currencyCode: item.listPrice.currencyCode,
          amount: item.listPrice.amount
        } : null,

        // Line-level acknowledgment fields (user-filled)
        acknowledgeQty: 0,           // Quantity to accept
        backorderQty: 0,             // Quantity on backorder
        productAvailability: 'accepted', // 'accepted', 'rejected_TemporarilyUnavailable', 'rejected_ObsoleteProduct', 'rejected_InvalidProductIdentifier'

        // Odoo product link (populated by stock check)
        odooProductId: null,
        odooProductName: null,
        qtyAvailable: null           // Cached stock level from Odoo
      })),

      // Calculate totals
      totals: this.calculateTotals(order.items || []),

      // Raw data for reference
      rawData: order
    };
  }

  /**
   * Calculate order totals from items
   */
  calculateTotals(items) {
    let totalAmount = 0;
    let totalUnits = 0;
    let currency = 'EUR';

    for (const item of items) {
      if (item.netCost) {
        const qty = item.orderedQuantity?.amount || 0;
        const price = parseFloat(item.netCost.amount) || 0;
        totalAmount += qty * price;
        currency = item.netCost.currencyCode || currency;
      }
      totalUnits += item.orderedQuantity?.amount || 0;
    }

    return {
      totalAmount: Math.round(totalAmount * 100) / 100,
      totalUnits,
      currency,
      lineCount: items.length
    };
  }

  /**
   * Get purchase order by number
   */
  async getPurchaseOrder(poNumber) {
    const collection = this.db.collection(COLLECTION_NAME);
    return collection.findOne({ purchaseOrderNumber: poNumber });
  }

  /**
   * Get purchase orders with filters
   */
  async getPurchaseOrders(filters = {}, options = {}) {
    const collection = this.db.collection(COLLECTION_NAME);

    const query = {};

    if (filters.marketplace) {
      query.marketplaceId = filters.marketplace;
    }

    if (filters.state) {
      query.purchaseOrderState = filters.state;
    }

    if (filters.acknowledged !== undefined) {
      query['acknowledgment.acknowledged'] = filters.acknowledged;
    }

    if (filters.hasOdooOrder !== undefined) {
      if (filters.hasOdooOrder) {
        query['odoo.saleOrderId'] = { $ne: null };
      } else {
        query['odoo.saleOrderId'] = null;
      }
    }

    if (filters.dateFrom) {
      query.purchaseOrderDate = { $gte: new Date(filters.dateFrom) };
    }

    if (filters.dateTo) {
      query.purchaseOrderDate = {
        ...query.purchaseOrderDate,
        $lte: new Date(filters.dateTo)
      };
    }

    const cursor = collection.find(query);

    // Sorting
    if (options.sort) {
      cursor.sort(options.sort);
    } else {
      cursor.sort({ purchaseOrderDate: -1 });
    }

    // Pagination
    if (options.limit) {
      cursor.limit(options.limit);
    }
    if (options.skip) {
      cursor.skip(options.skip);
    }

    return cursor.toArray();
  }

  /**
   * Get statistics
   */
  async getStats() {
    const collection = this.db.collection(COLLECTION_NAME);

    const stats = await collection.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          new: { $sum: { $cond: [{ $eq: ['$purchaseOrderState', 'New'] }, 1, 0] } },
          acknowledged: { $sum: { $cond: [{ $eq: ['$purchaseOrderState', 'Acknowledged'] }, 1, 0] } },
          closed: { $sum: { $cond: [{ $eq: ['$purchaseOrderState', 'Closed'] }, 1, 0] } },
          pendingAck: { $sum: { $cond: ['$acknowledgment.acknowledged', 0, 1] } },
          withOdooOrder: { $sum: { $cond: [{ $ne: ['$odoo.saleOrderId', null] }, 1, 0] } },
          totalAmount: { $sum: '$totals.totalAmount' }
        }
      }
    ]).toArray();

    // Stats by marketplace
    const byMarketplace = await collection.aggregate([
      {
        $group: {
          _id: '$marketplaceId',
          count: { $sum: 1 },
          totalAmount: { $sum: '$totals.totalAmount' }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();

    // Recent POs
    const recentPOs = await collection.find()
      .sort({ purchaseOrderDate: -1 })
      .limit(10)
      .project({
        purchaseOrderNumber: 1,
        marketplaceId: 1,
        purchaseOrderState: 1,
        purchaseOrderDate: 1,
        'totals.totalAmount': 1,
        'acknowledgment.acknowledged': 1
      })
      .toArray();

    return {
      summary: stats[0] || {
        total: 0,
        new: 0,
        acknowledged: 0,
        closed: 0,
        pendingAck: 0,
        withOdooOrder: 0,
        totalAmount: 0
      },
      byMarketplace,
      recentPOs
    };
  }

  /**
   * Update PO with Odoo order info
   */
  async linkToOdooOrder(poNumber, odooOrderId, odooOrderName) {
    const collection = this.db.collection(COLLECTION_NAME);

    return collection.updateOne(
      { purchaseOrderNumber: poNumber },
      {
        $set: {
          'odoo.saleOrderId': odooOrderId,
          'odoo.saleOrderName': odooOrderName,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Mark PO as acknowledged
   */
  async markAcknowledged(poNumber, status = 'Accepted') {
    const collection = this.db.collection(COLLECTION_NAME);

    return collection.updateOne(
      { purchaseOrderNumber: poNumber },
      {
        $set: {
          'acknowledgment.acknowledged': true,
          'acknowledgment.acknowledgedAt': new Date(),
          'acknowledgment.status': status,
          purchaseOrderState: PO_STATES.ACKNOWLEDGED,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Add invoice to PO
   */
  async addInvoice(poNumber, invoiceData) {
    const collection = this.db.collection(COLLECTION_NAME);

    return collection.updateOne(
      { purchaseOrderNumber: poNumber },
      {
        $push: {
          invoices: {
            invoiceNumber: invoiceData.invoiceNumber,
            odooInvoiceId: invoiceData.odooInvoiceId,
            odooInvoiceName: invoiceData.odooInvoiceName,
            status: invoiceData.status || 'draft',
            submittedAt: invoiceData.submittedAt || null,
            createdAt: new Date()
          }
        },
        $set: {
          'odoo.invoiceId': invoiceData.odooInvoiceId,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Add shipment to PO
   */
  async addShipment(poNumber, shipmentData) {
    const collection = this.db.collection(COLLECTION_NAME);

    return collection.updateOne(
      { purchaseOrderNumber: poNumber },
      {
        $push: {
          shipments: {
            shipmentId: shipmentData.shipmentId,
            odooPickingId: shipmentData.odooPickingId,
            carrier: shipmentData.carrier,
            trackingNumber: shipmentData.trackingNumber,
            status: shipmentData.status || 'pending',
            submittedAt: shipmentData.submittedAt || null,
            createdAt: new Date()
          }
        },
        $set: {
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Get POs that need acknowledgment
   */
  async getPendingAcknowledgment(limit = 50) {
    const collection = this.db.collection(COLLECTION_NAME);

    return collection.find({
      'acknowledgment.acknowledged': false,
      purchaseOrderState: PO_STATES.NEW
    })
      .sort({ purchaseOrderDate: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Get POs that need Odoo orders created
   */
  async getPendingOdooOrders(limit = 50) {
    const collection = this.db.collection(COLLECTION_NAME);

    return collection.find({
      'odoo.saleOrderId': null,
      purchaseOrderState: { $ne: PO_STATES.CLOSED }
    })
      .sort({ purchaseOrderDate: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Get POs that are ready for invoicing
   * Criteria:
   * - Has Odoo sale order linked
   * - No invoice linked yet
   * - Acknowledged (either locally or by Amazon state)
   */
  async getReadyForInvoicing(limit = 50) {
    const collection = this.db.collection(COLLECTION_NAME);

    return collection.find({
      'odoo.saleOrderId': { $ne: null },
      'odoo.invoiceId': null,
      $or: [
        { 'acknowledgment.acknowledged': true },
        { purchaseOrderState: 'Acknowledged' }
      ]
    })
      .sort({ purchaseOrderDate: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Update line-level acknowledgment data for a PO
   * @param {string} poNumber - Purchase order number
   * @param {Array} itemUpdates - Array of { itemSequenceNumber, acknowledgeQty, backorderQty, productAvailability }
   * @param {Object} scheduleData - { scheduledShipDate, scheduledDeliveryDate }
   */
  async updateLineAcknowledgments(poNumber, itemUpdates, scheduleData = {}) {
    const collection = this.db.collection(COLLECTION_NAME);

    const po = await this.getPurchaseOrder(poNumber);
    if (!po) {
      throw new Error(`PO not found: ${poNumber}`);
    }

    // Update each item with acknowledgment data
    const updatedItems = po.items.map(item => {
      const update = itemUpdates.find(u =>
        u.itemSequenceNumber === item.itemSequenceNumber ||
        u.vendorProductIdentifier === item.vendorProductIdentifier
      );

      if (update) {
        return {
          ...item,
          acknowledgeQty: update.acknowledgeQty ?? item.acknowledgeQty,
          backorderQty: update.backorderQty ?? item.backorderQty,
          productAvailability: update.productAvailability ?? item.productAvailability
        };
      }
      return item;
    });

    // Build the update
    const updateData = {
      items: updatedItems,
      updatedAt: new Date()
    };

    // Add schedule data if provided
    if (scheduleData.scheduledShipDate) {
      updateData['acknowledgment.scheduledShipDate'] = new Date(scheduleData.scheduledShipDate);
    }
    if (scheduleData.scheduledDeliveryDate) {
      updateData['acknowledgment.scheduledDeliveryDate'] = new Date(scheduleData.scheduledDeliveryDate);
    }

    return collection.updateOne(
      { purchaseOrderNumber: poNumber },
      { $set: updateData }
    );
  }

  /**
   * Update item with Odoo product info and stock level
   * @param {string} poNumber - Purchase order number
   * @param {string} vendorProductIdentifier - SKU
   * @param {Object} productInfo - { odooProductId, odooProductName, qtyAvailable }
   */
  async updateItemProductInfo(poNumber, vendorProductIdentifier, productInfo) {
    const collection = this.db.collection(COLLECTION_NAME);

    return collection.updateOne(
      {
        purchaseOrderNumber: poNumber,
        'items.vendorProductIdentifier': vendorProductIdentifier
      },
      {
        $set: {
          'items.$.odooProductId': productInfo.odooProductId,
          'items.$.odooProductName': productInfo.odooProductName,
          'items.$.qtyAvailable': productInfo.qtyAvailable,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Bulk update items with Odoo product info
   * @param {string} poNumber - Purchase order number
   * @param {Array} productInfoList - Array of { vendorProductIdentifier, odooProductId, odooProductName, qtyAvailable }
   */
  async updateItemsProductInfo(poNumber, productInfoList) {
    const collection = this.db.collection(COLLECTION_NAME);

    const po = await this.getPurchaseOrder(poNumber);
    if (!po) {
      throw new Error(`PO not found: ${poNumber}`);
    }

    // Update each item with product info
    const updatedItems = po.items.map(item => {
      const info = productInfoList.find(p =>
        p.vendorProductIdentifier === item.vendorProductIdentifier
      );

      if (info) {
        return {
          ...item,
          odooProductId: info.odooProductId,
          odooProductName: info.odooProductName,
          qtyAvailable: info.qtyAvailable
        };
      }
      return item;
    });

    return collection.updateOne(
      { purchaseOrderNumber: poNumber },
      {
        $set: {
          items: updatedItems,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Auto-fill acknowledgment quantities based on available stock
   * Sets acknowledgeQty = min(orderedQty, qtyAvailable)
   * Sets backorderQty = remaining if backorder allowed
   * @param {string} poNumber - Purchase order number
   */
  async autoFillAcknowledgments(poNumber) {
    const collection = this.db.collection(COLLECTION_NAME);

    const po = await this.getPurchaseOrder(poNumber);
    if (!po) {
      throw new Error(`PO not found: ${poNumber}`);
    }

    const updatedItems = po.items.map(item => {
      const orderedQty = item.orderedQuantity?.amount || 0;
      const available = item.qtyAvailable || 0;

      if (available >= orderedQty) {
        // Full stock available
        return {
          ...item,
          acknowledgeQty: orderedQty,
          backorderQty: 0,
          productAvailability: 'accepted'
        };
      } else if (available > 0) {
        // Partial stock
        const remaining = orderedQty - available;
        return {
          ...item,
          acknowledgeQty: available,
          backorderQty: item.isBackOrderAllowed ? remaining : 0,
          productAvailability: 'accepted'
        };
      } else {
        // No stock
        return {
          ...item,
          acknowledgeQty: 0,
          backorderQty: item.isBackOrderAllowed ? orderedQty : 0,
          productAvailability: item.isBackOrderAllowed ? 'accepted' : 'rejected_TemporarilyUnavailable'
        };
      }
    });

    return collection.updateOne(
      { purchaseOrderNumber: poNumber },
      {
        $set: {
          items: updatedItems,
          updatedAt: new Date()
        }
      }
    );
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the VendorPOImporter instance
 */
async function getVendorPOImporter() {
  if (!instance) {
    instance = new VendorPOImporter();
    await instance.init();
  }
  return instance;
}

module.exports = {
  VendorPOImporter,
  getVendorPOImporter,
  COLLECTION_NAME
};
