/**
 * OdooSyncService - Maintains a MongoDB mirror of Odoo data
 *
 * This service keeps MongoDB collections in sync with Odoo models,
 * enabling fast queries and cross-entity lookups without hitting Odoo API.
 *
 * Sync strategies:
 * - Incremental: Uses write_date to sync only changed records (every 5-15 min)
 * - Full: Complete resync to catch any drift (daily)
 * - Write-through: Immediate MongoDB update when Agent5 writes to Odoo
 */

const { getDb } = require('../../db');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// Model configurations - define which Odoo models to sync and how
const MODEL_CONFIGS = {
  'sale.order': {
    collection: 'odoo_orders',
    fields: [
      'id', 'name', 'state', 'date_order', 'partner_id', 'partner_invoice_id',
      'partner_shipping_id', 'warehouse_id', 'client_order_ref', 'origin',
      'amount_untaxed', 'amount_tax', 'amount_total', 'invoice_status',
      'delivery_status', 'team_id', 'user_id', 'company_id',
      'picking_ids', 'invoice_ids', 'order_line',
      'create_date', 'write_date'
    ],
    indexes: [
      { key: { odooId: 1 }, unique: true },
      { key: { name: 1 } },
      { key: { clientOrderRef: 1 } },
      { key: { partnerId: 1 } },
      { key: { state: 1 } },
      { key: { dateOrder: -1 } },
      { key: { writeDate: -1 } }
    ],
    // Transform Odoo field names to MongoDB field names
    transform: (record) => ({
      odooId: record.id,
      name: record.name,
      state: record.state,
      dateOrder: record.date_order ? new Date(record.date_order) : null,
      partnerId: record.partner_id?.[0] || null,
      partnerName: record.partner_id?.[1] || null,
      partnerInvoiceId: record.partner_invoice_id?.[0] || null,
      partnerShippingId: record.partner_shipping_id?.[0] || null,
      warehouseId: record.warehouse_id?.[0] || null,
      warehouseName: record.warehouse_id?.[1] || null,
      clientOrderRef: record.client_order_ref || null,
      origin: record.origin || null,
      amountUntaxed: record.amount_untaxed || 0,
      amountTax: record.amount_tax || 0,
      amountTotal: record.amount_total || 0,
      invoiceStatus: record.invoice_status || null,
      deliveryStatus: record.delivery_status || null,
      teamId: record.team_id?.[0] || null,
      teamName: record.team_id?.[1] || null,
      userId: record.user_id?.[0] || null,
      companyId: record.company_id?.[0] || null,
      pickingIds: record.picking_ids || [],
      invoiceIds: record.invoice_ids || [],
      orderLineIds: record.order_line || [],
      createDate: record.create_date ? new Date(record.create_date) : null,
      writeDate: record.write_date ? new Date(record.write_date) : null
    })
  },

  'res.partner': {
    collection: 'odoo_partners',
    fields: [
      'id', 'name', 'display_name', 'email', 'phone', 'mobile',
      'street', 'street2', 'city', 'zip', 'state_id', 'country_id',
      'vat', 'company_type', 'is_company', 'parent_id',
      'customer_rank', 'supplier_rank', 'active',
      'property_product_pricelist', 'property_payment_term_id',
      'create_date', 'write_date'
    ],
    indexes: [
      { key: { odooId: 1 }, unique: true },
      { key: { name: 1 } },
      { key: { email: 1 } },
      { key: { vat: 1 } },
      { key: { customerRank: 1 } },
      { key: { supplierRank: 1 } },
      { key: { writeDate: -1 } }
    ],
    transform: (record) => ({
      odooId: record.id,
      name: record.name,
      displayName: record.display_name,
      email: record.email || null,
      phone: record.phone || null,
      mobile: record.mobile || null,
      street: record.street || null,
      street2: record.street2 || null,
      city: record.city || null,
      zip: record.zip || null,
      stateId: record.state_id?.[0] || null,
      stateName: record.state_id?.[1] || null,
      countryId: record.country_id?.[0] || null,
      countryName: record.country_id?.[1] || null,
      vat: record.vat || null,
      companyType: record.company_type || null,
      isCompany: record.is_company || false,
      parentId: record.parent_id?.[0] || null,
      customerRank: record.customer_rank || 0,
      supplierRank: record.supplier_rank || 0,
      active: record.active !== false,
      pricelistId: record.property_product_pricelist?.[0] || null,
      paymentTermId: record.property_payment_term_id?.[0] || null,
      createDate: record.create_date ? new Date(record.create_date) : null,
      writeDate: record.write_date ? new Date(record.write_date) : null
    })
  },

  'product.product': {
    collection: 'odoo_products',
    fields: [
      'id', 'name', 'display_name', 'default_code', 'barcode',
      'list_price', 'standard_price', 'type', 'categ_id',
      'qty_available', 'virtual_available', 'incoming_qty', 'outgoing_qty',
      'uom_id', 'weight', 'volume', 'active',
      'product_tmpl_id', 'seller_ids',
      'create_date', 'write_date'
    ],
    indexes: [
      { key: { odooId: 1 }, unique: true },
      { key: { sku: 1 } },
      { key: { barcode: 1 } },
      { key: { name: 1 } },
      { key: { categoryId: 1 } },
      { key: { active: 1 } },
      { key: { writeDate: -1 } }
    ],
    transform: (record) => ({
      odooId: record.id,
      name: record.name,
      displayName: record.display_name,
      sku: record.default_code || null,
      barcode: record.barcode || null,
      listPrice: record.list_price || 0,
      costPrice: record.standard_price || 0,
      type: record.type || null,
      categoryId: record.categ_id?.[0] || null,
      categoryName: record.categ_id?.[1] || null,
      qtyAvailable: record.qty_available || 0,
      qtyVirtual: record.virtual_available || 0,
      qtyIncoming: record.incoming_qty || 0,
      qtyOutgoing: record.outgoing_qty || 0,
      uomId: record.uom_id?.[0] || null,
      uomName: record.uom_id?.[1] || null,
      weight: record.weight || 0,
      volume: record.volume || 0,
      active: record.active !== false,
      templateId: record.product_tmpl_id?.[0] || null,
      sellerIds: record.seller_ids || [],
      createDate: record.create_date ? new Date(record.create_date) : null,
      writeDate: record.write_date ? new Date(record.write_date) : null
    })
  },

  'stock.picking': {
    collection: 'odoo_deliveries',
    fields: [
      'id', 'name', 'state', 'origin', 'partner_id',
      'picking_type_id', 'location_id', 'location_dest_id',
      'scheduled_date', 'date_done', 'carrier_id', 'carrier_tracking_ref',
      'sale_id', 'purchase_id', 'move_ids', 'move_line_ids',
      'create_date', 'write_date'
    ],
    indexes: [
      { key: { odooId: 1 }, unique: true },
      { key: { name: 1 } },
      { key: { origin: 1 } },
      { key: { state: 1 } },
      { key: { saleId: 1 } },
      { key: { partnerId: 1 } },
      { key: { carrierTrackingRef: 1 } },
      { key: { writeDate: -1 } }
    ],
    transform: (record) => ({
      odooId: record.id,
      name: record.name,
      state: record.state,
      origin: record.origin || null,
      partnerId: record.partner_id?.[0] || null,
      partnerName: record.partner_id?.[1] || null,
      pickingTypeId: record.picking_type_id?.[0] || null,
      pickingTypeName: record.picking_type_id?.[1] || null,
      locationId: record.location_id?.[0] || null,
      locationName: record.location_id?.[1] || null,
      locationDestId: record.location_dest_id?.[0] || null,
      locationDestName: record.location_dest_id?.[1] || null,
      scheduledDate: record.scheduled_date ? new Date(record.scheduled_date) : null,
      dateDone: record.date_done ? new Date(record.date_done) : null,
      carrierId: record.carrier_id?.[0] || null,
      carrierName: record.carrier_id?.[1] || null,
      carrierTrackingRef: record.carrier_tracking_ref || null,
      saleId: record.sale_id?.[0] || null,
      saleName: record.sale_id?.[1] || null,
      purchaseId: record.purchase_id?.[0] || null,
      moveIds: record.move_ids || [],
      moveLineIds: record.move_line_ids || [],
      createDate: record.create_date ? new Date(record.create_date) : null,
      writeDate: record.write_date ? new Date(record.write_date) : null
    })
  },

  'account.move': {
    collection: 'odoo_invoices',
    fields: [
      'id', 'name', 'state', 'move_type', 'partner_id',
      'invoice_date', 'invoice_date_due', 'date', 'ref',
      'amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual',
      'payment_state', 'journal_id', 'company_id', 'team_id',
      'invoice_origin', 'invoice_line_ids',
      'create_date', 'write_date'
    ],
    indexes: [
      { key: { odooId: 1 }, unique: true },
      { key: { name: 1 } },
      { key: { ref: 1 } },
      { key: { invoiceOrigin: 1 } },
      { key: { partnerId: 1 } },
      { key: { state: 1 } },
      { key: { moveType: 1 } },
      { key: { invoiceDate: -1 } },
      { key: { writeDate: -1 } }
    ],
    transform: (record) => ({
      odooId: record.id,
      name: record.name,
      state: record.state,
      moveType: record.move_type,
      partnerId: record.partner_id?.[0] || null,
      partnerName: record.partner_id?.[1] || null,
      invoiceDate: record.invoice_date ? new Date(record.invoice_date) : null,
      invoiceDateDue: record.invoice_date_due ? new Date(record.invoice_date_due) : null,
      date: record.date ? new Date(record.date) : null,
      ref: record.ref || null,
      amountUntaxed: record.amount_untaxed || 0,
      amountTax: record.amount_tax || 0,
      amountTotal: record.amount_total || 0,
      amountResidual: record.amount_residual || 0,
      paymentState: record.payment_state || null,
      journalId: record.journal_id?.[0] || null,
      journalName: record.journal_id?.[1] || null,
      companyId: record.company_id?.[0] || null,
      teamId: record.team_id?.[0] || null,
      teamName: record.team_id?.[1] || null,
      invoiceOrigin: record.invoice_origin || null,
      invoiceLineIds: record.invoice_line_ids || [],
      createDate: record.create_date ? new Date(record.create_date) : null,
      writeDate: record.write_date ? new Date(record.write_date) : null
    })
  },

  'stock.warehouse': {
    collection: 'odoo_warehouses',
    fields: [
      'id', 'name', 'code', 'active', 'company_id',
      'partner_id', 'lot_stock_id', 'view_location_id',
      'create_date', 'write_date'
    ],
    indexes: [
      { key: { odooId: 1 }, unique: true },
      { key: { code: 1 } },
      { key: { name: 1 } }
    ],
    transform: (record) => ({
      odooId: record.id,
      name: record.name,
      code: record.code,
      active: record.active !== false,
      companyId: record.company_id?.[0] || null,
      partnerId: record.partner_id?.[0] || null,
      lotStockId: record.lot_stock_id?.[0] || null,
      viewLocationId: record.view_location_id?.[0] || null,
      createDate: record.create_date ? new Date(record.create_date) : null,
      writeDate: record.write_date ? new Date(record.write_date) : null
    })
  },

  'purchase.order': {
    collection: 'odoo_purchase_orders',
    fields: [
      'id', 'name', 'state', 'partner_id', 'date_order', 'date_planned',
      'origin', 'amount_untaxed', 'amount_tax', 'amount_total',
      'invoice_status', 'picking_ids', 'invoice_ids', 'order_line',
      'company_id', 'user_id',
      'create_date', 'write_date'
    ],
    indexes: [
      { key: { odooId: 1 }, unique: true },
      { key: { name: 1 } },
      { key: { partnerId: 1 } },
      { key: { state: 1 } },
      { key: { dateOrder: -1 } },
      { key: { writeDate: -1 } }
    ],
    transform: (record) => ({
      odooId: record.id,
      name: record.name,
      state: record.state,
      partnerId: record.partner_id?.[0] || null,
      partnerName: record.partner_id?.[1] || null,
      dateOrder: record.date_order ? new Date(record.date_order) : null,
      datePlanned: record.date_planned ? new Date(record.date_planned) : null,
      origin: record.origin || null,
      amountUntaxed: record.amount_untaxed || 0,
      amountTax: record.amount_tax || 0,
      amountTotal: record.amount_total || 0,
      invoiceStatus: record.invoice_status || null,
      pickingIds: record.picking_ids || [],
      invoiceIds: record.invoice_ids || [],
      orderLineIds: record.order_line || [],
      companyId: record.company_id?.[0] || null,
      userId: record.user_id?.[0] || null,
      createDate: record.create_date ? new Date(record.create_date) : null,
      writeDate: record.write_date ? new Date(record.write_date) : null
    })
  }
};

