/**
 * Amazon Integration API Routes
 *
 * Webhook endpoints for Make.com (or similar) to push Amazon Seller Central data.
 * This allows integration without requiring SP-API developer approval.
 *
 * Flow: Amazon → Make.com (approved SP-API app) → Agent5 webhooks
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../../db');

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, '../../../uploads/vcs');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
const { ObjectId } = require('mongodb');
const { skuResolver, euCountryConfig, OrderImporter, VcsInvoiceImporter, FbaInventoryReconciler, FbmStockSync, TrackingSync } = require('../../services/amazon');
const { VcsTaxReportParser } = require('../../services/amazon/VcsTaxReportParser');
const { FbaInventoryReportParser } = require('../../services/amazon/FbaInventoryReportParser');
const { ReturnsReportParser } = require('../../services/amazon/ReturnsReportParser');
const { VcsOdooInvoicer } = require('../../services/amazon/VcsOdooInvoicer');
const { VcsOrderCreator } = require('../../services/amazon/VcsOrderCreator');
const { SettlementReportParser } = require('../../services/amazon/SettlementReportParser');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// Configure multer for settlement report uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    // Accept CSV, TSV, TXT files
    const allowedMimes = ['text/csv', 'text/tab-separated-values', 'text/plain', 'application/vnd.ms-excel'];
    if (allowedMimes.includes(file.mimetype) || file.originalname.match(/\.(csv|tsv|txt)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV/TSV files are allowed'), false);
    }
  }
});

// Webhook secret for validating requests from Make.com
const WEBHOOK_SECRET = process.env.AMAZON_WEBHOOK_SECRET || 'change-me-in-production';

/**
 * Middleware to validate webhook requests
 */
function validateWebhook(req, res, next) {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];

  // Skip validation in development or if no secret configured
  if (process.env.NODE_ENV === 'development' || WEBHOOK_SECRET === 'change-me-in-production') {
    return next();
  }

  if (!signature || !timestamp) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  // Validate timestamp is within 5 minutes
  const now = Date.now();
  const requestTime = parseInt(timestamp, 10);
  if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
    return res.status(401).json({ error: 'Webhook timestamp expired' });
  }

  // Validate signature
  const payload = JSON.stringify(req.body) + timestamp;
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  next();
}

// ==================== ORDER WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/orders
 * @desc Receive new/updated orders from Make.com
 */
