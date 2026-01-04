/**
 * Odoo Sync API Routes
 *
 * Endpoints for managing and monitoring Odoo data synchronization.
 */

const express = require('express');
const router = express.Router();
const { getOdooSyncService, getOdooSyncScheduler, MODEL_CONFIGS } = require('../../services/odoo');

// ============================================
// Sync Status & Monitoring
// ============================================

/**
 * GET /api/odoo-sync/status
 * Get overall sync status
 */
router.get('/status', async (req, res) => {
  try {
    const syncService = getOdooSyncService();
    const scheduler = getOdooSyncScheduler();

    const syncStatus = await syncService.getSyncStatus();
    const schedulerStatus = scheduler.getStatus();

    res.json({
      success: true,
      scheduler: schedulerStatus,
      models: syncStatus
    });
  } catch (err) {
    console.error('[OdooSyncAPI] GET /status error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/odoo-sync/models
 * Get list of configured models
 */
router.get('/models', async (req, res) => {
  try {
    const models = Object.entries(MODEL_CONFIGS).map(([name, config]) => ({
      name,
      collection: config.collection,
      fields: config.fields.length
    }));

    res.json({
      success: true,
      models
    });
  } catch (err) {
    console.error('[OdooSyncAPI] GET /models error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/odoo-sync/freshness
 * Check data freshness for all models
 */
router.get('/freshness', async (req, res) => {
  try {
    const maxAgeMinutes = parseInt(req.query.maxAge) || 60;
    const syncService = getOdooSyncService();

    const results = {};
    for (const modelName of Object.keys(MODEL_CONFIGS)) {
      results[modelName] = await syncService.checkFreshness(modelName, maxAgeMinutes);
    }

    res.json({
      success: true,
      maxAgeMinutes,
      models: results
    });
  } catch (err) {
    console.error('[OdooSyncAPI] GET /freshness error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// Manual Sync Triggers
// ============================================

/**
 * POST /api/odoo-sync/trigger
 * Trigger a sync manually
 */
router.post('/trigger', async (req, res) => {
  try {
    const { type = 'incremental', model } = req.body;
    const syncService = getOdooSyncService();

    let result;

    if (model) {
      // Sync specific model
      const since = type === 'full' ? null : undefined;
      result = await syncService.syncModel(model, { since });
    } else if (type === 'full') {
      result = await syncService.fullSync();
    } else {
      result = await syncService.incrementalSync();
    }

    res.json({
      success: true,
      result
    });
  } catch (err) {
    console.error('[OdooSyncAPI] POST /trigger error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/odoo-sync/sync-record
 * Sync a specific record by Odoo ID
 */
router.post('/sync-record', async (req, res) => {
  try {
    const { model, odooId } = req.body;

    if (!model || !odooId) {
      return res.status(400).json({
        success: false,
        error: 'model and odooId are required'
      });
    }

    const syncService = getOdooSyncService();
    const record = await syncService.syncRecord(model, odooId);

    res.json({
      success: true,
      record
    });
  } catch (err) {
    console.error('[OdooSyncAPI] POST /sync-record error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// Scheduler Control
// ============================================

/**
 * POST /api/odoo-sync/scheduler/start
 * Start the sync scheduler
 */
router.post('/scheduler/start', async (req, res) => {
  try {
    const scheduler = getOdooSyncScheduler();
    await scheduler.start();

    res.json({
      success: true,
      status: scheduler.getStatus()
    });
  } catch (err) {
    console.error('[OdooSyncAPI] POST /scheduler/start error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/odoo-sync/scheduler/stop
 * Stop the sync scheduler
 */
router.post('/scheduler/stop', async (req, res) => {
  try {
    const scheduler = getOdooSyncScheduler();
    scheduler.stop();

    res.json({
      success: true,
      status: scheduler.getStatus()
    });
  } catch (err) {
    console.error('[OdooSyncAPI] POST /scheduler/stop error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// Query Endpoints
// ============================================

/**
 * GET /api/odoo-sync/orders
 * Query synced orders
 */
router.get('/orders', async (req, res) => {
  try {
    const syncService = getOdooSyncService();

    const filter = {};
    if (req.query.state) filter.state = req.query.state;
    if (req.query.partnerId) filter.partnerId = parseInt(req.query.partnerId);
    if (req.query.clientOrderRef) filter.clientOrderRef = req.query.clientOrderRef;

    const options = {
      limit: Math.min(parseInt(req.query.limit) || 50, 500),
      skip: parseInt(req.query.offset) || 0,
      sort: { dateOrder: -1 }
    };

    const orders = await syncService.query('sale.order', filter, options);
    const total = await syncService.count('sale.order', filter);

    res.json({
      success: true,
      total,
      count: orders.length,
      orders
    });
  } catch (err) {
    console.error('[OdooSyncAPI] GET /orders error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/odoo-sync/orders/:amazonOrderId
 * Find order by Amazon order ID
 */
router.get('/orders/:amazonOrderId', async (req, res) => {
  try {
    const syncService = getOdooSyncService();
    const order = await syncService.findOrderByAmazonId(req.params.amazonOrderId);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    res.json({
      success: true,
      order
    });
  } catch (err) {
    console.error('[OdooSyncAPI] GET /orders/:id error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/odoo-sync/products
 * Query synced products
 */
router.get('/products', async (req, res) => {
  try {
    const syncService = getOdooSyncService();

    const filter = { active: true };
    if (req.query.sku) filter.sku = req.query.sku;
    if (req.query.barcode) filter.barcode = req.query.barcode;
    if (req.query.categoryId) filter.categoryId = parseInt(req.query.categoryId);

    const options = {
      limit: Math.min(parseInt(req.query.limit) || 50, 500),
      skip: parseInt(req.query.offset) || 0,
      sort: { name: 1 }
    };

    const products = await syncService.query('product.product', filter, options);
    const total = await syncService.count('product.product', filter);

    res.json({
      success: true,
      total,
      count: products.length,
      products
    });
  } catch (err) {
    console.error('[OdooSyncAPI] GET /products error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/odoo-sync/products/sku/:sku
 * Find product by SKU
 */
router.get('/products/sku/:sku', async (req, res) => {
  try {
    const syncService = getOdooSyncService();
    const product = await syncService.findProductBySku(req.params.sku);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }

    res.json({
      success: true,
      product
    });
  } catch (err) {
    console.error('[OdooSyncAPI] GET /products/sku/:sku error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/odoo-sync/partners
 * Query synced partners
 */
router.get('/partners', async (req, res) => {
  try {
    const syncService = getOdooSyncService();

    const filter = { active: true };
    if (req.query.customerRank) filter.customerRank = { $gte: 1 };
    if (req.query.supplierRank) filter.supplierRank = { $gte: 1 };
    if (req.query.vat) filter.vat = req.query.vat;

    const options = {
      limit: Math.min(parseInt(req.query.limit) || 50, 500),
      skip: parseInt(req.query.offset) || 0,
      sort: { name: 1 }
    };

    const partners = await syncService.query('res.partner', filter, options);
    const total = await syncService.count('res.partner', filter);

    res.json({
      success: true,
      total,
      count: partners.length,
      partners
    });
  } catch (err) {
    console.error('[OdooSyncAPI] GET /partners error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/odoo-sync/invoices
 * Query synced invoices
 */
router.get('/invoices', async (req, res) => {
  try {
    const syncService = getOdooSyncService();

    const filter = {};
    if (req.query.state) filter.state = req.query.state;
    if (req.query.moveType) filter.moveType = req.query.moveType;
    if (req.query.partnerId) filter.partnerId = parseInt(req.query.partnerId);
    if (req.query.invoiceOrigin) filter.invoiceOrigin = req.query.invoiceOrigin;

    const options = {
      limit: Math.min(parseInt(req.query.limit) || 50, 500),
      skip: parseInt(req.query.offset) || 0,
      sort: { invoiceDate: -1 }
    };

    const invoices = await syncService.query('account.move', filter, options);
    const total = await syncService.count('account.move', filter);

    res.json({
      success: true,
      total,
      count: invoices.length,
      invoices
    });
  } catch (err) {
    console.error('[OdooSyncAPI] GET /invoices error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/odoo-sync/deliveries
 * Query synced deliveries
 */
router.get('/deliveries', async (req, res) => {
  try {
    const syncService = getOdooSyncService();

    const filter = {};
    if (req.query.state) filter.state = req.query.state;
    if (req.query.saleId) filter.saleId = parseInt(req.query.saleId);
    if (req.query.origin) filter.origin = req.query.origin;

    const options = {
      limit: Math.min(parseInt(req.query.limit) || 50, 500),
      skip: parseInt(req.query.offset) || 0,
      sort: { scheduledDate: -1 }
    };

    const deliveries = await syncService.query('stock.picking', filter, options);
    const total = await syncService.count('stock.picking', filter);

    res.json({
      success: true,
      total,
      count: deliveries.length,
      deliveries
    });
  } catch (err) {
    console.error('[OdooSyncAPI] GET /deliveries error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