class OdooSyncService {
  constructor() {
    this.odoo = null;
    this.db = null;
    this.syncStatus = new Map(); // Track sync status per model
  }

  /**
   * Initialize the service
   */
  async init() {
    if (this.db) return;

    this.db = getDb();
    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    // Ensure indexes exist for all models
    await this.ensureIndexes();
  }

  /**
   * Create indexes for all model collections
   */
  async ensureIndexes() {
    console.log('[OdooSync] Ensuring indexes...');

    for (const [, config] of Object.entries(MODEL_CONFIGS)) {
      const collection = this.db.collection(config.collection);

      for (const indexSpec of config.indexes) {
        try {
          await collection.createIndex(indexSpec.key, {
            unique: indexSpec.unique || false,
            background: true
          });
        } catch (err) {
          // Index might already exist with different options
          if (!err.message.includes('already exists')) {
            console.error(`[OdooSync] Error creating index on ${config.collection}:`, err.message);
          }
        }
      }
    }

    console.log('[OdooSync] Indexes ensured');
  }

  /**
   * Get model configuration
   */
  getModelConfig(modelName) {
    const config = MODEL_CONFIGS[modelName];
    if (!config) {
      throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
    }
    return config;
  }

  /**
   * Sync a specific model incrementally (only changed records)
   * @param {string} modelName - Odoo model name (e.g., 'sale.order')
   * @param {Object} options - Sync options
   * @param {Date} options.since - Only sync records changed after this date
   * @param {number} options.batchSize - Number of records per batch (default: 500)
   * @param {Array} options.domain - Additional Odoo domain filters
   */
  async syncModel(modelName, options = {}) {
    await this.init();

    const config = this.getModelConfig(modelName);
    const collection = this.db.collection(config.collection);

    const batchSize = options.batchSize || 500;
    const since = options.since || await this.getLastSyncDate(modelName);
    const additionalDomain = options.domain || [];

    // Build domain
    const domain = [...additionalDomain];
    if (since) {
      domain.push(['write_date', '>', since.toISOString().replace('T', ' ').slice(0, 19)]);
    }

    console.log(`[OdooSync] Syncing ${modelName} (since: ${since?.toISOString() || 'full sync'})...`);

    let offset = 0;
    let totalSynced = 0;
    let hasMore = true;

    const startTime = Date.now();

    while (hasMore) {
      // Fetch batch from Odoo
      const records = await this.odoo.searchRead(
        modelName,
        domain,
        config.fields,
        { limit: batchSize, offset, order: 'write_date asc' }
      );

      if (records.length === 0) {
        hasMore = false;
        break;
      }

      // Transform and upsert records
      const bulkOps = records.map(record => {
        const transformed = config.transform(record);
        transformed._syncedAt = new Date();

        return {
          updateOne: {
            filter: { odooId: record.id },
            update: { $set: transformed },
            upsert: true
          }
        };
      });

      if (bulkOps.length > 0) {
        await collection.bulkWrite(bulkOps, { ordered: false });
      }

      totalSynced += records.length;
      offset += batchSize;

      // Check if we got a full batch (might be more)
      hasMore = records.length === batchSize;

      // Log progress for large syncs
      if (totalSynced % 1000 === 0) {
        console.log(`[OdooSync] ${modelName}: ${totalSynced} records synced...`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[OdooSync] ${modelName}: ${totalSynced} records synced in ${duration}s`);

    // Update sync status
    await this.updateSyncStatus(modelName, totalSynced);

    return { model: modelName, synced: totalSynced, duration: parseFloat(duration) };
  }

  /**
   * Get the last sync date for a model
   */
  async getLastSyncDate(modelName) {
    const config = this.getModelConfig(modelName);
    const collection = this.db.collection(config.collection);

    const latest = await collection.findOne(
      {},
      { sort: { writeDate: -1 }, projection: { writeDate: 1 } }
    );

    return latest?.writeDate || null;
  }

  /**
   * Update sync status tracking
   */
  async updateSyncStatus(modelName, recordCount) {
    const statusCollection = this.db.collection('odoo_sync_status');

    await statusCollection.updateOne(
      { model: modelName },
      {
        $set: {
          model: modelName,
          lastSyncAt: new Date(),
          lastSyncCount: recordCount
        },
        $inc: { totalSyncs: 1 }
      },
      { upsert: true }
    );
  }

  /**
   * Sync all configured models incrementally
   */
  async incrementalSync() {
    await this.init();

    console.log('[OdooSync] Starting incremental sync...');
    const startTime = Date.now();
    const results = [];

    for (const modelName of Object.keys(MODEL_CONFIGS)) {
      try {
        const result = await this.syncModel(modelName);
        results.push(result);
      } catch (err) {
        console.error(`[OdooSync] Error syncing ${modelName}:`, err.message);
        results.push({ model: modelName, error: err.message });
      }
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[OdooSync] Incremental sync complete in ${totalDuration}s`);

    return { type: 'incremental', duration: parseFloat(totalDuration), results };
  }

  /**
   * Full sync of all models (ignores last sync date)
   */
  async fullSync() {
    await this.init();

    console.log('[OdooSync] Starting FULL sync...');
    const startTime = Date.now();
    const results = [];

    for (const modelName of Object.keys(MODEL_CONFIGS)) {
      try {
        const result = await this.syncModel(modelName, { since: null });
        results.push(result);
      } catch (err) {
        console.error(`[OdooSync] Error syncing ${modelName}:`, err.message);
        results.push({ model: modelName, error: err.message });
      }
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[OdooSync] Full sync complete in ${totalDuration}s`);

    return { type: 'full', duration: parseFloat(totalDuration), results };
  }

  /**
   * Sync a specific record by Odoo ID
   */
  async syncRecord(modelName, odooId) {
    await this.init();

    const config = this.getModelConfig(modelName);
    const collection = this.db.collection(config.collection);

    const records = await this.odoo.searchRead(
      modelName,
      [['id', '=', odooId]],
      config.fields,
      { limit: 1 }
    );

    if (records.length === 0) {
      // Record doesn't exist in Odoo - remove from MongoDB
      await collection.deleteOne({ odooId });
      return null;
    }

    const transformed = config.transform(records[0]);
    transformed._syncedAt = new Date();

    await collection.updateOne(
      { odooId },
      { $set: transformed },
      { upsert: true }
    );

    return transformed;
  }

  /**
   * Write-through: Update Odoo and immediately sync to MongoDB
   * Use this when Agent5 creates/updates Odoo records
   */
  async writeThrough(modelName, odooId, updateData) {
    await this.init();

    // Update in Odoo
    await this.odoo.write(modelName, [odooId], updateData);

    // Immediately sync the record to MongoDB
    return this.syncRecord(modelName, odooId);
  }

  /**
   * Create in Odoo and sync to MongoDB
   */
  async createAndSync(modelName, data) {
    await this.init();

    // Create in Odoo
    const odooId = await this.odoo.create(modelName, data);

    // Sync to MongoDB
    const synced = await this.syncRecord(modelName, odooId);

    return { odooId, synced };
  }

  // ============================================
  // Query Methods - Read from MongoDB
  // ============================================

  /**
   * Get a record by Odoo ID
   */
  async getByOdooId(modelName, odooId, options = {}) {
    await this.init();

    const config = this.getModelConfig(modelName);
    const collection = this.db.collection(config.collection);

    let record = await collection.findOne({ odooId });

    // If not found and refreshIfMissing is true, try syncing from Odoo
    if (!record && options.refreshIfMissing) {
      record = await this.syncRecord(modelName, odooId);
    }

    return record;
  }

  /**
   * Find records by a field value
   */
  async findByField(modelName, field, value, options = {}) {
    await this.init();

    const config = this.getModelConfig(modelName);
    const collection = this.db.collection(config.collection);

    const query = { [field]: value };
    const opts = {
      limit: options.limit || 100,
      sort: options.sort || { writeDate: -1 }
    };

    return collection.find(query).sort(opts.sort).limit(opts.limit).toArray();
  }

  /**
   * Find orders by Amazon order ID (client_order_ref)
   */
  async findOrderByAmazonId(amazonOrderId) {
    const results = await this.findByField('sale.order', 'clientOrderRef', amazonOrderId, { limit: 1 });
    return results[0] || null;
  }

  /**
   * Find partner by VAT number
   */
  async findPartnerByVat(vat) {
    const results = await this.findByField('res.partner', 'vat', vat, { limit: 1 });
    return results[0] || null;
  }

  /**
   * Find product by SKU
   */
  async findProductBySku(sku) {
    const results = await this.findByField('product.product', 'sku', sku, { limit: 1 });
    return results[0] || null;
  }

  /**
   * Find product by barcode
   */
  async findProductByBarcode(barcode) {
    const results = await this.findByField('product.product', 'barcode', barcode, { limit: 1 });
    return results[0] || null;
  }

  /**
   * Find deliveries by sale order ID
   */
  async findDeliveriesBySaleId(saleOrderOdooId) {
    return await this.findByField('stock.picking', 'saleId', saleOrderOdooId);
  }

  /**
   * Find invoices by origin (sale order name)
   */
  async findInvoicesByOrigin(origin) {
    return await this.findByField('account.move', 'invoiceOrigin', origin);
  }

  /**
   * Query with custom filter
   */
  async query(modelName, filter, options = {}) {
    await this.init();

    const config = this.getModelConfig(modelName);
    const collection = this.db.collection(config.collection);

    let cursor = collection.find(filter);

    if (options.sort) cursor = cursor.sort(options.sort);
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    if (options.projection) cursor = cursor.project(options.projection);

    return cursor.toArray();
  }

  /**
   * Count records matching a filter
   */
  async count(modelName, filter = {}) {
    await this.init();

    const config = this.getModelConfig(modelName);
    const collection = this.db.collection(config.collection);

    return collection.countDocuments(filter);
  }

  // ============================================
  // Status & Diagnostics
  // ============================================

  /**
   * Get sync status for all models
   */
  async getSyncStatus() {
    await this.init();

    const statusCollection = this.db.collection('odoo_sync_status');
    const statuses = await statusCollection.find({}).toArray();

    const result = {};
    for (const status of statuses) {
      result[status.model] = {
        lastSyncAt: status.lastSyncAt,
        lastSyncCount: status.lastSyncCount,
        totalSyncs: status.totalSyncs
      };
    }

    // Add record counts
    for (const [modelName, config] of Object.entries(MODEL_CONFIGS)) {
      const collection = this.db.collection(config.collection);
      const count = await collection.countDocuments({});

      if (!result[modelName]) {
        result[modelName] = { lastSyncAt: null, lastSyncCount: 0, totalSyncs: 0 };
      }
      result[modelName].totalRecords = count;
    }

    return result;
  }

  /**
   * Check data freshness - find records that might be stale
   */
  async checkFreshness(modelName, maxAgeMinutes = 60) {
    await this.init();

    const config = this.getModelConfig(modelName);
    const collection = this.db.collection(config.collection);

    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);

    const staleCount = await collection.countDocuments({
      _syncedAt: { $lt: cutoff }
    });

    const totalCount = await collection.countDocuments({});

    return {
      model: modelName,
      total: totalCount,
      stale: staleCount,
      fresh: totalCount - staleCount,
      stalePercentage: totalCount > 0 ? ((staleCount / totalCount) * 100).toFixed(1) : 0
    };
  }
}

// Singleton instance
let instance = null;

function getOdooSyncService() {
  if (!instance) {
    instance = new OdooSyncService();
  }
  return instance;
}

module.exports = {
  OdooSyncService,
  getOdooSyncService,
  MODEL_CONFIGS
};
