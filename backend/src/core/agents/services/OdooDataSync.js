/**
 * OdooDataSync Service
 *
 * Synchronizes data from Odoo ERP to MongoDB for the Purchasing Intelligence Agent.
 * Syncs:
 * - Products (with stock levels, costs, dimensions)
 * - Invoice lines (INVOICED quantities - source of truth for sales)
 * - Purchase orders (pending and historical)
 * - Suppliers (with lead times, MOQs)
 * - Stock movements
 *
 * Data is synced every 6 hours by default, with ability to force sync.
 */

const cron = require('node-cron');

class OdooDataSync {
  constructor(config = {}) {
    this.odooClient = config.odooClient || null;
    this.db = config.db || null;

    // Collection names
    this.collections = {
      products: 'purchasing_products',
      invoiceLines: 'purchasing_invoice_lines',
      purchaseOrders: 'purchasing_orders',
      suppliers: 'purchasing_suppliers',
      stockMoves: 'purchasing_stock_moves',
      syncLog: 'purchasing_sync_log',
    };

    // Sync configuration
    this.config = {
      syncIntervalHours: config.syncIntervalHours || 6,
      batchSize: config.batchSize || 500,
      invoiceHistoryDays: config.invoiceHistoryDays || 730, // 2 years
      stockMoveHistoryDays: config.stockMoveHistoryDays || 365, // 1 year
    };

    // Sync status
    this.syncStatus = {
      isRunning: false,
      lastSync: null,
      lastError: null,
      stats: {},
    };

    // Cron job reference
    this.cronJob = null;
  }

  /**
   * Initialize the sync service
   */
  async init(odooClient, db) {
    this.odooClient = odooClient;
    this.db = db;

    // Create indexes for efficient queries
    await this._createIndexes();

    // Check last sync time
    const lastSync = await this._getLastSyncTime();
    this.syncStatus.lastSync = lastSync;

    console.log('OdooDataSync initialized. Last sync:', lastSync || 'Never');
  }

  /**
   * Create MongoDB indexes for efficient queries
   */
  async _createIndexes() {
    if (!this.db) return;

    try {
      // Products indexes
      const products = this.db.collection(this.collections.products);
      await products.createIndex({ odooId: 1 }, { unique: true });
      await products.createIndex({ sku: 1 });
      await products.createIndex({ supplierId: 1 });
      await products.createIndex({ lastUpdated: -1 });

      // Invoice lines indexes
      const invoiceLines = this.db.collection(this.collections.invoiceLines);
      await invoiceLines.createIndex({ productId: 1, invoiceDate: -1 });
      await invoiceLines.createIndex({ invoiceDate: -1 });
      await invoiceLines.createIndex({ odooInvoiceId: 1 });

      // Purchase orders indexes
      const purchaseOrders = this.db.collection(this.collections.purchaseOrders);
      await purchaseOrders.createIndex({ odooId: 1 }, { unique: true });
      await purchaseOrders.createIndex({ state: 1 });
      await purchaseOrders.createIndex({ supplierId: 1 });

      // Suppliers indexes
      const suppliers = this.db.collection(this.collections.suppliers);
      await suppliers.createIndex({ odooId: 1 }, { unique: true });

      // Stock moves indexes
      const stockMoves = this.db.collection(this.collections.stockMoves);
      await stockMoves.createIndex({ productId: 1, date: -1 });
      await stockMoves.createIndex({ date: -1 });

      console.log('OdooDataSync indexes created');
    } catch (error) {
      console.error('Error creating indexes:', error.message);
    }
  }

  /**
   * Start the scheduled sync job
   */
  startScheduledSync() {
    if (this.cronJob) {
      this.cronJob.stop();
    }

    // Run every N hours
    const cronExpression = `0 */${this.config.syncIntervalHours} * * *`;

    this.cronJob = cron.schedule(cronExpression, async () => {
      console.log('Running scheduled Odoo data sync...');
      try {
        await this.syncAll();
      } catch (error) {
        console.error('Scheduled sync failed:', error.message);
      }
    });

    console.log(`Odoo sync scheduled every ${this.config.syncIntervalHours} hours`);

    // Run initial sync if never synced or last sync was more than interval ago
    this._checkInitialSync();
  }