router.post('/webhook/orders', validateWebhook, async (req, res) => {
  try {
    const orders = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const order of orders) {
      if (!order.AmazonOrderId) {
        results.push({ error: 'Missing AmazonOrderId', order });
        continue;
      }

      const doc = {
        amazonOrderId: order.AmazonOrderId,
        sellerOrderId: order.SellerOrderId,
        purchaseDate: order.PurchaseDate ? new Date(order.PurchaseDate) : null,
        lastUpdateDate: order.LastUpdateDate ? new Date(order.LastUpdateDate) : null,
        orderStatus: order.OrderStatus,
        fulfillmentChannel: order.FulfillmentChannel,
        salesChannel: order.SalesChannel,
        shipServiceLevel: order.ShipServiceLevel,
        orderTotal: order.OrderTotal,
        numberOfItemsShipped: order.NumberOfItemsShipped,
        numberOfItemsUnshipped: order.NumberOfItemsUnshipped,
        paymentMethod: order.PaymentMethod,
        marketplaceId: order.MarketplaceId,
        buyerEmail: order.BuyerEmail,
        buyerName: order.BuyerName,
        shippingAddress: order.ShippingAddress,
        orderItems: order.OrderItems || [],
        rawData: order,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_orders').updateOne(
        { amazonOrderId: order.AmazonOrderId },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ amazonOrderId: order.AmazonOrderId, status: 'saved' });
    }

    // Emit event for real-time updates
    if (req.app.get('platform')) {
      req.app.get('platform').emit('amazon:orders', { count: results.length });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon orders webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/order-items
 * @desc Receive order items details from Make.com
 * Accepts either: {amazonOrderId, items: [...]} OR {amazonOrderId, item: {...}} for single items
 */
router.post('/webhook/order-items', validateWebhook, async (req, res) => {
  try {
    const { amazonOrderId, items, ...singleItem } = req.body;

    // Check if this is a single item (all fields at root level with amazonOrderId)
    const isSingleItem = amazonOrderId && !items && Object.keys(singleItem).length > 0;

    if (!amazonOrderId) {
      return res.status(400).json({ error: 'amazonOrderId required' });
    }

    const db = getDb();

    if (isSingleItem) {
      // Single item mode - push to orderItems array
      await db.collection('amazon_orders').updateOne(
        { amazonOrderId },
        {
          $push: { orderItems: singleItem },
          $set: { updatedAt: new Date() }
        }
      );
      res.json({ success: true, amazonOrderId, mode: 'single-item' });
    } else if (items) {
      // Batch mode - replace entire orderItems array
      await db.collection('amazon_orders').updateOne(
        { amazonOrderId },
        { $set: { orderItems: items, updatedAt: new Date() } }
      );
      res.json({ success: true, amazonOrderId, itemCount: items.length });
    } else {
      return res.status(400).json({ error: 'items array or item fields required' });
    }
  } catch (error) {
    console.error('Amazon order-items webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ORDER IMPORT TO ODOO ====================

/**
 * @route POST /api/amazon/import/orders
 * @desc Import orders from MongoDB to Odoo
 * @body { orderIds: string[] } OR { since: ISO date string } OR { amazonOrderId: string }
 *
 * This endpoint takes orders already stored in MongoDB (from webhooks)
 * and creates corresponding Sale Orders in Odoo.
 */
router.post('/import/orders', async (req, res) => {
  try {
    const db = getDb();
    const { orderIds, since, amazonOrderId, limit = 50 } = req.body;

    // Get Odoo client from app
    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    // Initialize order importer
    const importer = new OrderImporter(odooClient);
    await importer.init();

    // Build query based on input
    let query = {};
    if (amazonOrderId) {
      query.amazonOrderId = amazonOrderId;
    } else if (orderIds && orderIds.length > 0) {
      query.amazonOrderId = { $in: orderIds };
    } else if (since) {
      query.purchaseDate = { $gte: new Date(since) };
    } else {
      // Default: orders not yet imported
      query['odooImport.success'] = { $ne: true };
    }

    // Add filter for orders with items
    query['orderItems.0'] = { $exists: true };

    // Fetch orders
    const orders = await db.collection('amazon_orders')
      .find(query)
      .limit(parseInt(limit))
      .toArray();

    if (orders.length === 0) {
      return res.json({ success: true, message: 'No orders to import', imported: 0, failed: 0 });
    }

    // Import orders to Odoo
    const results = await importer.importOrders(orders);

    // Update MongoDB with import status
    for (const result of results.results) {
      await db.collection('amazon_orders').updateOne(
        { amazonOrderId: result.amazonOrderId },
        {
          $set: {
            odooImport: {
              success: result.success,
              odooOrderId: result.odooOrderId,
              odooOrderName: result.odooOrderName,
              errors: result.errors,
              warnings: result.warnings,
              importedAt: new Date()
            }
          }
        }
      );
    }

    res.json({
      success: true,
      imported: results.imported,
      failed: results.failed,
      total: results.total,
      results: results.results
    });
  } catch (error) {
    console.error('Amazon order import error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/import/order/:amazonOrderId
 * @desc Import a single order to Odoo
 */
router.post('/import/order/:amazonOrderId', async (req, res) => {
  try {
    const db = getDb();
    const { amazonOrderId } = req.params;

    // Get order from MongoDB
    const order = await db.collection('amazon_orders').findOne({ amazonOrderId });
    if (!order) {
      return res.status(404).json({ error: 'Order not found in MongoDB' });
    }

    // Get Odoo client
    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    // Initialize and import
    const importer = new OrderImporter(odooClient);
    await importer.init();

    const result = await importer.importOrder(order);

    // Update MongoDB
    await db.collection('amazon_orders').updateOne(
      { amazonOrderId },
      {
        $set: {
          odooImport: {
            success: result.success,
            odooOrderId: result.odooOrderId,
            odooOrderName: result.odooOrderName,
            errors: result.errors,
            warnings: result.warnings,
            importedAt: new Date()
          }
        }
      }
    );

    res.json(result);
  } catch (error) {
    console.error('Amazon single order import error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/import/status
 * @desc Get order import statistics
 */
router.get('/import/status', async (req, res) => {
  try {
    const db = getDb();

    const stats = await db.collection('amazon_orders').aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          imported: { $sum: { $cond: ['$odooImport.success', 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$odooImport.success', false] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $not: '$odooImport' }, 1, 0] } },
          withItems: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$orderItems', []] } }, 0] }, 1, 0] } }
        }
      }
    ]).toArray();

    const result = stats[0] || { total: 0, imported: 0, failed: 0, pending: 0, withItems: 0 };

    // Get recent import errors
    const recentErrors = await db.collection('amazon_orders')
      .find({ 'odooImport.success': false })
      .project({ amazonOrderId: 1, 'odooImport.errors': 1, 'odooImport.importedAt': 1 })
      .sort({ 'odooImport.importedAt': -1 })
      .limit(10)
      .toArray();

    res.json({
      ...result,
      recentErrors
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/orders/import
 * @desc Webhook that receives and immediately imports orders to Odoo
 * Use this for real-time order sync from Make.com
 */
router.post('/webhook/orders/import', validateWebhook, async (req, res) => {
  try {
    const orders = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    // First, store orders in MongoDB
    for (const order of orders) {
      if (!order.AmazonOrderId) continue;

      const doc = {
        amazonOrderId: order.AmazonOrderId,
        sellerOrderId: order.SellerOrderId,
        purchaseDate: order.PurchaseDate ? new Date(order.PurchaseDate) : null,
        lastUpdateDate: order.LastUpdateDate ? new Date(order.LastUpdateDate) : null,
        orderStatus: order.OrderStatus,
        fulfillmentChannel: order.FulfillmentChannel,
        salesChannel: order.SalesChannel,
        shipServiceLevel: order.ShipServiceLevel,
        orderTotal: order.OrderTotal,
        numberOfItemsShipped: order.NumberOfItemsShipped,
        numberOfItemsUnshipped: order.NumberOfItemsUnshipped,
        paymentMethod: order.PaymentMethod,
        marketplaceId: order.MarketplaceId,
        buyerEmail: order.BuyerEmail,
        buyerName: order.BuyerName,
        shippingAddress: order.ShippingAddress,
        orderItems: order.OrderItems || [],
        rawData: order,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_orders').updateOne(
        { amazonOrderId: order.AmazonOrderId },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
    }

    // Try to import to Odoo if client available
    const odooClient = req.app.get('odooClient');
    const results = { stored: orders.length, imported: 0, failed: 0, odooResults: [] };

    if (odooClient) {
      const importer = new OrderImporter(odooClient);
      await importer.init();

      for (const order of orders) {
        if (!order.AmazonOrderId || !order.OrderItems || order.OrderItems.length === 0) continue;

        try {
          const result = await importer.importOrder(order);
          results.odooResults.push(result);

          // Update MongoDB with import status
          await db.collection('amazon_orders').updateOne(
            { amazonOrderId: order.AmazonOrderId },
            {
              $set: {
                odooImport: {
                  success: result.success,
                  odooOrderId: result.odooOrderId,
                  odooOrderName: result.odooOrderName,
                  errors: result.errors,
                  warnings: result.warnings,
                  importedAt: new Date()
                }
              }
            }
          );

          if (result.success) {
            results.imported++;
          } else {
            results.failed++;
          }
        } catch (err) {
          results.failed++;
          results.odooResults.push({
            amazonOrderId: order.AmazonOrderId,
            success: false,
            errors: [err.message]
          });
        }
      }
    }

    // Emit event for real-time updates
    if (req.app.get('platform')) {
      req.app.get('platform').emit('amazon:orders:imported', results);
    }

    res.json({ success: true, ...results });
  } catch (error) {
    console.error('Amazon orders webhook+import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== INVENTORY WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/inventory
 * @desc Receive inventory data from Make.com
 */
router.post('/webhook/inventory', validateWebhook, async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const item of items) {
      const sku = item.sellerSku || item.sku || item.SKU;
      if (!sku) {
        results.push({ error: 'Missing SKU', item });
        continue;
      }

      const doc = {
        sellerSku: sku,
        asin: item.asin || item.ASIN,
        fnSku: item.fnSku || item.FNSKU,
        productName: item.productName || item.title,
        condition: item.condition,
        totalQuantity: item.totalQuantity ?? item.quantity ?? 0,
        inboundWorkingQuantity: item.inboundWorkingQuantity ?? 0,
        inboundShippedQuantity: item.inboundShippedQuantity ?? 0,
        inboundReceivingQuantity: item.inboundReceivingQuantity ?? 0,
        fulfillableQuantity: item.fulfillableQuantity ?? item.totalQuantity ?? 0,
        reservedQuantity: item.reservedQuantity ?? 0,
        unfulfillableQuantity: item.unfulfillableQuantity ?? 0,
        marketplaceId: item.marketplaceId,
        rawData: item,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_inventory').updateOne(
        { sellerSku: sku },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ sellerSku: sku, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon inventory webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/fba-inventory
 * @desc Receive FBA inventory report from Make.com and optionally reconcile to Odoo
 * @body { reportId, reportType, content: string|array, autoReconcile?: boolean }
 */
router.post('/webhook/fba-inventory', validateWebhook, async (req, res) => {
  try {
    const { reportId, reportType, content, autoReconcile = false } = req.body;
    const db = getDb();

    // Store the raw report
    const reportDoc = {
      reportId,
      reportType: reportType || 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA',
      rawContent: content,
      source: 'make.com',
      createdAt: new Date(),
      reconcileStatus: 'pending'
    };

    await db.collection('amazon_fba_reports').insertOne(reportDoc);

    let reconcileResult = null;

    // Auto-reconcile to Odoo if requested
    if (autoReconcile) {
      const odooClient = req.app.get('odooClient');
      if (odooClient) {
        try {
          const reconciler = new FbaInventoryReconciler(odooClient);
          reconcileResult = await reconciler.importInventoryReport({
            reportType,
            content,
            reportId
          });

          await db.collection('amazon_fba_reports').updateOne(
            { reportId },
            { $set: { reconcileStatus: 'completed', reconcileResult, reconciledAt: new Date() } }
          );
        } catch (reconcileError) {
          await db.collection('amazon_fba_reports').updateOne(
            { reportId },
            { $set: { reconcileStatus: 'failed', reconcileError: reconcileError.message } }
          );
          reconcileResult = { error: reconcileError.message };
        }
      }
    }

    if (req.app.get('platform')) {
      req.app.get('platform').emit('amazon:fba-inventory:received', { reportId, reconcileResult });
    }

    res.json({
      success: true,
      reportId,
      stored: true,
      reconciled: reconcileResult ? !reconcileResult.error : false,
      reconcileResult
    });
  } catch (error) {
    console.error('Amazon FBA inventory webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/import/fba-inventory
 * @desc Reconcile FBA inventory from MongoDB to Odoo
 * @body { reportId?: string, since?: ISO date }
 */
router.post('/import/fba-inventory', async (req, res) => {
  try {
    const db = getDb();
    const { reportId, since } = req.body;

    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    // Build query
    let query = { reconcileStatus: { $ne: 'completed' } };
    if (reportId) {
      query.reportId = reportId;
    } else if (since) {
      query.createdAt = { $gte: new Date(since) };
    }

    // Fetch pending reports
    const reports = await db.collection('amazon_fba_reports')
      .find(query)
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    if (reports.length === 0) {
      return res.json({ success: true, message: 'No pending FBA reports to reconcile', processed: 0 });
    }

    const reconciler = new FbaInventoryReconciler(odooClient);
    const allResults = [];

    for (const report of reports) {
      try {
        const result = await reconciler.importInventoryReport({
          reportType: report.reportType,
          content: report.rawContent,
          reportId: report.reportId
        });

        allResults.push({ reportId: report.reportId, ...result });

        await db.collection('amazon_fba_reports').updateOne(
          { _id: report._id },
          { $set: { reconcileStatus: 'completed', reconcileResult: result, reconciledAt: new Date() } }
        );
      } catch (err) {
        allResults.push({ reportId: report.reportId, error: err.message });

        await db.collection('amazon_fba_reports').updateOne(
          { _id: report._id },
          { $set: { reconcileStatus: 'failed', reconcileError: err.message } }
        );
      }
    }

    res.json({
      success: true,
      reportsProcessed: reports.length,
      results: allResults
    });
  } catch (error) {
    console.error('FBA inventory reconcile error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/fba/inventory-status
 * @desc Get FBA inventory reconciliation status
 */
router.get('/fba/inventory-status', async (req, res) => {
  try {
    const db = getDb();

    const [reportStats, inventoryCount] = await Promise.all([
      db.collection('amazon_fba_reports').aggregate([
        {
          $group: {
            _id: '$reconcileStatus',
            count: { $sum: 1 }
          }
        }
      ]).toArray(),
      db.collection('amazon_inventory').countDocuments()
    ]);

    const statusCounts = {};
    for (const stat of reportStats) {
      statusCounts[stat._id || 'unknown'] = stat.count;
    }

    // Get last reconciliation
    const lastReconciled = await db.collection('amazon_fba_reports')
      .findOne({ reconcileStatus: 'completed' }, { sort: { reconciledAt: -1 } });

    res.json({
      reports: {
        pending: statusCounts.pending || 0,
        completed: statusCounts.completed || 0,
        failed: statusCounts.failed || 0,
        total: Object.values(statusCounts).reduce((a, b) => a + b, 0)
      },
      inventoryItems: inventoryCount,
      lastReconciled: lastReconciled?.reconciledAt || null,
      lastReportId: lastReconciled?.reportId || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/fba/discrepancies
 * @desc Get inventory discrepancies from last reconciliation
 */
router.get('/fba/discrepancies', async (req, res) => {
  try {
    const db = getDb();
    const { limit = 50 } = req.query;

    // Get reports with discrepancies
    const reports = await db.collection('amazon_fba_reports')
      .find({
        reconcileStatus: 'completed',
        'reconcileResult.discrepancies.0': { $exists: true }
      })
      .sort({ reconciledAt: -1 })
      .limit(5)
      .toArray();

    const allDiscrepancies = [];
    for (const report of reports) {
      if (report.reconcileResult?.discrepancies) {
        for (const d of report.reconcileResult.discrepancies) {
          allDiscrepancies.push({
            ...d,
            reportId: report.reportId,
            reconciledAt: report.reconciledAt
          });
        }
      }
    }

    // Sort by absolute difference
    allDiscrepancies.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

    res.json({
      discrepancies: allDiscrepancies.slice(0, parseInt(limit)),
      total: allDiscrepancies.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== FBM STOCK SYNC ENDPOINTS ====================

/**
 * @route POST /api/amazon/sync/fbm-stock
 * @desc Sync FBM stock from Odoo to Amazon via webhook
 * @body { webhookUrl?: string, skus?: string[] }
 */
router.post('/sync/fbm-stock', async (req, res) => {
  try {
    const { webhookUrl, skus } = req.body;

    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const syncer = new FbmStockSync(odooClient);

    if (webhookUrl) {
      // Direct sync to webhook
      const result = await syncer.syncToWebhook({ webhookUrl, skus });
      res.json(result);
    } else {
      // Queue for later processing
      const result = await syncer.queueSync({ skus });
      res.json(result);
    }
  } catch (error) {
    console.error('FBM stock sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/sync/fbm-stock/comparison
 * @desc Get stock comparison between Odoo and Amazon
 */
router.get('/sync/fbm-stock/comparison', async (req, res) => {
  try {
    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const syncer = new FbmStockSync(odooClient);
    const comparison = await syncer.getStockComparison();
    res.json(comparison);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/sync/fbm-stock/queue
 * @desc Get pending FBM stock sync queue
 */
router.get('/sync/fbm-stock/queue', async (req, res) => {
  try {
    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const syncer = new FbmStockSync(odooClient);
    const queue = await syncer.getPendingQueue();
    res.json({ queue, count: queue.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/sync/fbm-stock/process-queue
 * @desc Process pending FBM stock sync queue
 * @body { webhookUrl: string }
 */
router.post('/sync/fbm-stock/process-queue', async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    if (!webhookUrl) {
      return res.status(400).json({ error: 'webhookUrl is required' });
    }

    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const syncer = new FbmStockSync(odooClient);
    const queue = await syncer.getPendingQueue();

    if (queue.length === 0) {
      return res.json({ success: true, message: 'No pending items in queue', processed: 0 });
    }

    const results = [];
    for (const item of queue) {
      // Send each queued item to webhook
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedType: 'POST_INVENTORY_AVAILABILITY_DATA',
            items: item.items
          })
        });

        const result = {
          queueId: item._id.toString(),
          success: response.ok,
          status: response.status
        };

        await syncer.markQueueProcessed(item._id.toString(), result);
        results.push(result);
      } catch (err) {
        const result = { queueId: item._id.toString(), success: false, error: err.message };
        await syncer.markQueueProcessed(item._id.toString(), result);
        results.push(result);
      }
    }

    res.json({
      success: true,
      processed: results.length,
      results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/sync/fbm-stock/history
 * @desc Get FBM stock sync history
 */
router.get('/sync/fbm-stock/history', async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const syncer = new FbmStockSync(odooClient);
    const history = await syncer.getSyncHistory(parseInt(limit));
    res.json({ history, count: history.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/sync/fbm-stock/feed/:queueId
 * @desc Get feed XML for a queued sync item
 */
router.get('/sync/fbm-stock/feed/:queueId', async (req, res) => {
  try {
    const db = getDb();
    const item = await db.collection('amazon_stock_sync_queue').findOne({
      _id: new ObjectId(req.params.queueId)
    });

    if (!item) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    if (req.query.format === 'xml') {
      res.set('Content-Type', 'application/xml');
      res.send(item.feedXml);
    } else {
      res.json({
        queueId: item._id,
        status: item.status,
        itemCount: item.itemCount,
        feedXml: item.feedXml,
        createdAt: item.createdAt
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== TRACKING SYNC ENDPOINTS ====================

/**
 * @route POST /api/amazon/sync/tracking
 * @desc Sync shipment tracking from Odoo to Amazon
 * @body { webhookUrl?: string, since?: ISO date, amazonOrderIds?: string[] }
 */
router.post('/sync/tracking', async (req, res) => {
  try {
    const { webhookUrl, since, amazonOrderIds } = req.body;

    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const syncer = new TrackingSync(odooClient);

    if (webhookUrl) {
      // Direct sync to webhook
      const result = await syncer.syncToWebhook({ webhookUrl, since, amazonOrderIds });
      res.json(result);
    } else {
      // Queue for later processing
      const result = await syncer.queueSync({ since, amazonOrderIds });
      res.json(result);
    }
  } catch (error) {
    console.error('Tracking sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/sync/tracking/pending
 * @desc Get shipments that need tracking sync
 */
router.get('/sync/tracking/pending', async (req, res) => {
  try {
    const { since, limit = 50 } = req.query;

    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const syncer = new TrackingSync(odooClient);
    const shipments = await syncer.getShipmentsToSync({ since, limit: parseInt(limit) });
    res.json({ shipments, count: shipments.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/sync/tracking/queue
 * @desc Get pending tracking sync queue
 */
router.get('/sync/tracking/queue', async (req, res) => {
  try {
    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const syncer = new TrackingSync(odooClient);
    const queue = await syncer.getPendingQueue();
    res.json({ queue, count: queue.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/sync/tracking/process-queue
 * @desc Process pending tracking sync queue
 * @body { webhookUrl: string }
 */
router.post('/sync/tracking/process-queue', async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    if (!webhookUrl) {
      return res.status(400).json({ error: 'webhookUrl is required' });
    }

    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const syncer = new TrackingSync(odooClient);
    const queue = await syncer.getPendingQueue();

    if (queue.length === 0) {
      return res.json({ success: true, message: 'No pending items in queue', processed: 0 });
    }

    const results = [];
    for (const item of queue) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedType: 'POST_ORDER_FULFILLMENT_DATA',
            shipments: item.shipments
          })
        });

        const result = {
          queueId: item._id.toString(),
          success: response.ok,
          status: response.status
        };

        await syncer.markQueueProcessed(item._id.toString(), result);
        results.push(result);
      } catch (err) {
        const result = { queueId: item._id.toString(), success: false, error: err.message };
        await syncer.markQueueProcessed(item._id.toString(), result);
        results.push(result);
      }
    }

    res.json({
      success: true,
      processed: results.length,
      results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/sync/tracking/history
 * @desc Get tracking sync history
 */
router.get('/sync/tracking/history', async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const syncer = new TrackingSync(odooClient);
    const history = await syncer.getSyncHistory(parseInt(limit));
    res.json({ history, count: history.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/sync/tracking/feed/:queueId
 * @desc Get feed XML for a queued tracking sync item
 */
router.get('/sync/tracking/feed/:queueId', async (req, res) => {
  try {
    const db = getDb();
    const item = await db.collection('amazon_tracking_sync_queue').findOne({
      _id: new ObjectId(req.params.queueId)
    });

    if (!item) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    if (req.query.format === 'xml') {
      res.set('Content-Type', 'application/xml');
      res.send(item.feedXml);
    } else {
      res.json({
        queueId: item._id,
        status: item.status,
        shipmentCount: item.shipmentCount,
        feedXml: item.feedXml,
        createdAt: item.createdAt
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== FINANCIAL WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/settlements
 * @desc Receive settlement report data from Make.com
 */
router.post('/webhook/settlements', validateWebhook, async (req, res) => {
  try {
    const settlement = req.body;
    const db = getDb();

    if (!settlement.settlementId) {
      return res.status(400).json({ error: 'settlementId required' });
    }

    const doc = {
      settlementId: settlement.settlementId,
      settlementStartDate: settlement.settlementStartDate ? new Date(settlement.settlementStartDate) : null,
      settlementEndDate: settlement.settlementEndDate ? new Date(settlement.settlementEndDate) : null,
      depositDate: settlement.depositDate ? new Date(settlement.depositDate) : null,
      totalAmount: settlement.totalAmount,
      currency: settlement.currency,
      marketplaceId: settlement.marketplaceId,
      transactions: settlement.transactions || [],
      summary: settlement.summary || {},
      rawData: settlement,
      source: 'make.com',
      updatedAt: new Date(),
    };

    await db.collection('amazon_settlements').updateOne(
      { settlementId: settlement.settlementId },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    res.json({ success: true, settlementId: settlement.settlementId });
  } catch (error) {
    console.error('Amazon settlements webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/financial-events
 * @desc Receive financial events from Make.com
 */
router.post('/webhook/financial-events', validateWebhook, async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const event of events) {
      const doc = {
        eventType: event.eventType || event.type,
        eventDate: event.eventDate ? new Date(event.eventDate) : new Date(),
        amazonOrderId: event.amazonOrderId,
        sellerOrderId: event.sellerOrderId,
        marketplaceId: event.marketplaceId,
        amount: event.amount,
        currency: event.currency,
        description: event.description,
        rawData: event,
        source: 'make.com',
        createdAt: new Date(),
      };

      const result = await db.collection('amazon_financial_events').insertOne(doc);
      results.push({ _id: result.insertedId, eventType: doc.eventType });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon financial-events webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/fba-fees
 * @desc Receive FBA fee data from Make.com
 */
router.post('/webhook/fba-fees', validateWebhook, async (req, res) => {
  try {
    const fees = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const fee of fees) {
      const sku = fee.sellerSku || fee.sku;
      if (!sku) {
        results.push({ error: 'Missing SKU', fee });
        continue;
      }

      const doc = {
        sellerSku: sku,
        asin: fee.asin,
        feeType: fee.feeType,
        feeAmount: fee.feeAmount,
        currency: fee.currency,
        period: fee.period,
        periodStart: fee.periodStart ? new Date(fee.periodStart) : null,
        periodEnd: fee.periodEnd ? new Date(fee.periodEnd) : null,
        rawData: fee,
        source: 'make.com',
        createdAt: new Date(),
      };

      const result = await db.collection('amazon_fba_fees').insertOne(doc);
      results.push({ _id: result.insertedId, sellerSku: sku, feeType: doc.feeType });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon fba-fees webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADVERTISING WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/ads/campaigns
 * @desc Receive advertising campaign data
 */
router.post('/webhook/ads/campaigns', validateWebhook, async (req, res) => {
  try {
    const campaigns = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const campaign of campaigns) {
      const doc = {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName || campaign.name,
        campaignType: campaign.campaignType || campaign.type, // SP, SB, SD
        state: campaign.state || campaign.status,
        dailyBudget: campaign.dailyBudget || campaign.budget,
        startDate: campaign.startDate ? new Date(campaign.startDate) : null,
        endDate: campaign.endDate ? new Date(campaign.endDate) : null,
        targetingType: campaign.targetingType,
        premiumBidAdjustment: campaign.premiumBidAdjustment,
        biddingStrategy: campaign.biddingStrategy,
        rawData: campaign,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_ads_campaigns').updateOne(
        { campaignId: campaign.campaignId },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ campaignId: campaign.campaignId, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon ads campaigns webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/ads/performance
 * @desc Receive advertising performance/metrics data
 */
router.post('/webhook/ads/performance', validateWebhook, async (req, res) => {
  try {
    const metrics = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const metric of metrics) {
      const doc = {
        campaignId: metric.campaignId,
        adGroupId: metric.adGroupId,
        date: metric.date ? new Date(metric.date) : new Date(),
        impressions: metric.impressions || 0,
        clicks: metric.clicks || 0,
        cost: metric.cost || metric.spend || 0,
        sales: metric.sales || metric.attributedSales || 0,
        orders: metric.orders || metric.attributedUnitsOrdered || 0,
        acos: metric.acos || (metric.cost && metric.sales ? (metric.cost / metric.sales * 100) : 0),
        roas: metric.roas || (metric.cost && metric.sales ? (metric.sales / metric.cost) : 0),
        ctr: metric.ctr || (metric.impressions ? (metric.clicks / metric.impressions * 100) : 0),
        cpc: metric.cpc || (metric.clicks ? (metric.cost / metric.clicks) : 0),
        conversionRate: metric.conversionRate || (metric.clicks ? (metric.orders / metric.clicks * 100) : 0),
        currency: metric.currency || 'EUR',
        rawData: metric,
        source: 'make.com',
        createdAt: new Date(),
      };

      const result = await db.collection('amazon_ads_performance').insertOne(doc);
      results.push({ _id: result.insertedId, campaignId: doc.campaignId, date: doc.date });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon ads performance webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/ads/keywords
 * @desc Receive keyword performance data
 */
router.post('/webhook/ads/keywords', validateWebhook, async (req, res) => {
  try {
    const keywords = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const kw of keywords) {
      const doc = {
        keywordId: kw.keywordId,
        campaignId: kw.campaignId,
        adGroupId: kw.adGroupId,
        keywordText: kw.keywordText || kw.keyword,
        matchType: kw.matchType,
        state: kw.state || kw.status,
        bid: kw.bid,
        impressions: kw.impressions || 0,
        clicks: kw.clicks || 0,
        cost: kw.cost || kw.spend || 0,
        sales: kw.sales || 0,
        orders: kw.orders || 0,
        acos: kw.acos || 0,
        date: kw.date ? new Date(kw.date) : new Date(),
        rawData: kw,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_ads_keywords').updateOne(
        { keywordId: kw.keywordId, date: doc.date },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ keywordId: kw.keywordId, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon ads keywords webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/ads/products
 * @desc Receive advertised product performance data
 */
router.post('/webhook/ads/products', validateWebhook, async (req, res) => {
  try {
    const products = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const prod of products) {
      const doc = {
        asin: prod.asin,
        sku: prod.sku,
        campaignId: prod.campaignId,
        adGroupId: prod.adGroupId,
        impressions: prod.impressions || 0,
        clicks: prod.clicks || 0,
        cost: prod.cost || prod.spend || 0,
        sales: prod.sales || 0,
        orders: prod.orders || 0,
        acos: prod.acos || 0,
        date: prod.date ? new Date(prod.date) : new Date(),
        rawData: prod,
        source: 'make.com',
        updatedAt: new Date(),
      };

      await db.collection('amazon_ads_products').updateOne(
        { asin: prod.asin, campaignId: prod.campaignId, date: doc.date },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ asin: prod.asin, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon ads products webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== RETURNS WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/returns
 * @desc Receive return data from Make.com
 */
router.post('/webhook/returns', validateWebhook, async (req, res) => {
  try {
    const returns = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const ret of returns) {
      const doc = {
        returnId: ret.returnId || ret.rmaId,
        amazonOrderId: ret.amazonOrderId || ret.orderId,
        sellerSku: ret.sellerSku || ret.sku,
        asin: ret.asin,
        returnRequestDate: ret.returnRequestDate ? new Date(ret.returnRequestDate) : null,
        returnReceivedDate: ret.returnReceivedDate ? new Date(ret.returnReceivedDate) : null,
        returnQuantity: ret.returnQuantity || ret.quantity || 1,
        returnReason: ret.returnReason || ret.reason,
        returnReasonCode: ret.returnReasonCode || ret.reasonCode,
        status: ret.status,
        resolution: ret.resolution,
        refundAmount: ret.refundAmount,
        currency: ret.currency,
        rawData: ret,
        source: 'make.com',
        updatedAt: new Date(),
      };

      const filter = doc.returnId
        ? { returnId: doc.returnId }
        : { amazonOrderId: doc.amazonOrderId, sellerSku: doc.sellerSku };

      await db.collection('amazon_returns').updateOne(
        filter,
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ returnId: doc.returnId, amazonOrderId: doc.amazonOrderId, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon returns webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== VAT / INVOICES WEBHOOKS ====================

/**
 * @route POST /api/amazon/webhook/vat-invoices
 * @desc Receive VAT invoice data from Make.com (VCS reports)
 */
router.post('/webhook/vat-invoices', validateWebhook, async (req, res) => {
  try {
    const invoices = Array.isArray(req.body) ? req.body : [req.body];
    const db = getDb();

    const results = [];
    for (const invoice of invoices) {
      const doc = {
        invoiceNumber: invoice.invoiceNumber,
        amazonOrderId: invoice.amazonOrderId || invoice.orderId,
        shipmentId: invoice.shipmentId,
        invoiceDate: invoice.invoiceDate ? new Date(invoice.invoiceDate) : null,
        buyerVatNumber: invoice.buyerVatNumber,
        sellerVatNumber: invoice.sellerVatNumber,
        netAmount: invoice.netAmount,
        vatAmount: invoice.vatAmount,
        totalAmount: invoice.totalAmount,
        vatRate: invoice.vatRate,
        currency: invoice.currency,
        countryCode: invoice.countryCode,
        invoiceUrl: invoice.invoiceUrl,
        rawData: invoice,
        source: 'make.com',
        updatedAt: new Date(),
      };

      const filter = doc.invoiceNumber
        ? { invoiceNumber: doc.invoiceNumber }
        : { amazonOrderId: doc.amazonOrderId, shipmentId: doc.shipmentId };

      await db.collection('amazon_vat_invoices').updateOne(
        filter,
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );

      results.push({ invoiceNumber: doc.invoiceNumber, amazonOrderId: doc.amazonOrderId, status: 'saved' });
    }

    res.json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error('Amazon vat-invoices webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/webhook/vcs-transactions
 * @desc Receive VCS transaction data from Make.com and optionally import to Odoo
 * @body { reportId, reportType, startDate, endDate, content: string|object }
 */
router.post('/webhook/vcs-transactions', validateWebhook, async (req, res) => {
  try {
    const { reportId, reportType, startDate, endDate, content, autoImport = false } = req.body;
    const db = getDb();

    // Store the raw report
    const reportDoc = {
      reportId,
      reportType: reportType || 'GET_VAT_TRANSACTION_DATA',
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      rawContent: content,
      source: 'make.com',
      createdAt: new Date(),
      importStatus: 'pending'
    };

    await db.collection('amazon_vcs_reports').insertOne(reportDoc);

    let importResult = null;

    // Auto-import to Odoo if requested and client available
    if (autoImport) {
      const odooClient = req.app.get('odooClient');
      if (odooClient) {
        try {
          const importer = new VcsInvoiceImporter(odooClient);
          await importer.init();
          importResult = await importer.importFromReport(content);

          // Update report status
          await db.collection('amazon_vcs_reports').updateOne(
            { reportId },
            { $set: { importStatus: 'completed', importResult, importedAt: new Date() } }
          );
        } catch (importError) {
          await db.collection('amazon_vcs_reports').updateOne(
            { reportId },
            { $set: { importStatus: 'failed', importError: importError.message } }
          );
          importResult = { error: importError.message };
        }
      }
    }

    // Emit event for real-time updates
    if (req.app.get('platform')) {
      req.app.get('platform').emit('amazon:vcs:received', { reportId, importResult });
    }

    res.json({
      success: true,
      reportId,
      stored: true,
      imported: importResult ? !importResult.error : false,
      importResult
    });
  } catch (error) {
    console.error('Amazon vcs-transactions webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== VCS INVOICE IMPORT ENDPOINTS ====================

/**
 * @route POST /api/amazon/import/vcs-invoices
 * @desc Import VCS transactions from MongoDB to Odoo as invoices
 * @body { reportId?: string, since?: ISO date, limit?: number }
 */
router.post('/import/vcs-invoices', async (req, res) => {
  try {
    const db = getDb();
    const { reportId, since, limit = 100 } = req.body;

    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    const importer = new VcsInvoiceImporter(odooClient);
    await importer.init();

    // Build query
    let query = { importStatus: { $ne: 'completed' } };
    if (reportId) {
      query.reportId = reportId;
    } else if (since) {
      query.createdAt = { $gte: new Date(since) };
    }

    // Fetch reports
    const reports = await db.collection('amazon_vcs_reports')
      .find(query)
      .limit(parseInt(limit))
      .toArray();

    if (reports.length === 0) {
      return res.json({ success: true, message: 'No pending VCS reports to import', imported: 0 });
    }

    const allResults = [];
    let totalImported = 0;
    let totalFailed = 0;

    for (const report of reports) {
      try {
        const result = await importer.importFromReport(report.rawContent);
        allResults.push({ reportId: report.reportId, ...result });
        totalImported += result.imported;
        totalFailed += result.failed;

        // Update report status
        await db.collection('amazon_vcs_reports').updateOne(
          { _id: report._id },
          { $set: { importStatus: 'completed', importResult: result, importedAt: new Date() } }
        );
      } catch (err) {
        allResults.push({ reportId: report.reportId, error: err.message });
        totalFailed++;

        await db.collection('amazon_vcs_reports').updateOne(
          { _id: report._id },
          { $set: { importStatus: 'failed', importError: err.message } }
        );
      }
    }

    res.json({
      success: true,
      reportsProcessed: reports.length,
      totalImported,
      totalFailed,
      results: allResults
    });
  } catch (error) {
    console.error('VCS invoice import error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/import/vcs-invoice/:amazonOrderId
 * @desc Import a single VCS transaction by Amazon Order ID
 */
router.post('/import/vcs-invoice/:amazonOrderId', async (req, res) => {
  try {
    const db = getDb();
    const { amazonOrderId } = req.params;

    const odooClient = req.app.get('odooClient');
    if (!odooClient) {
      return res.status(503).json({ error: 'Odoo client not available' });
    }

    // Find the transaction in stored invoices
    const invoice = await db.collection('amazon_vat_invoices').findOne({
      amazonOrderId
    });

    if (!invoice) {
      return res.status(404).json({ error: 'VCS invoice not found for this order' });
    }

    const importer = new VcsInvoiceImporter(odooClient);
    await importer.init();

    const result = await importer.importTransaction(invoice.rawData || invoice);

    // Update invoice record with import status
    await db.collection('amazon_vat_invoices').updateOne(
      { amazonOrderId },
      {
        $set: {
          odooImport: {
            success: result.success,
            odooInvoiceId: result.odooInvoiceId,
            odooInvoiceName: result.odooInvoiceName,
            errors: result.errors,
            warnings: result.warnings,
            importedAt: new Date()
          }
        }
      }
    );

    res.json(result);
  } catch (error) {
    console.error('Single VCS invoice import error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/vcs/reports
 * @desc Get list of VCS reports
 */
router.get('/vcs/reports', async (req, res) => {
  try {
    const db = getDb();
    const { status, limit = 20, skip = 0 } = req.query;

    const query = {};
    if (status) {
      query.importStatus = status;
    }

    const reports = await db.collection('amazon_vcs_reports')
      .find(query, {
        projection: {
          reportId: 1,
          reportType: 1,
          startDate: 1,
          endDate: 1,
          importStatus: 1,
          importedAt: 1,
          createdAt: 1,
          'importResult.imported': 1,
          'importResult.failed': 1
        }
      })
      .sort({ createdAt: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .toArray();

    const total = await db.collection('amazon_vcs_reports').countDocuments(query);

    res.json({ reports, total, limit: parseInt(limit), skip: parseInt(skip) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/vcs/import-status
 * @desc Get VCS import statistics
 */
router.get('/vcs/import-status', async (req, res) => {
  try {
    const db = getDb();

    const [reportStats, invoiceStats] = await Promise.all([
      db.collection('amazon_vcs_reports').aggregate([
        {
          $group: {
            _id: '$importStatus',
            count: { $sum: 1 }
          }
        }
      ]).toArray(),
      db.collection('amazon_vcs_imports').aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            success: { $sum: { $cond: ['$success', 1, 0] } },
            failed: { $sum: { $cond: ['$success', 0, 1] } }
          }
        }
      ]).toArray()
    ]);

    const statusCounts = {};
    for (const stat of reportStats) {
      statusCounts[stat._id || 'unknown'] = stat.count;
    }

    res.json({
      reports: {
        pending: statusCounts.pending || 0,
        completed: statusCounts.completed || 0,
        failed: statusCounts.failed || 0,
        total: Object.values(statusCounts).reduce((a, b) => a + b, 0)
      },
      invoices: invoiceStats[0] || { total: 0, success: 0, failed: 0 }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== REPORTS WEBHOOK ====================

/**
 * @route POST /api/amazon/webhook/report
 * @desc Receive any report data from Make.com
 */
router.post('/webhook/report', validateWebhook, async (req, res) => {
  try {
    const { reportType, reportId, data, metadata } = req.body;

    if (!reportType) {
      return res.status(400).json({ error: 'reportType required' });
    }

    const db = getDb();
    const doc = {
      reportType,
      reportId,
      data: data || req.body,
      metadata: metadata || {},
      source: 'make.com',
      createdAt: new Date(),
    };

    const result = await db.collection('amazon_reports').insertOne(doc);

    res.json({ success: true, _id: result.insertedId, reportType });
  } catch (error) {
    console.error('Amazon report webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== DATA ACCESS ENDPOINTS ====================

/**
 * @route GET /api/amazon/orders
 * @desc Get Amazon orders with filters
 */
router.get('/orders', async (req, res) => {
  try {
    const db = getDb();
    const { status, from, to, limit = 50, skip = 0 } = req.query;

    const filter = {};
    if (status) filter.orderStatus = status;
    if (from || to) {
      filter.purchaseDate = {};
      if (from) filter.purchaseDate.$gte = new Date(from);
      if (to) filter.purchaseDate.$lte = new Date(to);
    }

    const orders = await db.collection('amazon_orders')
      .find(filter)
      .sort({ purchaseDate: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .toArray();

    const total = await db.collection('amazon_orders').countDocuments(filter);

    res.json({ orders, total, limit: parseInt(limit), skip: parseInt(skip) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/inventory
 * @desc Get Amazon inventory
 */
router.get('/inventory', async (req, res) => {
  try {
    const db = getDb();
    const { lowStock, limit = 100 } = req.query;

    const filter = {};
    if (lowStock === 'true') {
      filter.fulfillableQuantity = { $lte: 10 };
    }

    const inventory = await db.collection('amazon_inventory')
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit))
      .toArray();

    res.json({ inventory, count: inventory.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/returns
 * @desc Get Amazon returns
 */
router.get('/returns', async (req, res) => {
  try {
    const db = getDb();
    const { from, to, limit = 50 } = req.query;

    const filter = {};
    if (from || to) {
      filter.returnRequestDate = {};
      if (from) filter.returnRequestDate.$gte = new Date(from);
      if (to) filter.returnRequestDate.$lte = new Date(to);
    }

    const returns = await db.collection('amazon_returns')
      .find(filter)
      .sort({ returnRequestDate: -1 })
      .limit(parseInt(limit))
      .toArray();

    res.json({ returns, count: returns.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/financial-summary
 * @desc Get financial summary for a period
 */
router.get('/financial-summary', async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;

    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    // Aggregate orders
    const orderMatch = {};
    if (Object.keys(dateFilter).length) orderMatch.purchaseDate = dateFilter;

    const orderStats = await db.collection('amazon_orders').aggregate([
      { $match: orderMatch },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: { $toDouble: '$orderTotal.Amount' } },
          shippedOrders: {
            $sum: { $cond: [{ $eq: ['$orderStatus', 'Shipped'] }, 1, 0] }
          },
          pendingOrders: {
            $sum: { $cond: [{ $in: ['$orderStatus', ['Pending', 'Unshipped']] }, 1, 0] }
          }
        }
      }
    ]).toArray();

    // Aggregate returns
    const returnMatch = {};
    if (Object.keys(dateFilter).length) returnMatch.returnRequestDate = dateFilter;

    const returnStats = await db.collection('amazon_returns').aggregate([
      { $match: returnMatch },
      {
        $group: {
          _id: null,
          totalReturns: { $sum: 1 },
          totalRefunded: { $sum: { $toDouble: '$refundAmount' } }
        }
      }
    ]).toArray();

    // Get FBA fees
    const feeMatch = {};
    if (Object.keys(dateFilter).length) feeMatch.createdAt = dateFilter;

    const feeStats = await db.collection('amazon_fba_fees').aggregate([
      { $match: feeMatch },
      {
        $group: {
          _id: '$feeType',
          total: { $sum: { $toDouble: '$feeAmount' } }
        }
      }
    ]).toArray();

    res.json({
      period: { from, to },
      orders: orderStats[0] || { totalOrders: 0, totalRevenue: 0 },
      returns: returnStats[0] || { totalReturns: 0, totalRefunded: 0 },
      fees: feeStats,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/ads/campaigns
 * @desc Get advertising campaigns
 */
router.get('/ads/campaigns', async (req, res) => {
  try {
    const db = getDb();
    const { state, type, limit = 50 } = req.query;

    const filter = {};
    if (state) filter.state = state;
    if (type) filter.campaignType = type;

    const campaigns = await db.collection('amazon_ads_campaigns')
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit))
      .toArray();

    res.json({ campaigns, count: campaigns.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/ads/performance
 * @desc Get advertising performance metrics
 */
router.get('/ads/performance', async (req, res) => {
  try {
    const db = getDb();
    const { campaignId, from, to, limit = 100 } = req.query;

    const filter = {};
    if (campaignId) filter.campaignId = campaignId;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }

    const performance = await db.collection('amazon_ads_performance')
      .find(filter)
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .toArray();

    res.json({ performance, count: performance.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/ads/summary
 * @desc Get advertising summary for a period
 */
router.get('/ads/summary', async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;

    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    const match = {};
    if (Object.keys(dateFilter).length) match.date = dateFilter;

    const summary = await db.collection('amazon_ads_performance').aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalImpressions: { $sum: '$impressions' },
          totalClicks: { $sum: '$clicks' },
          totalCost: { $sum: '$cost' },
          totalSales: { $sum: '$sales' },
          totalOrders: { $sum: '$orders' },
        }
      }
    ]).toArray();

    const stats = summary[0] || {
      totalImpressions: 0,
      totalClicks: 0,
      totalCost: 0,
      totalSales: 0,
      totalOrders: 0,
    };

    // Calculate derived metrics
    stats.acos = stats.totalSales > 0 ? (stats.totalCost / stats.totalSales * 100).toFixed(2) : 0;
    stats.roas = stats.totalCost > 0 ? (stats.totalSales / stats.totalCost).toFixed(2) : 0;
    stats.ctr = stats.totalImpressions > 0 ? (stats.totalClicks / stats.totalImpressions * 100).toFixed(2) : 0;
    stats.cpc = stats.totalClicks > 0 ? (stats.totalCost / stats.totalClicks).toFixed(2) : 0;

    res.json({ period: { from, to }, ...stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/stats
 * @desc Get overall Amazon integration stats
 */
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();

    const [orders, inventory, returns, settlements, invoices, adsCampaigns, adsPerformance] = await Promise.all([
      db.collection('amazon_orders').countDocuments(),
      db.collection('amazon_inventory').countDocuments(),
      db.collection('amazon_returns').countDocuments(),
      db.collection('amazon_settlements').countDocuments(),
      db.collection('amazon_vat_invoices').countDocuments(),
      db.collection('amazon_ads_campaigns').countDocuments(),
      db.collection('amazon_ads_performance').countDocuments(),
    ]);

    // Get last sync times
    const lastOrder = await db.collection('amazon_orders').findOne({}, { sort: { updatedAt: -1 } });
    const lastInventory = await db.collection('amazon_inventory').findOne({}, { sort: { updatedAt: -1 } });
    const lastAds = await db.collection('amazon_ads_performance').findOne({}, { sort: { createdAt: -1 } });

    res.json({
      counts: { orders, inventory, returns, settlements, invoices, adsCampaigns, adsPerformance },
      lastSync: {
        orders: lastOrder?.updatedAt,
        inventory: lastInventory?.updatedAt,
        ads: lastAds?.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SETTLEMENT REPORT UPLOAD ====================

/**
 * Parse Amazon Settlement Report TSV/CSV
 * Amazon uses tab-separated values with specific column headers
 */
function parseSettlementReport(content) {
  // Detect delimiter (tab or comma)
  const firstLine = content.split('\n')[0];
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length < 2) {
    throw new Error('File appears to be empty or invalid');
  }

  // Parse headers (convert to camelCase for consistency)
  const headers = lines[0].split(delimiter).map(h => {
    return h.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+(.)/g, (m, chr) => chr.toUpperCase())
      .replace(/[^a-z0-9]/g, '');
  });

  const transactions = [];
  let settlementId = null;
  let startDate = null;
  let endDate = null;
  let depositDate = null;
  let totalAmount = 0;
  let currency = null;

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter);
    const row = {};

    headers.forEach((header, index) => {
      let value = values[index]?.trim() || '';
      // Remove quotes if present
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      row[header] = value;
    });

    // Extract settlement metadata from first data row
    if (!settlementId && row.settlementId) {
      settlementId = row.settlementId;
    }
    if (!startDate && row.settlementStartDate) {
      startDate = row.settlementStartDate;
    }
    if (!endDate && row.settlementEndDate) {
      endDate = row.settlementEndDate;
    }
    if (!depositDate && row.depositDate) {
      depositDate = row.depositDate;
    }
    if (!currency && row.currency) {
      currency = row.currency;
    }

    // Parse numeric fields
    const numericFields = [
      'quantity', 'productSales', 'productSalesTax', 'shippingCredits',
      'shippingCreditsTax', 'giftWrapCredits', 'giftWrapCreditsTax',
      'promotionalRebates', 'promotionalRebatesTax', 'salesTaxCollected',
      'marketplaceWithheldTax', 'sellingFees', 'fbaFees', 'otherTransactionFees',
      'other', 'total', 'totalAmount'
    ];

    numericFields.forEach(field => {
      if (row[field]) {
        row[field] = parseFloat(row[field]) || 0;
      }
    });

    // Track total from each row
    if (row.total) {
      totalAmount += row.total;
    }

    transactions.push(row);
  }

  return {
    settlementId: settlementId || `manual-${Date.now()}`,
    startDate: startDate ? new Date(startDate) : null,
    endDate: endDate ? new Date(endDate) : null,
    depositDate: depositDate ? new Date(depositDate) : null,
    totalAmount,
    currency: currency || 'EUR',
    transactionCount: transactions.length,
    transactions
  };
}

/**
 * @route POST /api/amazon/upload/settlement
 * @desc Upload and parse Amazon settlement report (CSV/TSV)
 */
router.post('/upload/settlement', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const content = req.file.buffer.toString('utf-8');
    const parsed = parseSettlementReport(content);

    const db = getDb();

    // Store the settlement
    const doc = {
      settlementId: parsed.settlementId,
      settlementStartDate: parsed.startDate,
      settlementEndDate: parsed.endDate,
      depositDate: parsed.depositDate,
      totalAmount: parsed.totalAmount,
      currency: parsed.currency,
      transactionCount: parsed.transactionCount,
      transactions: parsed.transactions,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      source: 'manual-upload',
      uploadedAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('amazon_settlements').updateOne(
      { settlementId: parsed.settlementId },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    // Create summary of fees by type
    const feesSummary = {
      productSales: 0,
      shippingCredits: 0,
      sellingFees: 0,
      fbaFees: 0,
      otherFees: 0,
      promotionalRebates: 0,
      refunds: 0
    };

    parsed.transactions.forEach(tx => {
      feesSummary.productSales += tx.productSales || 0;
      feesSummary.shippingCredits += tx.shippingCredits || 0;
      feesSummary.sellingFees += tx.sellingFees || 0;
      feesSummary.fbaFees += tx.fbaFees || 0;
      feesSummary.otherFees += (tx.otherTransactionFees || 0) + (tx.other || 0);
      feesSummary.promotionalRebates += tx.promotionalRebates || 0;
      if (tx.transactionType?.toLowerCase().includes('refund')) {
        feesSummary.refunds += tx.total || 0;
      }
    });

    res.json({
      success: true,
      settlementId: parsed.settlementId,
      period: {
        start: parsed.startDate,
        end: parsed.endDate
      },
      depositDate: parsed.depositDate,
      totalAmount: parsed.totalAmount,
      currency: parsed.currency,
      transactionCount: parsed.transactionCount,
      feesSummary,
      isNew: result.upsertedCount > 0
    });

  } catch (error) {
    console.error('Settlement upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/settlement/upload
 * @desc Upload and parse Amazon settlement report for RECONCILIATION
 * NOTE: Vendor bills are NOT created here - they come from PEPPOL invoices
 * @body file - CSV/TSV settlement report
 * @query dryRun - Set to 'true' for dry run (no database storage)
 */
router.post('/settlement/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const dryRun = req.query.dryRun === 'true';

    // Process the settlement report (for reconciliation only)
    const parser = new SettlementReportParser();
    const result = await parser.processSettlement(req.file.buffer, { dryRun });

    // Build user-friendly message
    const feesSummary = Object.entries(result.feesByMarketplace || {})
      .filter(([_, fees]) => fees.total !== 0)
      .map(([mp, fees]) => `${mp}: ${fees.total.toFixed(2)} EUR`)
      .join(', ');

    const ordersSummary = Object.entries(result.ordersByMarketplace || {})
      .filter(([_, orders]) => orders.total !== 0)
      .map(([mp, orders]) => `${mp}: ${orders.total.toFixed(2)} EUR`)
      .join(', ');

    const message = `Processed ${result.transactionCount} transactions. ` +
      `Fees: ${feesSummary || 'none'}. ` +
      `Order revenue: ${ordersSummary || 'none'}. ` +
      `Net amount: ${result.totalAmount.toFixed(2)} ${result.currency}`;

    res.json({
      success: true,
      message,
      note: 'Vendor bills are created from PEPPOL invoices, not settlement reports. This data is for reconciliation only.',
      ...result,
    });

  } catch (error) {
    console.error('Settlement upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/settlements
 * @desc Get list of uploaded settlements
 */
router.get('/settlements', async (req, res) => {
  try {
    const db = getDb();
    const { limit = 20, skip = 0 } = req.query;

    const settlements = await db.collection('amazon_settlements')
      .find({}, {
        projection: {
          settlementId: 1,
          settlementStartDate: 1,
          settlementEndDate: 1,
          depositDate: 1,
          totalAmount: 1,
          currency: 1,
          transactionCount: 1,
          source: 1,
          uploadedAt: 1,
          createdAt: 1
        }
      })
      .sort({ settlementEndDate: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .toArray();

    const total = await db.collection('amazon_settlements').countDocuments();

    res.json({ settlements, total, limit: parseInt(limit), skip: parseInt(skip) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/settlements/:id
 * @desc Get settlement details by ID
 */
router.get('/settlements/:id', async (req, res) => {
  try {
    const db = getDb();
    const settlement = await db.collection('amazon_settlements').findOne({
      $or: [
        { settlementId: req.params.id },
        { _id: ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null }
      ]
    });

    if (!settlement) {
      return res.status(404).json({ error: 'Settlement not found' });
    }

    res.json(settlement);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/settlement-reminders
 * @desc Get settlement upload reminders/status
 */
router.get('/settlement-reminders', async (req, res) => {
  try {
    const db = getDb();

    // Get the most recent settlement
    const lastSettlement = await db.collection('amazon_settlements')
      .findOne({}, { sort: { settlementEndDate: -1 } });

    // Amazon releases settlements bi-weekly
    // Calculate if we're due for a new one
    const now = new Date();
    const daysSinceLastSettlement = lastSettlement?.settlementEndDate
      ? Math.floor((now - new Date(lastSettlement.settlementEndDate)) / (1000 * 60 * 60 * 24))
      : 999;

    // Get count of settlements in the last 90 days
    const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const recentCount = await db.collection('amazon_settlements').countDocuments({
      settlementEndDate: { $gte: threeMonthsAgo }
    });

    // Expected: ~6 settlements in 90 days (bi-weekly)
    const expectedCount = 6;
    const missingEstimate = Math.max(0, expectedCount - recentCount);

    res.json({
      lastSettlement: lastSettlement ? {
        settlementId: lastSettlement.settlementId,
        endDate: lastSettlement.settlementEndDate,
        depositDate: lastSettlement.depositDate,
        totalAmount: lastSettlement.totalAmount
      } : null,
      daysSinceLastSettlement,
      isOverdue: daysSinceLastSettlement > 16, // More than ~2 weeks
      recentCount,
      expectedCount,
      missingEstimate,
      message: daysSinceLastSettlement > 16
        ? `Settlement report overdue! Last one was ${daysSinceLastSettlement} days ago.`
        : daysSinceLastSettlement > 12
        ? `New settlement report should be available soon.`
        : `Settlement reports are up to date.`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/system-reminders
 * @desc Get all Amazon-related system reminders for UI display
 */
router.get('/system-reminders', async (req, res) => {
  try {
    const db = getDb();

    const reminders = await db.collection('system_reminders')
      .find({ type: { $regex: /^amazon/ } })
      .toArray();

    // Also include real-time settlement status
    const lastSettlement = await db.collection('amazon_settlements')
      .findOne({}, { sort: { settlementEndDate: -1 } });

    const now = new Date();
    const daysSinceLastSettlement = lastSettlement?.settlementEndDate
      ? Math.floor((now - new Date(lastSettlement.settlementEndDate)) / (1000 * 60 * 60 * 24))
      : 999;

    res.json({
      reminders,
      settlementStatus: {
        isOverdue: daysSinceLastSettlement > 16,
        daysSince: daysSinceLastSettlement,
        lastDate: lastSettlement?.settlementEndDate,
        nextExpected: lastSettlement?.settlementEndDate
          ? new Date(new Date(lastSettlement.settlementEndDate).getTime() + 14 * 24 * 60 * 60 * 1000)
          : null
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SKU MAPPING ENDPOINTS ====================

/**
 * @route GET /api/amazon/config/sku-mappings
 * @desc Get all custom SKU mappings
 */
router.get('/config/sku-mappings', async (req, res) => {
  try {
    await skuResolver.load();
    res.json({
      mappings: skuResolver.getMappings(),
      returnPatterns: skuResolver.getReturnPatterns()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/config/sku-mappings
 * @desc Add or update a SKU mapping
 * @body { amazonSku: string, odooSku: string }
 */
router.post('/config/sku-mappings', async (req, res) => {
  try {
    const { amazonSku, odooSku } = req.body;
    if (!amazonSku || !odooSku) {
      return res.status(400).json({ error: 'amazonSku and odooSku are required' });
    }

    await skuResolver.addMapping(amazonSku, odooSku);
    res.json({ success: true, amazonSku, odooSku });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/config/sku-mappings/import
 * @desc Import multiple SKU mappings from CSV
 * @body { mappings: [{ amazonSku, odooSku }] } OR file upload
 */
router.post('/config/sku-mappings/import', upload.single('file'), async (req, res) => {
  try {
    let mappings = [];

    if (req.file) {
      // Parse CSV file
      const content = req.file.buffer.toString('utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      // Skip header if present
      const startIdx = lines[0].toLowerCase().includes('amazon') ? 1 : 0;

      for (let i = startIdx; i < lines.length; i++) {
        const parts = lines[i].split(/[,\t;]/);
        if (parts.length >= 2) {
          mappings.push({
            amazonSku: parts[0].trim().replace(/"/g, ''),
            odooSku: parts[1].trim().replace(/"/g, '')
          });
        }
      }
    } else if (req.body.mappings) {
      mappings = req.body.mappings;
    } else {
      return res.status(400).json({ error: 'No mappings provided' });
    }

    const result = await skuResolver.importMappings(mappings);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route DELETE /api/amazon/config/sku-mappings/:amazonSku
 * @desc Delete a SKU mapping
 */
router.delete('/config/sku-mappings/:amazonSku', async (req, res) => {
  try {
    await skuResolver.deleteMapping(req.params.amazonSku);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/config/return-patterns
 * @desc Add a return SKU pattern (regex)
 * @body { pattern: string, extractGroup: number, flags: string }
 */
router.post('/config/return-patterns', async (req, res) => {
  try {
    const { pattern, extractGroup = 1, flags = 'i' } = req.body;
    if (!pattern) {
      return res.status(400).json({ error: 'pattern is required' });
    }

    // Test if regex is valid
    try {
      new RegExp(pattern, flags);
    } catch (e) {
      return res.status(400).json({ error: `Invalid regex: ${e.message}` });
    }

    await skuResolver.addReturnPattern(pattern, extractGroup, flags);
    res.json({ success: true, pattern, extractGroup, flags });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/config/resolve-sku
 * @desc Test SKU resolution
 * @body { amazonSku: string } OR { amazonSkus: string[] }
 */
router.post('/config/resolve-sku', async (req, res) => {
  try {
    await skuResolver.load();

    if (req.body.amazonSkus) {
      const results = skuResolver.resolveMany(req.body.amazonSkus);
      res.json({ results: Object.fromEntries(results) });
    } else if (req.body.amazonSku) {
      const result = skuResolver.resolve(req.body.amazonSku);
      res.json(result);
    } else {
      return res.status(400).json({ error: 'amazonSku or amazonSkus required' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== EU COUNTRY CONFIG ENDPOINTS ====================

/**
 * @route GET /api/amazon/config/countries
 * @desc Get all EU country configurations
 */
router.get('/config/countries', (req, res) => {
  res.json({
    countries: euCountryConfig.getAllCountries(),
    vatRegisteredCountries: euCountryConfig.getVatRegisteredCountries()
  });
});

/**
 * @route POST /api/amazon/config/invoice-config
 * @desc Get invoice configuration for an order
 * @body { marketplaceId, fulfillmentCenter, buyerCountry, buyerVat }
 */
router.post('/config/invoice-config', (req, res) => {
  const { marketplaceId, fulfillmentCenter, buyerCountry, buyerVat } = req.body;
  const config = euCountryConfig.getInvoiceConfig({
    marketplaceId,
    fulfillmentCenter,
    buyerCountry,
    buyerVat
  });
  res.json(config);
});

// ==================== VCS TAX REPORT UPLOAD ====================

/**
 * @route POST /api/amazon/vcs/upload
 * @desc Upload and parse a VCS Tax Report CSV file
 * @file CSV file from Amazon Tax Document Library
 */
router.post('/vcs/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const db = getDb();
    const fileContent = req.file.buffer.toString('utf-8');

    // Generate unique filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeOriginalName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const storedFilename = `${timestamp}_${safeOriginalName}`;
    const filePath = path.join(UPLOADS_DIR, storedFilename);

    // Save file to disk
    fs.writeFileSync(filePath, fileContent);

    // Parse the report
    const parser = new VcsTaxReportParser();
    const result = await parser.processReport(fileContent, req.file.originalname);

    // Create upload record with full metadata
    const uploadRecord = {
      originalFilename: req.file.originalname,
      storedFilename: storedFilename,
      filePath: filePath,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      uploadedAt: new Date(),
      uploadedBy: req.user?.email || 'anonymous',

      // Processing results
      status: 'processed',
      transactionCount: result.transactionCount,
      orderCount: result.orderCount,
      totalRevenue: result.summary?.totalRevenue || 0,
      currency: result.summary?.currencies?.[0] || 'EUR',

      // Date range of data in file
      dateRange: result.dateRange || null,

      // Breakdown by VAT config
      vatConfigBreakdown: result.summary?.byVatConfig || {},

      // Breakdown by country
      countryBreakdown: result.summary?.byCountry || {},

      // Processing stats
      pendingOrders: result.orderCount,
      invoicedOrders: 0,
      skippedOrders: 0,
      errorOrders: 0,

      // Link to parsed orders
      reportId: result.reportId
    };

    const uploadResult = await db.collection('amazon_vcs_uploads').insertOne(uploadRecord);

    // Update the VCS report record with upload ID
    if (result.reportId) {
      await db.collection('amazon_vcs_reports').updateOne(
        { _id: new ObjectId(result.reportId) },
        { $set: { uploadId: uploadResult.insertedId } }
      );
    }

    res.json({
      success: true,
      message: `Processed ${result.transactionCount} transactions from ${result.orderCount} orders`,
      uploadId: uploadResult.insertedId.toString(),
      ...result
    });

  } catch (error) {
    console.error('[VCS Upload] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/vcs/check-odoo
 * @desc Check Odoo for existing sales orders matching Amazon order IDs
 * @body { orderIds: string[] } - Array of Amazon order IDs to check
 */
router.post('/vcs/check-odoo', async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: 'orderIds array required' });
    }

    // Initialize Odoo client
    const odooClient = new OdooDirectClient();
    await odooClient.authenticate();

    // Search for sales orders with matching client_order_ref
    // Odoo stores Amazon order IDs in the 'client_order_ref' field
    const matchedOrders = {};

    // Use 'in' operator with larger batches for much better performance
    // The 'in' operator is far more efficient than building OR domains
    const batchSize = 500;
    console.log(`[VCS Check Odoo] Checking ${orderIds.length} order IDs in batches of ${batchSize}...`);

    for (let i = 0; i < orderIds.length; i += batchSize) {
      const batch = orderIds.slice(i, i + batchSize);

      // Use 'in' operator - much simpler and faster than OR domain
      const domain = [['client_order_ref', 'in', batch]];

      const orders = await odooClient.searchRead('sale.order', domain, ['name', 'client_order_ref', 'state', 'amount_total']);

      // Map orders back to Amazon order IDs
      for (const order of orders) {
        const ref = order.client_order_ref || '';
        matchedOrders[ref] = {
          orderNumber: order.name,
          state: order.state,
          amount: order.amount_total
        };
      }

      // Log progress for large batches
      if (orderIds.length > 1000 && (i + batchSize) % 2000 === 0) {
        console.log(`[VCS Check Odoo] Processed ${Math.min(i + batchSize, orderIds.length)}/${orderIds.length} order IDs...`);
      }
    }

    console.log(`[VCS Check Odoo] Found ${Object.keys(matchedOrders).length} matching orders out of ${orderIds.length} checked`);

    res.json({
      success: true,
      matchedCount: Object.keys(matchedOrders).length,
      totalChecked: orderIds.length,
      orders: matchedOrders
    });

  } catch (error) {
    console.error('[VCS Check Odoo] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/vcs/uploads
 * @desc Get list of all VCS uploads with metadata
 */
router.get('/vcs/uploads', async (req, res) => {
  try {
    const db = getDb();
    const uploads = await db.collection('amazon_vcs_uploads')
      .find({})
      .sort({ uploadedAt: -1 })
      .limit(100)
      .toArray();

    // For each upload, compute real-time order counts from amazon_vcs_orders
    const enrichedUploads = await Promise.all(uploads.map(async (upload) => {
      // Get orders linked to this upload's report
      const reportId = upload.reportId;
      if (reportId && ObjectId.isValid(reportId)) {
        // Orders store reportId as ObjectId, upload stores it as string - convert to ObjectId for matching
        const statusCounts = await db.collection('amazon_vcs_orders').aggregate([
          { $match: { reportId: new ObjectId(reportId) } },
          { $group: {
            _id: { status: '$status', transactionType: '$transactionType' },
            count: { $sum: 1 }
          } }
        ]).toArray();

        let pending = 0, invoiced = 0, skipped = 0;
        let pendingReturns = 0, creditedReturns = 0;
        for (const s of statusCounts) {
          const isReturn = s._id.transactionType === 'RETURN';
          if (isReturn) {
            if (s._id.status === 'pending') pendingReturns = s.count;
            if (s._id.status === 'credit_noted') creditedReturns = s.count;
          } else {
            if (s._id.status === 'pending') pending = s.count;
            if (s._id.status === 'invoiced') invoiced = s.count;
            if (s._id.status === 'skipped') skipped = s.count;
          }
        }

        // Override static counts with real-time counts
        upload.pendingOrders = pending;
        upload.invoicedOrders = invoiced;
        upload.skippedOrders = skipped;
        upload.pendingReturns = pendingReturns;
        upload.creditedReturns = creditedReturns;
      }
      return upload;
    }));

    res.json({ uploads: enrichedUploads });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/vcs/uploads/:uploadId/download
 * @desc Download the original uploaded file
 */
router.get('/vcs/uploads/:uploadId/download', async (req, res) => {
  try {
    const db = getDb();
    const upload = await db.collection('amazon_vcs_uploads').findOne({
      _id: new ObjectId(req.params.uploadId)
    });

    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    if (!fs.existsSync(upload.filePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${upload.originalFilename}"`);
    res.sendFile(upload.filePath);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/vcs/reports
 * @desc Get list of uploaded VCS reports
 */
router.get('/vcs/reports', async (req, res) => {
  try {
    const db = getDb();
    const reports = await db.collection('amazon_vcs_reports')
      .find({})
      .sort({ uploadedAt: -1 })
      .limit(50)
      .toArray();

    res.json({ reports });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/vcs/reports/:reportId/orders
 * @desc Get orders from a specific VCS report
 */
router.get('/vcs/reports/:reportId/orders', async (req, res) => {
  try {
    const db = getDb();
    const reportId = new ObjectId(req.params.reportId);

    const orders = await db.collection('amazon_vcs_orders')
      .find({ reportId })
      .sort({ orderDate: -1 })
      .toArray();

    res.json({
      reportId: req.params.reportId,
      orderCount: orders.length,
      orders
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/vcs/orders/pending
 * @desc Get VCS shipment orders pending invoice creation in Odoo
 */
router.get('/vcs/orders/pending', async (req, res) => {
  try {
    const db = getDb();

    // Only return SHIPMENT orders (not RETURN)
    const orders = await db.collection('amazon_vcs_orders')
      .find({
        status: 'pending',
        $or: [
          { transactionType: 'SHIPMENT' },
          { transactionType: { $exists: false } } // Legacy orders without transactionType
        ]
      })
      .sort({ orderDate: -1 })
      .toArray();

    // Add VAT config to each order
    const parser = new VcsTaxReportParser();
    const ordersWithConfig = orders.map(order => ({
      ...order,
      vatConfig: parser.determineVatConfig(order)
    }));

    res.json({
      pendingCount: orders.length,
      orders: ordersWithConfig
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/vcs/returns/pending
 * @desc Get VCS return orders pending credit note creation in Odoo
 */
router.get('/vcs/returns/pending', async (req, res) => {
  try {
    const db = getDb();

    // Only return RETURN orders
    const orders = await db.collection('amazon_vcs_orders')
      .find({
        status: 'pending',
        transactionType: 'RETURN'
      })
      .sort({ returnDate: -1, orderDate: -1 })
      .toArray();

    // Add VAT config to each order
    const parser = new VcsTaxReportParser();
    const ordersWithConfig = orders.map(order => ({
      ...order,
      vatConfig: parser.determineVatConfig(order)
    }));

    res.json({
      pendingCount: orders.length,
      orders: ordersWithConfig
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/vcs/orders/:orderId/mark-invoiced
 * @desc Mark a VCS order as invoiced in Odoo
 * @body { odooInvoiceId, odooInvoiceName }
 */
router.post('/vcs/orders/:orderId/mark-invoiced', async (req, res) => {
  try {
    const db = getDb();
    const { odooInvoiceId, odooInvoiceName } = req.body;

    const result = await db.collection('amazon_vcs_orders').updateOne(
      { _id: new ObjectId(req.params.orderId) },
      {
        $set: {
          status: 'invoiced',
          odooInvoiceId,
          odooInvoiceName,
          invoicedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, message: 'Order marked as invoiced' });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/vcs/orders/batch-mark-invoiced
 * @desc Mark multiple VCS orders as invoiced
 * @body { orderIds: string[], odooInvoicePrefix: string }
 */
router.post('/vcs/orders/batch-mark-invoiced', async (req, res) => {
  try {
    const db = getDb();
    const { orderIds, odooInvoicePrefix } = req.body;

    if (!orderIds || !Array.isArray(orderIds)) {
      return res.status(400).json({ error: 'orderIds array required' });
    }

    const objectIds = orderIds.map(id => new ObjectId(id));

    const result = await db.collection('amazon_vcs_orders').updateMany(
      { _id: { $in: objectIds } },
      {
        $set: {
          status: 'invoiced',
          odooInvoicePrefix,
          invoicedAt: new Date()
        }
      }
    );

    res.json({
      success: true,
      updatedCount: result.modifiedCount
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/vcs/update-invoice-urls
 * @desc Update invoice_url field in Odoo for invoiced VCS orders
 * @body { dryRun?: boolean } - If true, just return what would be updated
 */
router.post('/vcs/update-invoice-urls', async (req, res) => {
  try {
    const db = getDb();
    const { dryRun = false } = req.body;

    // Get all invoiced orders that have an invoiceUrl and an odooInvoiceId
    const orders = await db.collection('amazon_vcs_orders')
      .find({
        status: 'invoiced',
        invoiceUrl: { $exists: true, $ne: null, $ne: '' },
        odooInvoiceId: { $exists: true, $ne: null }
      })
      .toArray();

    if (orders.length === 0) {
      return res.json({
        success: true,
        message: 'No invoiced orders with invoice URLs found',
        updated: 0
      });
    }

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        message: `Would update ${orders.length} invoices with invoice URLs`,
        orders: orders.map(o => ({
          orderId: o.orderId,
          odooInvoiceId: o.odooInvoiceId,
          odooInvoiceName: o.odooInvoiceName,
          invoiceUrl: o.invoiceUrl
        }))
      });
    }

    // Create Odoo client
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    let updated = 0;
    let errors = [];

    for (const order of orders) {
      try {
        // Update the invoice_url field in Odoo
        await odoo.execute('account.move', 'write', [
          [order.odooInvoiceId],
          { invoice_url: order.invoiceUrl }
        ]);
        updated++;

        // Add small delay to prevent Odoo overload
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        errors.push({
          orderId: order.orderId,
          odooInvoiceId: order.odooInvoiceId,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `Updated ${updated} invoices with invoice URLs`,
      updated,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('[VCS] Error updating invoice URLs:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/vcs/summary
 * @desc Get summary of VCS data for a date range
 * @query from, to (ISO dates)
 */
router.get('/vcs/summary', async (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;

    const match = {};
    if (from || to) {
      match.orderDate = {};
      if (from) match.orderDate.$gte = new Date(from);
      if (to) match.orderDate.$lte = new Date(to);
    }

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: {
            currency: '$currency',
            country: '$shipToCountry',
            status: '$status'
          },
          count: { $sum: 1 },
          totalExclusive: { $sum: '$totalExclusive' },
          totalTax: { $sum: '$totalTax' },
          totalInclusive: { $sum: '$totalInclusive' }
        }
      },
      { $sort: { '_id.currency': 1, '_id.country': 1 } }
    ];

    const summary = await db.collection('amazon_vcs_orders')
      .aggregate(pipeline)
      .toArray();

    // Also get overall totals
    const totals = await db.collection('amazon_vcs_orders')
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalExclusive: { $sum: '$totalExclusive' },
            totalTax: { $sum: '$totalTax' }
          }
        }
      ])
      .toArray();

    res.json({
      dateRange: { from, to },
      byCountryAndCurrency: summary,
      byStatus: totals
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== FBA INVENTORY UPLOAD ====================

/**
 * @route POST /api/amazon/fba/upload
 * @desc Upload and parse FBA Inventory report
 */
router.post('/fba/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const parser = new FbaInventoryReportParser();
    const result = await parser.processReport(
      req.file.buffer.toString('utf-8'),
      req.file.originalname
    );

    res.json({
      success: true,
      message: `Processed ${result.skuCount} SKUs from ${result.itemCount} inventory records`,
      ...result
    });

  } catch (error) {
    console.error('[FBA Upload] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/fba/inventory
 * @desc Get current FBA inventory
 */
router.get('/fba/inventory', async (req, res) => {
  try {
    const parser = new FbaInventoryReportParser();
    const inventory = await parser.getCurrentInventory();

    res.json({
      skuCount: inventory.length,
      inventory,
      totalFulfillable: inventory.reduce((sum, i) => sum + i.fulfillable, 0),
      totalInbound: inventory.reduce((sum, i) => sum + i.inbound, 0),
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/fba/reports
 * @desc Get list of FBA inventory reports
 */
router.get('/fba/reports', async (req, res) => {
  try {
    const db = getDb();
    const reports = await db.collection('amazon_fba_inventory_reports')
      .find({})
      .sort({ uploadedAt: -1 })
      .limit(20)
      .toArray();

    res.json({ reports });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== RETURNS UPLOAD ====================

/**
 * @route POST /api/amazon/returns/upload
 * @desc Upload and parse FBA Returns report
 */
router.post('/returns/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const parser = new ReturnsReportParser();
    const result = await parser.processReport(
      req.file.buffer.toString('utf-8'),
      req.file.originalname
    );

    res.json({
      success: true,
      message: `Processed ${result.returnCount} returns from ${result.orderCount} orders`,
      ...result
    });

  } catch (error) {
    console.error('[Returns Upload] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/returns/summary
 * @desc Get returns summary
 */
router.get('/returns/summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const parser = new ReturnsReportParser();
    const summary = await parser.getReturnSummary(days);

    res.json(summary);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/returns
 * @desc Get returns list
 */
router.get('/returns', async (req, res) => {
  try {
    const { from, to, sku, orderId } = req.query;
    const db = getDb();

    const query = {};
    if (from || to) {
      query.returnDate = {};
      if (from) query.returnDate.$gte = new Date(from);
      if (to) query.returnDate.$lte = new Date(to);
    }
    if (sku) query.sku = sku;
    if (orderId) query.orderId = orderId;

    const returns = await db.collection('amazon_returns')
      .find(query)
      .sort({ returnDate: -1 })
      .limit(500)
      .toArray();

    res.json({
      count: returns.length,
      returns
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/returns/reports
 * @desc Get list of returns reports
 */
router.get('/returns/reports', async (req, res) => {
  try {
    const db = getDb();
    const reports = await db.collection('amazon_returns_reports')
      .find({})
      .sort({ uploadedAt: -1 })
      .limit(20)
      .toArray();

    res.json({ reports });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== VCS ODOO INVOICE CREATION ====================

/**
 * @route POST /api/amazon/vcs/create-invoices
 * @desc Create Odoo invoices from selected VCS orders
 * @body { orderIds, dryRun }
 */
router.post('/vcs/create-invoices', async (req, res) => {
  try {
    const { orderIds = [], dryRun = true } = req.body;

    if (!orderIds || orderIds.length === 0) {
      return res.status(400).json({ error: 'No orders selected' });
    }

    // Check Odoo credentials - ALWAYS needed (even for preview, to find existing orders)
    if (!process.env.ODOO_URL || !process.env.ODOO_DB || !process.env.ODOO_USERNAME || !process.env.ODOO_PASSWORD) {
      return res.status(400).json({
        error: 'Odoo not configured. Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD environment variables.',
        missingEnvVars: ['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_PASSWORD'].filter(key => !process.env[key])
      });
    }

    // Initialize Odoo client - always needed to find existing orders
    const odooClient = new OdooDirectClient();
    await odooClient.authenticate();
    console.log('[VCS Invoices] Connected to Odoo');

    const invoicer = new VcsOdooInvoicer(odooClient);
    await invoicer.loadCache();

    const result = await invoicer.createInvoices({ orderIds, dryRun });

    res.json({
      success: true,
      dryRun,
      ...result
    });

  } catch (error) {
    console.error('[VCS Invoices] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/amazon/vcs/invoice-status
 * @desc Get VCS invoice creation status
 */
router.get('/vcs/invoice-status', async (req, res) => {
  try {
    const invoicer = new VcsOdooInvoicer(null);
    const status = await invoicer.getStatus();

    res.json(status);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/vcs/create-credit-notes
 * @desc Create Odoo credit notes from selected VCS return orders
 * @body { orderIds, dryRun }
 */
router.post('/vcs/create-credit-notes', async (req, res) => {
  try {
    const { orderIds = [], dryRun = true } = req.body;

    if (!orderIds || orderIds.length === 0) {
      return res.status(400).json({ error: 'No return orders selected' });
    }

    // Check Odoo credentials
    if (!process.env.ODOO_URL || !process.env.ODOO_DB || !process.env.ODOO_USERNAME || !process.env.ODOO_PASSWORD) {
      return res.status(400).json({
        error: 'Odoo not configured. Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD environment variables.',
        missingEnvVars: ['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_PASSWORD'].filter(key => !process.env[key])
      });
    }

    // Initialize Odoo client
    const odooClient = new OdooDirectClient();
    await odooClient.authenticate();
    console.log('[VCS Credit Notes] Connected to Odoo');

    const invoicer = new VcsOdooInvoicer(odooClient);
    await invoicer.loadCache();

    const result = await invoicer.createCreditNotes({ orderIds, dryRun });

    res.json({
      success: true,
      dryRun,
      ...result
    });

  } catch (error) {
    console.error('[VCS Credit Notes] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/amazon/vcs/create-orders
 * @desc Create Odoo sale orders from selected VCS orders that don't exist in Odoo
 * @body { orderIds, dryRun }
 */
router.post('/vcs/create-orders', async (req, res) => {
  try {
    const { orderIds = [], dryRun = true } = req.body;

    if (!orderIds || orderIds.length === 0) {
      return res.status(400).json({ error: 'No orders selected' });
    }

    // Check Odoo credentials
    if (!process.env.ODOO_URL || !process.env.ODOO_DB || !process.env.ODOO_USERNAME || !process.env.ODOO_PASSWORD) {
      return res.status(400).json({
        error: 'Odoo not configured. Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD environment variables.',
        missingEnvVars: ['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_PASSWORD'].filter(key => !process.env[key])
      });
    }

    // Initialize Odoo client
    const odooClient = new OdooDirectClient();
    await odooClient.authenticate();
    console.log('[VCS Create Orders] Connected to Odoo');

    const orderCreator = new VcsOrderCreator(odooClient);

    const result = await orderCreator.createOrders({ orderIds, dryRun });

    res.json({
      success: true,
      dryRun,
      ...result
    });

  } catch (error) {
    console.error('[VCS Create Orders] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
