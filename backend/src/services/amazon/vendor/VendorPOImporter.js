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
const { getAmazonProductMapper } = require('../AmazonProductMapper');
const {
  getUnifiedOrderService,
  CHANNELS,
  SUB_CHANNELS,
  UNIFIED_STATUS
} = require('../../orders/UnifiedOrderService');
const { transformAmazonVendorApiOrder } = require('../../orders/transformers/VendorOrderTransformer');

/**
 * MongoDB collection name - now using unified_orders
 */
const COLLECTION_NAME = 'unified_orders';

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
   * Note: Most indexes are created by UnifiedOrderService, but we add vendor-specific ones
   */
  async ensureIndexes() {
    const collection = this.db.collection(COLLECTION_NAME);

    // Add vendor-specific indexes (main ones are in UnifiedOrderService)
    await collection.createIndexes([
      { key: { 'sourceIds.amazonVendorPONumber': 1 }, sparse: true },
      { key: { 'amazonVendor.purchaseOrderState': 1 }, sparse: true },
      { key: { 'amazonVendor.acknowledgment.acknowledged': 1 }, sparse: true },
      { key: { 'amazonVendor.shipmentStatus': 1 }, sparse: true }
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

    for (const [marketplace, _client] of Object.entries(this.clients)) {
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
   * Upsert a purchase order to MongoDB using unified schema
   * @param {Object} order - Purchase order from Amazon API
   * @param {string} marketplace - Marketplace code
   */
  async upsertPurchaseOrder(order, marketplace) {
    const collection = this.db.collection(COLLECTION_NAME);
    const poNumber = order.purchaseOrderNumber;
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

    // Check if already exists
    const existing = await collection.findOne({ unifiedOrderId });

    // Transform to unified schema
    const unified = transformAmazonVendorApiOrder(order, marketplace);

    // If Amazon says it's already Acknowledged or Closed, mark our flag too
    const isAlreadyAcknowledged = ['Acknowledged', 'Closed'].includes(order.purchaseOrderState);

    if (existing) {
      // Preserve existing Odoo data and acknowledgment state
      const preservedOdoo = existing.odoo || null;
      const preservedAck = existing.amazonVendor?.acknowledgment || unified.amazonVendor.acknowledgment;

      // Update existing - preserve Odoo links and shipment data
      await collection.updateOne(
        { unifiedOrderId },
        {
          $set: {
            // Update core fields from Amazon
            'status.source': order.purchaseOrderState,
            'status.unified': unified.status.unified,
            'amazonVendor.purchaseOrderState': order.purchaseOrderState,
            'amazonVendor.purchaseOrderType': unified.amazonVendor.purchaseOrderType,
            'amazonVendor.deliveryWindow': unified.amazonVendor.deliveryWindow,
            'amazonVendor.buyingParty': unified.amazonVendor.buyingParty,
            'amazonVendor.sellingParty': unified.amazonVendor.sellingParty,
            'amazonVendor.shipToParty': unified.amazonVendor.shipToParty,
            'amazonVendor.billToParty': unified.amazonVendor.billToParty,
            'shippingAddress': unified.shippingAddress,
            'items': unified.items,
            'totals': unified.totals,
            'lastUpdateDate': new Date(),
            updatedAt: new Date()
          }
        }
      );
      return { isNew: false, purchaseOrderNumber: poNumber };
    } else {
      // Insert new - set acknowledgment based on Amazon state
      unified.amazonVendor.acknowledgment = {
        acknowledged: isAlreadyAcknowledged,
        acknowledgedAt: isAlreadyAcknowledged ? new Date() : null,
        status: isAlreadyAcknowledged ? 'Accepted' : null
      };
      unified.amazonVendor.shipmentStatus = 'not_shipped';
      unified.amazonVendor.shipments = [];

      await collection.insertOne(unified);

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
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;
    const po = await collection.findOne({ unifiedOrderId });

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

        // Fallback 2: search by ASIN in our own amazon_product_mappings collection
        if (!productData && asin) {
          try {
            const mapper = await getAmazonProductMapper();
            const mapping = await mapper.findByAsin(asin, po.marketplaceId || 'ALL');
            if (mapping && mapping.odooProductId) {
              const products = await odoo.searchRead('product.product',
                [['id', '=', mapping.odooProductId]],
                ['id', 'name', 'default_code', 'barcode'],
                { limit: 1 }
              );
              if (products.length > 0) {
                productData = products[0];
                console.log(`[VendorPOImporter] Found product via Amazon mapping: ASIN ${asin} -> ${productData.default_code}`);
              }
            }
          } catch (mappingErr) {
            // Mapping collection may not be initialized, continue to EPT fallback
          }
        }

        // Fallback 3: search by ASIN in amazon.product.ept (Emipro EPT mapping - DEPRECATED)
        if (!productData && asin) {
          try {
            const eptMappings = await odoo.searchRead('amazon.product.ept',
              [['product_asin', '=', asin]],
              ['id', 'product_id'],
              { limit: 1 }
            );
            if (eptMappings.length > 0 && eptMappings[0].product_id) {
              const productId = eptMappings[0].product_id[0];
              const products = await odoo.searchRead('product.product',
                [['id', '=', productId]],
                ['id', 'name', 'default_code', 'barcode'],
                { limit: 1 }
              );
              if (products.length > 0) {
                productData = products[0];
                console.log(`[VendorPOImporter] Found product via EPT mapping (deprecated): ASIN ${asin} -> ${productData.default_code}`);
              }
            }
          } catch (eptErr) {
            // EPT table may not exist after Emipro uninstall, ignore error
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

      // Update PO with enriched items (using unified schema)
      await collection.updateOne(
        { unifiedOrderId },
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
   * Automatically re-enriches items that are missing Odoo product data
   */
  async getPurchaseOrder(poNumber) {
    const collection = this.db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;
    const po = await collection.findOne({ unifiedOrderId });

    // Auto-enrich missing products when PO is accessed
    if (po && po.items) {
      const missingProducts = po.items.filter(item => !item.odooProductId);
      if (missingProducts.length > 0) {
        console.log(`[VendorPOImporter] PO ${poNumber} has ${missingProducts.length} items missing product data, re-enriching...`);
        await this.enrichItemsWithOdooData(poNumber);
        // Return fresh data after enrichment
        return collection.findOne({ unifiedOrderId });
      }
    }

    return po;
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
   * IMPORTANT: Uses unified schema fields and excludes test data unless test mode is enabled
   */
  _buildQuery(filters = {}) {
    const query = {
      channel: CHANNELS.AMAZON_VENDOR  // Only query vendor orders
    };

    // CRITICAL: Only show test data when test mode is enabled
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

    if (filters.marketplace) {
      query['marketplace.code'] = filters.marketplace;
    }

    if (filters.state) {
      query['amazonVendor.purchaseOrderState'] = filters.state;
    }

    if (filters.acknowledged !== undefined) {
      query['amazonVendor.acknowledgment.acknowledged'] = filters.acknowledged;
    }

    if (filters.hasOdooOrder !== undefined) {
      if (filters.hasOdooOrder) {
        query['sourceIds.odooSaleOrderId'] = { $ne: null };
      } else {
        query['sourceIds.odooSaleOrderId'] = null;
      }
    }

    if (filters.dateFrom) {
      query.orderDate = { $gte: new Date(filters.dateFrom) };
    }

    if (filters.dateTo) {
      query.orderDate = {
        ...query.orderDate,
        $lte: new Date(filters.dateTo)
      };
    }

    // Shipment status filter
    if (filters.shipmentStatus) {
      query['amazonVendor.shipmentStatus'] = filters.shipmentStatus;
    }

    // Invoice pending filter (shipped but no invoice)
    if (filters.invoicePending) {
      query.$or = [
        { 'amazonVendor.invoiceStatus': null },
        { 'amazonVendor.invoiceStatus': 'not_submitted' }
      ];
    }

    // Action required filter (New OR Acknowledged+not_shipped)
    if (filters.actionRequired) {
      query.$or = [
        { 'amazonVendor.purchaseOrderState': 'New' },
        { 'amazonVendor.purchaseOrderState': 'Acknowledged', 'amazonVendor.shipmentStatus': 'not_shipped' }
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
   * IMPORTANT: Uses unified schema and excludes test data unless test mode is enabled
   */
  async getStats() {
    const collection = this.db.collection(COLLECTION_NAME);

    // Filter out test data unless in test mode, and only vendor orders
    const matchStage = {
      channel: CHANNELS.AMAZON_VENDOR,
      ...(isTestMode() ? {} : { _testData: { $ne: true } })
    };

    const stats = await collection.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          // Amazon PO states (using unified schema)
          new: { $sum: { $cond: [{ $eq: ['$amazonVendor.purchaseOrderState', 'New'] }, 1, 0] } },
          acknowledged: { $sum: { $cond: [{ $eq: ['$amazonVendor.purchaseOrderState', 'Acknowledged'] }, 1, 0] } },
          closed: { $sum: { $cond: [{ $eq: ['$amazonVendor.purchaseOrderState', 'Closed'] }, 1, 0] } },
          // Our tracking flags
          pendingAck: { $sum: { $cond: ['$amazonVendor.acknowledgment.acknowledged', 0, 1] } },
          // Open Orders = Acknowledged AND not shipped (need to ship)
          openOrders: { $sum: { $cond: [
            { $and: [
              { $eq: ['$amazonVendor.purchaseOrderState', 'Acknowledged'] },
              { $eq: ['$amazonVendor.shipmentStatus', 'not_shipped'] }
            ]}, 1, 0
          ]}},
          // Shipment status counts
          notShipped: { $sum: { $cond: [{ $eq: ['$amazonVendor.shipmentStatus', 'not_shipped'] }, 1, 0] } },
          partiallyShipped: { $sum: { $cond: [{ $eq: ['$amazonVendor.shipmentStatus', 'partially_shipped'] }, 1, 0] } },
          fullyShipped: { $sum: { $cond: [{ $eq: ['$amazonVendor.shipmentStatus', 'fully_shipped'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$amazonVendor.shipmentStatus', 'cancelled'] }, 1, 0] } },
          // Invoice Pending = Acknowledged AND shipped AND no invoice submitted
          invoicePending: { $sum: { $cond: [
            { $and: [
              { $eq: ['$amazonVendor.purchaseOrderState', 'Acknowledged'] },
              { $eq: ['$amazonVendor.shipmentStatus', 'fully_shipped'] },
              { $in: [{ $ifNull: ['$amazonVendor.invoiceStatus', 'not_submitted'] }, ['not_submitted', null]] }
            ]}, 1, 0
          ]}},
          invoiceSubmitted: { $sum: { $cond: [{ $eq: ['$amazonVendor.invoiceStatus', 'submitted'] }, 1, 0] } },
          invoiceAccepted: { $sum: { $cond: [{ $eq: ['$amazonVendor.invoiceStatus', 'accepted'] }, 1, 0] } },
          // Odoo integration
          withOdooOrder: { $sum: { $cond: [{ $ne: ['$sourceIds.odooSaleOrderId', null] }, 1, 0] } },
          totalAmount: { $sum: '$totals.total' }
        }
      }
    ]).toArray();

    // Stats by marketplace
    const byMarketplace = await collection.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$marketplace.code',
          count: { $sum: 1 },
          totalAmount: { $sum: '$totals.total' }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();

    // Recent POs (also filter out test data in production)
    const recentPOs = await collection.find(matchStage)
      .sort({ orderDate: -1 })
      .limit(10)
      .project({
        unifiedOrderId: 1,
        'sourceIds.amazonVendorPONumber': 1,
        'marketplace.code': 1,
        'amazonVendor.purchaseOrderState': 1,
        orderDate: 1,
        'totals.total': 1,
        'amazonVendor.acknowledgment.acknowledged': 1
      })
      .toArray();

    // Map to legacy field names for backward compatibility
    const mappedRecentPOs = recentPOs.map(po => ({
      purchaseOrderNumber: po.sourceIds?.amazonVendorPONumber,
      marketplaceId: po.marketplace?.code,
      purchaseOrderState: po.amazonVendor?.purchaseOrderState,
      purchaseOrderDate: po.orderDate,
      totals: { totalAmount: po.totals?.total },
      acknowledgment: { acknowledged: po.amazonVendor?.acknowledgment?.acknowledged }
    }));

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
      recentPOs: mappedRecentPOs
    };
  }

  /**
   * Update PO with Odoo order info (using unified schema)
   */
  async linkToOdooOrder(poNumber, odooOrderId, odooOrderName) {
    const collection = this.db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

    return collection.updateOne(
      { unifiedOrderId },
      {
        $set: {
          'sourceIds.odooSaleOrderId': odooOrderId,
          'sourceIds.odooSaleOrderName': odooOrderName,
          'odoo.saleOrderId': odooOrderId,
          'odoo.saleOrderName': odooOrderName,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Mark PO as acknowledged (using unified schema)
   */
  async markAcknowledged(poNumber, status = 'Accepted') {
    const collection = this.db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

    return collection.updateOne(
      { unifiedOrderId },
      {
        $set: {
          'amazonVendor.acknowledgment.acknowledged': true,
          'amazonVendor.acknowledgment.acknowledgedAt': new Date(),
          'amazonVendor.acknowledgment.status': status,
          'amazonVendor.purchaseOrderState': PO_STATES.ACKNOWLEDGED,
          'status.source': PO_STATES.ACKNOWLEDGED,
          'status.unified': UNIFIED_STATUS.CONFIRMED,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Add invoice to PO (using unified schema)
   */
  async addInvoice(poNumber, invoiceData) {
    const collection = this.db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

    return collection.updateOne(
      { unifiedOrderId },
      {
        $push: {
          'odoo.invoices': {
            id: invoiceData.odooInvoiceId,
            name: invoiceData.odooInvoiceName,
            date: invoiceData.invoiceDate || null,
            amount: invoiceData.amount || 0,
            state: invoiceData.status || 'draft',
            amazonTransactionId: invoiceData.transactionId || null,
            submittedAt: invoiceData.submittedAt || null,
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
   * Add shipment to PO (using unified schema)
   */
  async addShipment(poNumber, shipmentData) {
    const collection = this.db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

    return collection.updateOne(
      { unifiedOrderId },
      {
        $push: {
          'amazonVendor.shipments': {
            shipmentId: shipmentData.shipmentId,
            odooPickingId: shipmentData.odooPickingId,
            carrier: shipmentData.carrier,
            trackingNumber: shipmentData.trackingNumber,
            status: shipmentData.status || 'pending',
            submittedAt: shipmentData.submittedAt || null,
            createdAt: new Date()
          },
          'odoo.pickings': {
            id: shipmentData.odooPickingId,
            name: shipmentData.odooPickingName,
            state: shipmentData.status || 'pending',
            trackingRef: shipmentData.trackingNumber
          }
        },
        $set: {
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Get POs that need acknowledgment (using unified schema)
   * Excludes test data unless test mode is enabled
   */
  async getPendingAcknowledgment(limit = 50) {
    const collection = this.db.collection(COLLECTION_NAME);

    const query = {
      channel: CHANNELS.AMAZON_VENDOR,
      'amazonVendor.acknowledgment.acknowledged': false,
      'amazonVendor.purchaseOrderState': PO_STATES.NEW
    };

    // Exclude test data in production
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

    return collection.find(query)
      .sort({ orderDate: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Get POs that need Odoo orders created (using unified schema)
   * Excludes test data unless test mode is enabled
   */
  async getPendingOdooOrders(limit = 50) {
    const collection = this.db.collection(COLLECTION_NAME);

    const query = {
      channel: CHANNELS.AMAZON_VENDOR,
      'sourceIds.odooSaleOrderId': null,
      'amazonVendor.purchaseOrderState': { $ne: PO_STATES.CLOSED }
    };

    // Exclude test data in production
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

    return collection.find(query)
      .sort({ orderDate: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Get POs that are ready for invoicing (using unified schema)
   * Excludes test data unless test mode is enabled
   * Criteria:
   * - Has Odoo sale order linked
   * - No invoice linked yet
   * - Acknowledged (either locally or by Amazon state)
   */
  async getReadyForInvoicing(limit = 50) {
    const collection = this.db.collection(COLLECTION_NAME);

    const query = {
      channel: CHANNELS.AMAZON_VENDOR,
      'sourceIds.odooSaleOrderId': { $ne: null },
      $or: [
        { 'odoo.invoices': { $size: 0 } },
        { 'odoo.invoices': { $exists: false } }
      ],
      $and: [
        {
          $or: [
            { 'amazonVendor.acknowledgment.acknowledged': true },
            { 'amazonVendor.purchaseOrderState': 'Acknowledged' }
          ]
        }
      ]
    };

    // Exclude test data in production
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

    return collection.find(query)
      .sort({ orderDate: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Update line-level acknowledgment data for a PO (using unified schema)
   * @param {string} poNumber - Purchase order number
   * @param {Array} itemUpdates - Array of { itemSequenceNumber, acknowledgeQty, backorderQty, productAvailability }
   * @param {Object} scheduleData - { scheduledShipDate, scheduledDeliveryDate }
   */
  async updateLineAcknowledgments(poNumber, itemUpdates, scheduleData = {}) {
    const collection = this.db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

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
      updateData['amazonVendor.acknowledgment.scheduledShipDate'] = new Date(scheduleData.scheduledShipDate);
    }
    if (scheduleData.scheduledDeliveryDate) {
      updateData['amazonVendor.acknowledgment.scheduledDeliveryDate'] = new Date(scheduleData.scheduledDeliveryDate);
    }

    return collection.updateOne(
      { unifiedOrderId },
      { $set: updateData }
    );
  }

  /**
   * Update item with Odoo product info and stock level (using unified schema)
   * @param {string} poNumber - Purchase order number
   * @param {string} vendorProductIdentifier - SKU
   * @param {Object} productInfo - { odooProductId, odooProductName, qtyAvailable }
   */
  async updateItemProductInfo(poNumber, vendorProductIdentifier, productInfo) {
    const collection = this.db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

    return collection.updateOne(
      {
        unifiedOrderId,
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
   * Bulk update items with Odoo product info (using unified schema)
   * @param {string} poNumber - Purchase order number
   * @param {Array} productInfoList - Array of { vendorProductIdentifier, odooProductId, odooProductName, qtyAvailable }
   */
  async updateItemsProductInfo(poNumber, productInfoList) {
    const collection = this.db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

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
      { unifiedOrderId },
      {
        $set: {
          items: updatedItems,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Auto-fill acknowledgment quantities based on available stock (using unified schema)
   * Sets acknowledgeQty = min(orderedQty, qtyAvailable)
   * Sets backorderQty = remaining if backorder allowed
   * @param {string} poNumber - Purchase order number
   */
  async autoFillAcknowledgments(poNumber) {
    const collection = this.db.collection(COLLECTION_NAME);
    const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

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
      { unifiedOrderId },
      {
        $set: {
          items: updatedItems,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Sync shipment status from Odoo pickings (using unified schema)
   * Checks if orders have been delivered in Odoo and updates our shipmentStatus
   * @param {Object} options - Sync options
   * @param {boolean} options.onlyLinked - Only sync orders linked to Odoo (default: true)
   * @param {number} options.limit - Max orders to process (default: 500)
   * @returns {Object} Sync results
   */
  async syncShipmentStatusFromOdoo(options = {}) {
    const { onlyLinked = true, limit = 500 } = options;
    const collection = this.db.collection(COLLECTION_NAME);

    // Find orders that need syncing (using unified schema)
    const query = {
      channel: CHANNELS.AMAZON_VENDOR,
      'amazonVendor.shipmentStatus': { $in: ['not_shipped', 'partially_shipped', null, undefined] }
    };

    if (onlyLinked) {
      query['sourceIds.odooSaleOrderId'] = { $ne: null };
    }

    // Exclude test data
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

    const orders = await collection.find(query).limit(limit).toArray();
    console.log(`[VendorPOImporter] Syncing shipment status for ${orders.length} orders`);

    if (orders.length === 0) {
      return { synced: 0, updated: 0, errors: [] };
    }

    // Use cached Odoo client for performance
    const { getCachedOdooClient } = require('../../core/agents/integrations/OdooMCP');
    const odoo = await getCachedOdooClient();

    let updated = 0;
    const errors = [];

    // BATCH: Get all sale order IDs and fetch pickings in one query
    const saleOrderIds = orders.map(o => o.sourceIds?.odooSaleOrderId || o.odoo?.saleOrderId).filter(Boolean);

    // Fetch all pickings for these orders at once
    const allPickings = await odoo.searchRead('stock.picking',
      [
        ['sale_id', 'in', saleOrderIds],
        ['picking_type_code', '=', 'outgoing']
      ],
      ['id', 'name', 'state', 'sale_id']
    );

    // Group pickings by sale order ID
    const pickingsBySaleId = new Map();
    for (const p of allPickings) {
      const soId = p.sale_id?.[0];
      if (!soId) continue;
      if (!pickingsBySaleId.has(soId)) pickingsBySaleId.set(soId, []);
      pickingsBySaleId.get(soId).push(p);
    }

    for (const order of orders) {
      try {
        const saleOrderId = order.sourceIds?.odooSaleOrderId || order.odoo?.saleOrderId;
        if (!saleOrderId) continue;

        // Get pickings from our batch result
        const pickings = pickingsBySaleId.get(saleOrderId) || [];
        const poNumber = order.sourceIds?.amazonVendorPONumber;

        // Determine shipment status based on pickings
        let newStatus = 'not_shipped';
        if (pickings.length > 0) {
          const doneCount = pickings.filter(p => p.state === 'done').length;
          const cancelCount = pickings.filter(p => p.state === 'cancel').length;

          if (doneCount === pickings.length) {
            newStatus = 'fully_shipped';
          } else if (doneCount > 0) {
            newStatus = 'partially_shipped';
          } else if (cancelCount === pickings.length) {
            newStatus = 'cancelled';
          }
        }

        // Update if status changed
        if (newStatus !== order.amazonVendor?.shipmentStatus) {
          await collection.updateOne(
            { unifiedOrderId: order.unifiedOrderId },
            {
              $set: {
                'amazonVendor.shipmentStatus': newStatus,
                'amazonVendor.lastPickingSyncAt': new Date(),
                updatedAt: new Date()
              }
            }
          );
          console.log(`[VendorPOImporter] ${poNumber}: ${order.amazonVendor?.shipmentStatus || 'null'} -> ${newStatus}`);
          updated++;
        }
      } catch (err) {
        const poNumber = order.sourceIds?.amazonVendorPONumber;
        errors.push({ poNumber, error: err.message });
      }
    }

    console.log(`[VendorPOImporter] Sync complete: ${updated} updated, ${errors.length} errors`);
    return { synced: orders.length, updated, errors };
  }

  /**
   * Sync invoice data from Odoo to MongoDB (using unified schema)
   * Finds Odoo invoices linked to vendor sale orders and updates MongoDB
   * @param {Object} options - Sync options
   * @param {number} options.limit - Max orders to process (default: 500)
   * @returns {Object} Sync results
   */
  async syncInvoicesFromOdoo(options = {}) {
    const { limit = 500 } = options;
    const collection = this.db.collection(COLLECTION_NAME);

    console.log('[VendorPOImporter] Starting invoice sync from Odoo...');

    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    // Get Amazon Vendor team ID
    const teams = await odoo.searchRead('crm.team',
      [['name', 'ilike', 'Amazon Vendor']],
      ['id', 'name']
    );

    if (teams.length === 0) {
      console.log('[VendorPOImporter] Amazon Vendor team not found');
      return { synced: 0, updated: 0, alreadySynced: 0, errors: [] };
    }

    const teamId = teams[0].id;

    // Get vendor sale orders with invoices from Odoo
    const vendorOrders = await odoo.searchRead('sale.order',
      [
        ['team_id', '=', teamId],
        ['invoice_status', '=', 'invoiced'],
        ['client_order_ref', '!=', false]
      ],
      ['id', 'name', 'client_order_ref', 'invoice_ids'],
      limit
    );

    console.log(`[VendorPOImporter] Found ${vendorOrders.length} invoiced vendor orders in Odoo`);

    let updated = 0;
    let alreadySynced = 0;
    const errors = [];
    const updates = [];

    for (const order of vendorOrders) {
      const poNumber = order.client_order_ref;
      if (!poNumber || !order.invoice_ids || order.invoice_ids.length === 0) continue;

      const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

      try {
        // Check if MongoDB has this PO and if invoice is already linked (using unified schema)
        const mongoPO = await collection.findOne({ unifiedOrderId });

        if (!mongoPO) {
          // PO not in MongoDB - might be old or from different source
          continue;
        }

        // Check if any invoice already synced
        if (mongoPO.odoo?.invoices && mongoPO.odoo.invoices.length > 0) {
          // Already synced
          alreadySynced++;
          continue;
        }

        // Get invoice details from Odoo
        const invoices = await odoo.searchRead('account.move',
          [
            ['id', 'in', order.invoice_ids],
            ['move_type', '=', 'out_invoice'],
            ['state', '=', 'posted']
          ],
          ['id', 'name', 'invoice_date', 'amount_total']
        );

        if (invoices.length === 0) {
          // No posted invoices yet
          continue;
        }

        // Transform invoices to unified format
        const unifiedInvoices = invoices.map(inv => ({
          id: inv.id,
          name: inv.name,
          date: inv.invoice_date,
          amount: inv.amount_total,
          state: 'posted'
        }));

        // Update MongoDB with invoice info (using unified schema)
        await collection.updateOne(
          { unifiedOrderId },
          {
            $set: {
              'odoo.invoices': unifiedInvoices,
              'odoo.lastInvoiceSyncAt': new Date(),
              updatedAt: new Date()
            }
          }
        );

        updates.push({
          poNumber,
          saleOrder: order.name,
          invoiceCount: invoices.length,
          invoices: unifiedInvoices
        });

        console.log(`[VendorPOImporter] ${poNumber}: Linked ${invoices.length} invoice(s)`);
        updated++;

      } catch (err) {
        errors.push({ poNumber, error: err.message });
        console.error(`[VendorPOImporter] Error syncing ${poNumber}:`, err.message);
      }
    }

    console.log(`[VendorPOImporter] Invoice sync complete: ${updated} updated, ${alreadySynced} already synced, ${errors.length} errors`);

    return {
      synced: vendorOrders.length,
      updated,
      alreadySynced,
      errors,
      updates
    };
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