  /**
   * Check if initial sync is needed
   */
  async _checkInitialSync() {
    const lastSync = await this._getLastSyncTime();

    if (!lastSync) {
      console.log('No previous sync found, running initial sync...');
      this.syncAll().catch(err => console.error('Initial sync failed:', err.message));
      return;
    }

    const hoursSinceLastSync = (Date.now() - new Date(lastSync).getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastSync > this.config.syncIntervalHours) {
      console.log(`Last sync was ${Math.round(hoursSinceLastSync)} hours ago, running sync...`);
      this.syncAll().catch(err => console.error('Catch-up sync failed:', err.message));
    }
  }

  /**
   * Stop the scheduled sync
   */
  stopScheduledSync() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log('Odoo sync stopped');
    }
  }

  /**
   * Sync all data from Odoo
   */
  async syncAll() {
    if (this.syncStatus.isRunning) {
      console.log('Sync already in progress, skipping...');
      return { skipped: true, reason: 'Sync already in progress' };
    }

    if (!this.odooClient || !this.db) {
      throw new Error('OdooDataSync not initialized. Call init() first.');
    }

    this.syncStatus.isRunning = true;
    this.syncStatus.lastError = null;
    const startTime = Date.now();
    const stats = {};

    try {
      console.log('Starting full Odoo data sync...');

      // Sync in order of dependencies
      stats.suppliers = await this.syncSuppliers();
      stats.products = await this.syncProducts();
      stats.invoiceLines = await this.syncInvoiceLines();
      stats.purchaseOrders = await this.syncPurchaseOrders();
      stats.stockMoves = await this.syncStockMoves();

      // Log sync completion
      const duration = (Date.now() - startTime) / 1000;
      stats.duration = duration;

      await this._logSync('success', stats);

      this.syncStatus.lastSync = new Date();
      this.syncStatus.stats = stats;

      console.log(`Odoo sync completed in ${duration.toFixed(1)}s:`, stats);

      return { success: true, stats };
    } catch (error) {
      this.syncStatus.lastError = error.message;
      await this._logSync('error', { error: error.message });

      console.error('Odoo sync failed:', error.message);
      throw error;
    } finally {
      this.syncStatus.isRunning = false;
    }
  }

  /**
   * Sync suppliers from Odoo
   */
  async syncSuppliers() {
    console.log('Syncing suppliers...');

    const suppliers = await this.odooClient.searchRead('res.partner', [
      ['supplier_rank', '>', 0],
    ], [
      'name', 'email', 'phone', 'country_id', 'city',
      'supplier_rank', 'active',
    ], { limit: 10000 });

    const collection = this.db.collection(this.collections.suppliers);
    let updated = 0;
    let inserted = 0;

    for (const supplier of suppliers) {
      const doc = {
        odooId: supplier.id,
        name: supplier.name,
        email: supplier.email || null,
        phone: supplier.phone || null,
        country: supplier.country_id?.[1] || null,
        city: supplier.city || null,
        active: supplier.active,
        lastUpdated: new Date(),
      };

      const result = await collection.updateOne(
        { odooId: supplier.id },
        { $set: doc },
        { upsert: true }
      );

      if (result.upsertedCount > 0) inserted++;
      else if (result.modifiedCount > 0) updated++;
    }

    console.log(`Suppliers synced: ${inserted} inserted, ${updated} updated`);
    return { total: suppliers.length, inserted, updated };
  }

  /**
   * Sync products with stock levels and supplier info
   */
  async syncProducts() {
    console.log('Syncing products...');

    // Get all stockable products
    const products = await this.odooClient.searchRead('product.product', [
      ['type', '=', 'product'],
      ['active', '=', true],
    ], [
      'name', 'default_code', 'barcode', 'categ_id',
      'qty_available', 'virtual_available', 'incoming_qty', 'outgoing_qty',
      'standard_price', 'list_price',
      'volume', 'weight',
      'seller_ids', 'active',
    ], { limit: 50000 });

    // Get supplier info for all products
    const supplierInfos = await this.odooClient.searchRead('product.supplierinfo', [], [
      'product_tmpl_id', 'partner_id', 'price', 'min_qty', 'delay', 'currency_id',
    ], { limit: 100000 });

    // Build supplier info map by product template
    const supplierInfoMap = new Map();
    for (const info of supplierInfos) {
      const tmplId = info.product_tmpl_id?.[0];
      if (tmplId) {
        if (!supplierInfoMap.has(tmplId)) {
          supplierInfoMap.set(tmplId, []);
        }
        supplierInfoMap.get(tmplId).push({
          supplierId: info.partner_id?.[0],
          supplierName: info.partner_id?.[1],
          price: info.price,
          moq: info.min_qty,
          leadTimeDays: info.delay,
          currency: info.currency_id?.[1],
        });
      }
    }

    const collection = this.db.collection(this.collections.products);
    let updated = 0;
    let inserted = 0;

    for (const product of products) {
      // Get supplier info for this product
      const productSuppliers = supplierInfoMap.get(product.id) || [];
      const primarySupplier = productSuppliers[0] || null;

      const doc = {
        odooId: product.id,
        name: product.name,
        sku: product.default_code || null,
        barcode: product.barcode || null,
        category: product.categ_id?.[1] || null,
        categoryId: product.categ_id?.[0] || null,

        // Stock levels
        stock: {
          available: product.qty_available || 0,
          forecasted: product.virtual_available || 0,
          incoming: product.incoming_qty || 0,
          outgoing: product.outgoing_qty || 0,
        },

        // Pricing
        cost: product.standard_price || 0,
        listPrice: product.list_price || 0,

        // Dimensions (for container calculations)
        volume: product.volume || null,
        weight: product.weight || null,

        // Supplier info
        suppliers: productSuppliers,
        primarySupplier: primarySupplier ? {
          id: primarySupplier.supplierId,
          name: primarySupplier.supplierName,
          price: primarySupplier.price,
          moq: primarySupplier.moq,
          leadTimeDays: primarySupplier.leadTimeDays,
        } : null,

        active: product.active,
        lastUpdated: new Date(),
      };

      const result = await collection.updateOne(
        { odooId: product.id },
        { $set: doc },
        { upsert: true }
      );

      if (result.upsertedCount > 0) inserted++;
      else if (result.modifiedCount > 0) updated++;
    }

    console.log(`Products synced: ${inserted} inserted, ${updated} updated`);
    return { total: products.length, inserted, updated };
  }

  /**
   * Sync invoice lines (INVOICED quantities - source of truth)
   */
  async syncInvoiceLines() {
    console.log('Syncing invoice lines...');

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.invoiceHistoryDays);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    // Get posted customer invoices
    const invoices = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['invoice_date', '>=', cutoffStr],
    ], [
      'name', 'invoice_date', 'partner_id', 'amount_total', 'currency_id',
    ], { limit: 100000 });

    const invoiceMap = new Map(invoices.map(inv => [inv.id, inv]));
    const invoiceIds = invoices.map(inv => inv.id);

    if (invoiceIds.length === 0) {
      console.log('No invoices found in date range');
      return { total: 0, inserted: 0, updated: 0 };
    }

    // Get invoice lines for these invoices
    const invoiceLines = await this.odooClient.searchRead('account.move.line', [
      ['move_id', 'in', invoiceIds],
      ['product_id', '!=', false],
      ['quantity', '!=', 0],
    ], [
      'move_id', 'product_id', 'quantity', 'price_unit', 'price_subtotal',
      'discount', 'create_date',
    ], { limit: 500000 });

    const collection = this.db.collection(this.collections.invoiceLines);

    // Clear old data and insert fresh (more efficient for large datasets)
    await collection.deleteMany({ invoiceDate: { $gte: cutoffDate } });

    const docs = invoiceLines.map(line => {
      const invoice = invoiceMap.get(line.move_id[0]);
      return {
        odooLineId: line.id,
        odooInvoiceId: line.move_id[0],
        invoiceName: invoice?.name || null,
        invoiceDate: invoice?.invoice_date ? new Date(invoice.invoice_date) : null,
        customerId: invoice?.partner_id?.[0] || null,
        customerName: invoice?.partner_id?.[1] || null,
        productId: line.product_id[0],
        productName: line.product_id[1],
        quantity: Math.abs(line.quantity), // Always positive
        priceUnit: line.price_unit,
        subtotal: Math.abs(line.price_subtotal),
        discount: line.discount || 0,
        createdAt: new Date(line.create_date),
        syncedAt: new Date(),
      };
    });

    if (docs.length > 0) {
      // Insert in batches
      for (let i = 0; i < docs.length; i += this.config.batchSize) {
        const batch = docs.slice(i, i + this.config.batchSize);
        await collection.insertMany(batch, { ordered: false });
      }
    }

    console.log(`Invoice lines synced: ${docs.length} records`);
    return { total: docs.length, inserted: docs.length, updated: 0 };
  }

  /**
   * Sync purchase orders
   */
  async syncPurchaseOrders() {
    console.log('Syncing purchase orders...');

    // Get all purchase orders (all states for history)
    const orders = await this.odooClient.searchRead('purchase.order', [], [
      'name', 'partner_id', 'date_order', 'date_planned', 'date_approve',
      'amount_total', 'state', 'order_line', 'currency_id',
    ], { limit: 50000, order: 'date_order desc' });

    // Get all order lines
    const allLineIds = orders.flatMap(o => o.order_line || []);
    let lineMap = new Map();

    if (allLineIds.length > 0) {
      // Fetch lines in batches
      for (let i = 0; i < allLineIds.length; i += this.config.batchSize) {
        const batchIds = allLineIds.slice(i, i + this.config.batchSize);
        const lines = await this.odooClient.read('purchase.order.line', batchIds, [
          'product_id', 'name', 'product_qty', 'qty_received', 'price_unit',
          'price_subtotal', 'date_planned',
        ]);
        for (const line of lines) {
          lineMap.set(line.id, line);
        }
      }
    }

    const collection = this.db.collection(this.collections.purchaseOrders);
    let updated = 0;
    let inserted = 0;

    for (const order of orders) {
      const lines = (order.order_line || []).map(lineId => {
        const line = lineMap.get(lineId);
        if (!line) return null;
        return {
          odooLineId: line.id,
          productId: line.product_id?.[0],
          productName: line.product_id?.[1],
          description: line.name,
          quantityOrdered: line.product_qty,
          quantityReceived: line.qty_received,
          quantityPending: line.product_qty - line.qty_received,
          priceUnit: line.price_unit,
          subtotal: line.price_subtotal,
          expectedDate: line.date_planned ? new Date(line.date_planned) : null,
        };
      }).filter(Boolean);

      const doc = {
        odooId: order.id,
        name: order.name,
        supplierId: order.partner_id?.[0] || null,
        supplierName: order.partner_id?.[1] || null,
        orderDate: order.date_order ? new Date(order.date_order) : null,
        expectedDate: order.date_planned ? new Date(order.date_planned) : null,
        approvedDate: order.date_approve ? new Date(order.date_approve) : null,
        total: order.amount_total,
        currency: order.currency_id?.[1] || 'EUR',
        state: order.state,
        isPending: ['draft', 'sent', 'to approve', 'purchase'].includes(order.state),
        lines,
        lineCount: lines.length,
        lastUpdated: new Date(),
      };

      const result = await collection.updateOne(
        { odooId: order.id },
        { $set: doc },
        { upsert: true }
      );

      if (result.upsertedCount > 0) inserted++;
      else if (result.modifiedCount > 0) updated++;
    }

    console.log(`Purchase orders synced: ${inserted} inserted, ${updated} updated`);
    return { total: orders.length, inserted, updated };
  }

  /**
   * Sync stock movements for stockout analysis
   */
  async syncStockMoves() {
    console.log('Syncing stock movements...');

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.stockMoveHistoryDays);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    // Get done stock moves (actual movements)
    const moves = await this.odooClient.searchRead('stock.move', [
      ['state', '=', 'done'],
      ['date', '>=', cutoffStr],
    ], [
      'product_id', 'product_qty', 'date', 'reference',
      'location_id', 'location_dest_id', 'picking_type_id',
    ], { limit: 200000, order: 'date desc' });

    const collection = this.db.collection(this.collections.stockMoves);

    // Clear old data and insert fresh
    await collection.deleteMany({ date: { $gte: cutoffDate } });

    const docs = moves.map(move => ({
      odooId: move.id,
      productId: move.product_id?.[0],
      productName: move.product_id?.[1],
      quantity: move.product_qty,
      date: new Date(move.date),
      reference: move.reference,
      sourceLocation: move.location_id?.[1],
      destLocation: move.location_dest_id?.[1],
      pickingType: move.picking_type_id?.[1],
      // Determine movement type
      type: this._determineMovementType(move),
      syncedAt: new Date(),
    }));

    if (docs.length > 0) {
      for (let i = 0; i < docs.length; i += this.config.batchSize) {
        const batch = docs.slice(i, i + this.config.batchSize);
        await collection.insertMany(batch, { ordered: false });
      }
    }

    console.log(`Stock moves synced: ${docs.length} records`);
    return { total: docs.length, inserted: docs.length, updated: 0 };
  }

  /**
   * Determine the type of stock movement
   */
  _determineMovementType(move) {
    const source = move.location_id?.[1]?.toLowerCase() || '';
    const dest = move.location_dest_id?.[1]?.toLowerCase() || '';

    if (source.includes('supplier') || source.includes('vendor')) return 'receipt';
    if (dest.includes('customer')) return 'delivery';
    if (dest.includes('supplier') || dest.includes('vendor')) return 'return_to_supplier';
    if (source.includes('customer')) return 'return_from_customer';
    if (source.includes('stock') && dest.includes('stock')) return 'internal';
    return 'other';
  }

  /**
   * Log sync event
   */
  async _logSync(status, data) {
    if (!this.db) return;

    const collection = this.db.collection(this.collections.syncLog);
    await collection.insertOne({
      status,
      data,
      timestamp: new Date(),
    });

    // Keep only last 100 sync logs
    const count = await collection.countDocuments();
    if (count > 100) {
      const oldest = await collection.find().sort({ timestamp: 1 }).limit(count - 100).toArray();
      const idsToDelete = oldest.map(d => d._id);
      await collection.deleteMany({ _id: { $in: idsToDelete } });
    }
  }

  /**
   * Get last successful sync time
   */
  async _getLastSyncTime() {
    if (!this.db) return null;

    const collection = this.db.collection(this.collections.syncLog);
    const lastSync = await collection.findOne(
      { status: 'success' },
      { sort: { timestamp: -1 } }
    );

    return lastSync?.timestamp || null;
  }

  /**
   * Get sync status
   */
  async getStatus() {
    const lastSync = await this._getLastSyncTime();

    // Get collection counts
    const counts = {};
    if (this.db) {
      for (const [name, collName] of Object.entries(this.collections)) {
        if (name !== 'syncLog') {
          counts[name] = await this.db.collection(collName).countDocuments();
        }
      }
    }

    return {
      isRunning: this.syncStatus.isRunning,
      lastSync,
      lastError: this.syncStatus.lastError,
      lastStats: this.syncStatus.stats,
      recordCounts: counts,
      config: {
        syncIntervalHours: this.config.syncIntervalHours,
        invoiceHistoryDays: this.config.invoiceHistoryDays,
      },
    };
  }

  // ==================== QUERY METHODS FOR AGENT ====================

  /**
   * Get product with all related data
   */
  async getProduct(productId) {
    if (!this.db) return null;

    const product = await this.db.collection(this.collections.products)
      .findOne({ odooId: productId });

    if (!product) return null;

    // Get recent sales
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentSales = await this.db.collection(this.collections.invoiceLines)
      .aggregate([
        { $match: { productId, invoiceDate: { $gte: thirtyDaysAgo } } },
        { $group: { _id: null, totalQty: { $sum: '$quantity' }, totalRevenue: { $sum: '$subtotal' } } },
      ]).toArray();

    // Get pending POs
    const pendingPOs = await this.db.collection(this.collections.purchaseOrders)
      .aggregate([
        { $match: { isPending: true, 'lines.productId': productId } },
        { $unwind: '$lines' },
        { $match: { 'lines.productId': productId } },
        { $group: { _id: null, pendingQty: { $sum: '$lines.quantityPending' } } },
      ]).toArray();

    return {
      ...product,
      recentSales: recentSales[0] || { totalQty: 0, totalRevenue: 0 },
      pendingOrders: pendingPOs[0]?.pendingQty || 0,
    };
  }

  /**
   * Get sales history for a product
   */
  async getProductSalesHistory(productId, days = 365) {
    if (!this.db) return [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    return this.db.collection(this.collections.invoiceLines)
      .find({
        productId,
        invoiceDate: { $gte: cutoff },
      })
      .sort({ invoiceDate: 1 })
      .toArray();
  }

  /**
   * Get aggregated sales by period
   */
  async getProductSalesByPeriod(productId, days = 365, periodType = 'week') {
    if (!this.db) return [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    let dateFormat;
    switch (periodType) {
      case 'day':
        dateFormat = { $dateToString: { format: '%Y-%m-%d', date: '$invoiceDate' } };
        break;
      case 'week':
        dateFormat = { $dateToString: { format: '%Y-W%V', date: '$invoiceDate' } };
        break;
      case 'month':
        dateFormat = { $dateToString: { format: '%Y-%m', date: '$invoiceDate' } };
        break;
      default:
        dateFormat = { $dateToString: { format: '%Y-W%V', date: '$invoiceDate' } };
    }

    return this.db.collection(this.collections.invoiceLines)
      .aggregate([
        { $match: { productId, invoiceDate: { $gte: cutoff } } },
        {
          $group: {
            _id: dateFormat,
            quantity: { $sum: '$quantity' },
            revenue: { $sum: '$subtotal' },
            orderCount: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]).toArray();
  }

  /**
   * Get products needing reorder (low stock)
   */
  async getLowStockProducts(threshold = 'reorderPoint') {
    if (!this.db) return [];

    // Get products where available stock is below a threshold
    // For now, use a simple heuristic: stock < 30 days of average sales
    const products = await this.db.collection(this.collections.products)
      .find({ 'stock.available': { $gt: 0, $lt: 100 } })
      .toArray();

    // For each product, calculate if it needs reorder
    const results = [];
    for (const product of products) {
      const sales = await this.getProductSalesByPeriod(product.odooId, 90, 'day');
      const totalSold = sales.reduce((sum, s) => sum + s.quantity, 0);
      const avgDailySales = totalSold / 90;

      if (avgDailySales > 0) {
        const daysOfStock = product.stock.available / avgDailySales;

        // Consider low stock if less than 30 days + lead time
        const leadTime = product.primarySupplier?.leadTimeDays || 45;
        const reorderPoint = avgDailySales * (leadTime + 14); // Lead time + 2 weeks safety

        if (product.stock.available < reorderPoint) {
          results.push({
            ...product,
            avgDailySales: Math.round(avgDailySales * 100) / 100,
            daysOfStock: Math.round(daysOfStock),
            reorderPoint: Math.round(reorderPoint),
            shortfall: Math.round(reorderPoint - product.stock.available),
          });
        }
      }
    }

    // Sort by urgency (lowest days of stock first)
    return results.sort((a, b) => a.daysOfStock - b.daysOfStock);
  }

  /**
   * Get pending purchase orders
   */
  async getPendingPurchaseOrders(supplierId = null) {
    if (!this.db) return [];

    const query = { isPending: true };
    if (supplierId) query.supplierId = supplierId;

    return this.db.collection(this.collections.purchaseOrders)
      .find(query)
      .sort({ expectedDate: 1 })
      .toArray();
  }
}

// Singleton instance
let odooDataSyncInstance = null;

function getOdooDataSync(config = {}) {
  if (!odooDataSyncInstance) {
    odooDataSyncInstance = new OdooDataSync(config);
  }
  return odooDataSyncInstance;
}

module.exports = {
  OdooDataSync,
  getOdooDataSync,
};
