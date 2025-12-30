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
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { isTestMode } = require('./TestMode');

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

    let allOrders = [];
    let nextToken = null;
    let pageCount = 0;

    // Paginate through all results
    do {
      const response = await client.getPurchaseOrders({
        ...params,
        ...(nextToken && { nextToken })
      });

      const orders = response.orders || [];
      allOrders = allOrders.concat(orders);
      nextToken = response.pagination?.nextToken || null;
      pageCount++;

      if (nextToken) {
        console.log(`[VendorPOImporter] ${marketplace} page ${pageCount}: ${orders.length} POs, fetching more...`);
      }
    } while (nextToken && pageCount < 50); // Safety limit of 50 pages (5000 POs)

    console.log(`[VendorPOImporter] Found ${allOrders.length} total POs for ${marketplace} (${pageCount} pages)`);

    let newCount = 0;
    let updatedCount = 0;

    for (const order of allOrders) {
      const result = await this.upsertPurchaseOrder(order, marketplace);
      if (result.isNew) {
        newCount++;
      } else {
        updatedCount++;
      }
    }

    return {
      marketplace,
      fetched: allOrders.length,
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
      // If Amazon says it's already Acknowledged or Closed, mark our flag too
      const isAlreadyAcknowledged = ['Acknowledged', 'Closed'].includes(document.purchaseOrderState);

      await collection.insertOne({
        ...document,
        acknowledgment: {
          acknowledged: isAlreadyAcknowledged,
          acknowledgedAt: isAlreadyAcknowledged ? new Date() : null,
          status: isAlreadyAcknowledged ? 'Accepted' : null
        },
        odoo: { saleOrderId: null, saleOrderName: null, invoiceId: null },
        shipments: [],
        invoices: [],
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // Enrich items with Odoo product data (async, don't wait)
      this.enrichItemsWithOdooData(poNumber).catch(err => {
        console.error(`[VendorPOImporter] Failed to enrich items for ${poNumber}:`, err.message);
      });

      return { isNew: true, purchaseOrderNumber: poNumber };
    }
  }

  /**
   * Enrich PO items with Odoo product data (SKU, name, stock)
   * Searches Odoo by barcode (EAN from Amazon's vendorProductIdentifier)
   */
  async enrichItemsWithOdooData(poNumber) {
    const collection = this.db.collection(COLLECTION_NAME);
    const po = await collection.findOne({ purchaseOrderNumber: poNumber });

    if (!po || !po.items || po.items.length === 0) {
      return;
    }

    try {
      const odoo = new OdooDirectClient();
      await odoo.authenticate();

      // Get Central Warehouse ID (code: CW)
      const warehouses = await odoo.search('stock.warehouse', [['code', '=', 'CW']], { limit: 1 });
      const warehouseId = warehouses.length > 0 ? warehouses[0] : null;

      if (!warehouseId) {
        console.error('[VendorPOImporter] Central Warehouse (CW) not found in Odoo');
        return;
      }

      const updatedItems = [];

      for (const item of po.items) {
        const ean = item.vendorProductIdentifier;
        const asin = item.amazonProductIdentifier;

        let productData = null;

        // Search by EAN (barcode)
        if (ean) {
          const products = await odoo.searchRead('product.product',
            [['barcode', '=', ean]],
            ['id', 'name', 'default_code'],
            { limit: 1 }
          );
          if (products.length > 0) {
            productData = products[0];
          }
        }

        // Fallback: search by ASIN in barcode
        if (!productData && asin) {
          const products = await odoo.searchRead('product.product',
            [['barcode', '=', asin]],
            ['id', 'name', 'default_code'],
            { limit: 1 }
          );
          if (products.length > 0) {
            productData = products[0];
          }
        }

        if (productData) {
          // Get stock from Central Warehouse using stock.quant
          const quants = await odoo.searchRead('stock.quant',
            [
              ['product_id', '=', productData.id],
              ['location_id.usage', '=', 'internal'],
              ['location_id.warehouse_id', '=', warehouseId]
            ],
            ['quantity', 'reserved_quantity'],
            { limit: 100 }
          );

          const qtyAvailable = quants.length > 0
            ? Math.max(0, quants.reduce((sum, q) => sum + (q.quantity - q.reserved_quantity), 0))
            : 0;

          updatedItems.push({
            ...item,
            odooProductId: productData.id,
            odooProductName: productData.name,
            odooSku: productData.default_code,
            qtyAvailable
          });
        } else {
          updatedItems.push(item);
        }
      }

      // Update PO with enriched items
      await collection.updateOne(
        { purchaseOrderNumber: poNumber },
        { $set: { items: updatedItems, updatedAt: new Date() } }
      );

      console.log(`[VendorPOImporter] Enriched ${updatedItems.filter(i => i.odooProductId).length}/${po.items.length} items for ${poNumber}`);
    } catch (err) {
      console.error(`[VendorPOImporter] Odoo enrichment failed for ${poNumber}:`, err.message);
    }
  }

  /**
   * Transform Amazon PO to our MongoDB schema
   * Amazon nests most data under orderDetails
   */
  transformPurchaseOrder(order, marketplace) {
    const details = order.orderDetails || {};

    // Parse delivery window string format: "2025-12-23T23:00:00Z--2026-01-02T00:00:00Z"
    let deliveryWindow = null;
    if (details.deliveryWindow && typeof details.deliveryWindow === 'string') {
      const parts = details.deliveryWindow.split('--');
      if (parts.length === 2) {
        deliveryWindow = {
          startDate: new Date(parts[0]),
          endDate: new Date(parts[1])
        };
      }
    } else if (details.deliveryWindow && typeof details.deliveryWindow === 'object') {
      deliveryWindow = {
        startDate: details.deliveryWindow.startDate ? new Date(details.deliveryWindow.startDate) : null,
        endDate: details.deliveryWindow.endDate ? new Date(details.deliveryWindow.endDate) : null
      };
    }

    return {
      purchaseOrderNumber: order.purchaseOrderNumber,
      marketplaceId: marketplace,
      amazonMarketplaceId: MARKETPLACE_IDS[marketplace],
      purchaseOrderState: order.purchaseOrderState,
      purchaseOrderType: details.purchaseOrderType || 'RegularOrder',
      purchaseOrderDate: new Date(details.purchaseOrderDate),

      // Delivery window
      deliveryWindow,

      // Parties (from orderDetails)
      buyingParty: details.buyingParty ? {
        partyId: details.buyingParty.partyId,
        address: details.buyingParty.address
      } : null,

      sellingParty: details.sellingParty ? {
        partyId: details.sellingParty.partyId,
        address: details.sellingParty.address
      } : null,

      shipToParty: details.shipToParty ? {
        partyId: details.shipToParty.partyId,
        address: details.shipToParty.address
      } : null,

      billToParty: details.billToParty ? {
        partyId: details.billToParty.partyId,
        address: details.billToParty.address
      } : null,

      // Items with acknowledgment fields (from orderDetails.items)
      items: (details.items || []).map(item => ({
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
      totals: this.calculateTotals(details.items || []),

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

    // Use shared query builder to ensure consistent filtering
    const query = this._buildQuery(filters);

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
   * Build query object from filters (shared helper)
   * IMPORTANT: Excludes test data unless test mode is enabled
   */
  _buildQuery(filters = {}) {
    const query = {};

    // CRITICAL: Only show test data when test mode is enabled
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

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

    // Shipment status filter
    if (filters.shipmentStatus) {
      query.shipmentStatus = filters.shipmentStatus;
    }

    // Invoice pending filter (shipped but no invoice)
    if (filters.invoicePending) {
      query.$or = [
        { invoiceStatus: null },
        { invoiceStatus: 'not_submitted' }
      ];
    }

    // Action required filter (New OR Acknowledged+not_shipped)
    if (filters.actionRequired) {
      query.$or = [
        { purchaseOrderState: 'New' },
        { purchaseOrderState: 'Acknowledged', shipmentStatus: 'not_shipped' }
      ];
    }

    return query;
  }

  /**
   * Count purchase orders with filters
   */
  async countPurchaseOrders(filters = {}) {
    const collection = this.db.collection(COLLECTION_NAME);
    const query = this._buildQuery(filters);
    return collection.countDocuments(query);
  }

  /**
   * Get statistics
   * IMPORTANT: Excludes test data unless test mode is enabled
   */
  async getStats() {
    const collection = this.db.collection(COLLECTION_NAME);

    // Filter out test data unless in test mode
    const matchStage = isTestMode() ? {} : { _testData: { $ne: true } };

    const stats = await collection.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          // Amazon PO states
          new: { $sum: { $cond: [{ $eq: ['$purchaseOrderState', 'New'] }, 1, 0] } },
          acknowledged: { $sum: { $cond: [{ $eq: ['$purchaseOrderState', 'Acknowledged'] }, 1, 0] } },
          closed: { $sum: { $cond: [{ $eq: ['$purchaseOrderState', 'Closed'] }, 1, 0] } },
          // Our tracking flags
          pendingAck: { $sum: { $cond: ['$acknowledgment.acknowledged', 0, 1] } },
          // Open Orders = Acknowledged AND not shipped (need to ship)
          openOrders: { $sum: { $cond: [
            { $and: [
              { $eq: ['$purchaseOrderState', 'Acknowledged'] },
              { $eq: ['$shipmentStatus', 'not_shipped'] }
            ]}, 1, 0
          ]}},
          // Shipment status counts
          notShipped: { $sum: { $cond: [{ $eq: ['$shipmentStatus', 'not_shipped'] }, 1, 0] } },
          partiallyShipped: { $sum: { $cond: [{ $eq: ['$shipmentStatus', 'partially_shipped'] }, 1, 0] } },
          fullyShipped: { $sum: { $cond: [{ $eq: ['$shipmentStatus', 'fully_shipped'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$shipmentStatus', 'cancelled'] }, 1, 0] } },
          // Invoice Pending = Acknowledged AND shipped AND no invoice submitted
          invoicePending: { $sum: { $cond: [
            { $and: [
              { $eq: ['$purchaseOrderState', 'Acknowledged'] },
              { $eq: ['$shipmentStatus', 'fully_shipped'] },
              { $in: [{ $ifNull: ['$invoiceStatus', 'not_submitted'] }, ['not_submitted', null]] }
            ]}, 1, 0
          ]}},
          invoiceSubmitted: { $sum: { $cond: [{ $eq: ['$invoiceStatus', 'submitted'] }, 1, 0] } },
          invoiceAccepted: { $sum: { $cond: [{ $eq: ['$invoiceStatus', 'accepted'] }, 1, 0] } },
          // Odoo integration
          withOdooOrder: { $sum: { $cond: [{ $ne: ['$odoo.saleOrderId', null] }, 1, 0] } },
          totalAmount: { $sum: '$totals.totalAmount' }
        }
      }
    ]).toArray();

    // Stats by marketplace
    const byMarketplace = await collection.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$marketplaceId',
          count: { $sum: 1 },
          totalAmount: { $sum: '$totals.totalAmount' }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();

    // Recent POs (also filter out test data in production)
    const recentPOs = await collection.find(matchStage)
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
        openOrders: 0,
        notShipped: 0,
        partiallyShipped: 0,
        fullyShipped: 0,
        cancelled: 0,
        invoicePending: 0,
        invoiceSubmitted: 0,
        invoiceAccepted: 0,
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
   * Excludes test data unless test mode is enabled
   */
  async getPendingAcknowledgment(limit = 50) {
    const collection = this.db.collection(COLLECTION_NAME);

    const query = {
      'acknowledgment.acknowledged': false,
      purchaseOrderState: PO_STATES.NEW
    };

    // Exclude test data in production
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

    return collection.find(query)
      .sort({ purchaseOrderDate: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Get POs that need Odoo orders created
   * Excludes test data unless test mode is enabled
   */
  async getPendingOdooOrders(limit = 50) {
    const collection = this.db.collection(COLLECTION_NAME);

    const query = {
      'odoo.saleOrderId': null,
      purchaseOrderState: { $ne: PO_STATES.CLOSED }
    };

    // Exclude test data in production
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

    return collection.find(query)
      .sort({ purchaseOrderDate: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Get POs that are ready for invoicing
   * Excludes test data unless test mode is enabled
   * Criteria:
   * - Has Odoo sale order linked
   * - No invoice linked yet
   * - Acknowledged (either locally or by Amazon state)
   */
  async getReadyForInvoicing(limit = 50) {
    const collection = this.db.collection(COLLECTION_NAME);

    const query = {
      'odoo.saleOrderId': { $ne: null },
      'odoo.invoiceId': null,
      $or: [
        { 'acknowledgment.acknowledged': true },
        { purchaseOrderState: 'Acknowledged' }
      ]
    };

    // Exclude test data in production
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

    return collection.find(query)
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
          odooSku: info.odooSku,
          odooBarcode: info.odooBarcode,  // Real EAN from Odoo
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
