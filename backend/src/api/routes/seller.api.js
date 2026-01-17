/**
 * Amazon Seller Central API Routes
 *
 * API endpoints for managing Seller Central operations:
 * - Order import and management
 * - Odoo order creation
 * - Polling control
 * - FBM TSV import
 *
 * @module api/seller
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getDb: _getDb } = require('../../db');

// Configure multer for FBM TSV file uploads
const storage = multer.memoryStorage();
const uploadFbm = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['text/csv', 'text/tab-separated-values', 'text/plain', 'application/vnd.ms-excel'];
    if (allowedMimes.includes(file.mimetype) || file.originalname.endsWith('.txt') || file.originalname.endsWith('.tsv')) {
      cb(null, true);
    } else {
      cb(new Error('Only TSV/TXT files are allowed'));
    }
  }
});

// Lazy-load seller services to avoid initialization issues
let sellerOrderImporter = null;
let sellerOrderCreator = null;
let sellerShipmentSync = null;
let sellerTrackingPusher = null;

async function getImporter() {
  if (!sellerOrderImporter) {
    const { getSellerOrderImporter } = require('../../services/amazon/seller');
    sellerOrderImporter = await getSellerOrderImporter();
  }
  return sellerOrderImporter;
}

async function getCreator() {
  if (!sellerOrderCreator) {
    const { getSellerOrderCreator } = require('../../services/amazon/seller');
    sellerOrderCreator = await getSellerOrderCreator();
  }
  return sellerOrderCreator;
}

async function getShipmentSync() {
  if (!sellerShipmentSync) {
    const { getSellerShipmentSync } = require('../../services/amazon/seller');
    sellerShipmentSync = await getSellerShipmentSync();
  }
  return sellerShipmentSync;
}

async function getTrackingPusher() {
  if (!sellerTrackingPusher) {
    const { getSellerTrackingPusher } = require('../../services/amazon/seller');
    sellerTrackingPusher = await getSellerTrackingPusher();
  }
  return sellerTrackingPusher;
}

// ==================== ORDERS ====================

/**
 * @route GET /api/seller/orders
 * @desc Get orders with optional filters
 * @query marketplace - Filter by marketplace country (FR, DE, etc.)
 * @query status - Filter by order status
 * @query fulfillmentChannel - Filter by fulfillment channel (AFN/MFN)
 * @query hasOdooOrder - Filter by Odoo order status (true/false)
 * @query dateFrom - Filter by date from
 * @query dateTo - Filter by date to
 * @query limit - Max results (default 50)
 * @query skip - Skip N results (pagination)
 */
router.get('/orders', async (req, res) => {
  try {
    const importer = await getImporter();

    const filters = {};
    if (req.query.orderId) filters.orderId = req.query.orderId;
    if (req.query.customer) filters.customer = req.query.customer;
    if (req.query.marketplace) filters.marketplace = req.query.marketplace.toUpperCase();
    if (req.query.status) filters.status = req.query.status;
    if (req.query.fulfillmentChannel) filters.fulfillmentChannel = req.query.fulfillmentChannel;
    if (req.query.hasOdooOrder !== undefined) filters.hasOdooOrder = req.query.hasOdooOrder === 'true';
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;

    const options = {
      limit: parseInt(req.query.limit) || 50,
      skip: parseInt(req.query.skip) || 0
    };

    const [orders, total] = await Promise.all([
      importer.getOrders(filters, options),
      importer.countOrders(filters)
    ]);

    res.json({
      success: true,
      count: orders.length,
      total,
      // Map unified schema to frontend-expected format (with legacy fallbacks)
      orders: orders.map(o => ({
        amazonOrderId: o.sourceIds?.amazonOrderId || o.amazonOrderId,
        marketplaceId: o.marketplace?.code || o.marketplaceId,
        marketplaceCountry: o.marketplace?.name || o.marketplaceCountry,
        orderStatus: o.status?.source || o.orderStatus,
        fulfillmentChannel: o.amazonSeller?.fulfillmentChannel || o.subChannel || o.fulfillmentChannel,
        purchaseDate: o.orderDate || o.purchaseDate,
        // Map unified totals to legacy orderTotal format: { amount, currencyCode }
        orderTotal: o.orderTotal || (o.totals ? { amount: o.totals.total, currencyCode: o.totals.currency } : null),
        // Fallback chain: customer.name -> shippingAddress.name -> buyerName -> odoo.partnerName
        buyerName: o.customer?.name || o.shippingAddress?.name || o.buyerName || o.odoo?.partnerName,
        shippingAddress: o.shippingAddress,
        isPrime: o.amazonSeller?.isPrime ?? o.isPrime,
        isBusinessOrder: o.amazonSeller?.isBusinessOrder ?? o.isBusinessOrder,
        itemCount: o.items?.length || 0,
        itemsFetched: o.itemsFetched ?? (o.items?.length > 0),
        autoImportEligible: o.autoImportEligible,
        odoo: o.odoo
      }))
    });
  } catch (error) {
    console.error('[SellerAPI] GET /orders error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/seller/orders/:orderId
 * @desc Get a specific order with full details including items
 */
router.get('/orders/:orderId', async (req, res) => {
  try {
    const importer = await getImporter();
    const order = await importer.getOrder(req.params.orderId);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({
      success: true,
      order
    });
  } catch (error) {
    console.error('[SellerAPI] GET /orders/:orderId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/orders/poll
 * @desc Manually trigger order polling from Amazon
 * @body hoursBack - Optional: hours to look back (default 6)
 * @body marketplaceIds - Optional: specific marketplace IDs to poll
 */
router.post('/orders/poll', async (req, res) => {
  try {
    const importer = await getImporter();
    const body = req.body || {};

    const options = {
      hoursBack: body.hoursBack || 6,
      marketplaceIds: body.marketplaceIds
    };

    const result = await importer.poll(options);

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/poll error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/orders/:orderId/fetch-items
 * @desc Fetch items for a specific order from Amazon
 */
router.post('/orders/:orderId/fetch-items', async (req, res) => {
  try {
    const importer = await getImporter();
    const items = await importer.fetchOrderItems(req.params.orderId);

    res.json({
      success: true,
      orderId: req.params.orderId,
      itemCount: items.length,
      items
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/:orderId/fetch-items error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/orders/:orderId/create-odoo
 * @desc Create an Odoo sale order from an Amazon order
 * @body confirm - Optional: auto-confirm the order (default true)
 * @body dryRun - Optional: simulate without creating (default false)
 */
router.post('/orders/:orderId/create-odoo', async (req, res) => {
  try {
    const creator = await getCreator();

    const result = await creator.createOrder(req.params.orderId, {
      dryRun: req.body.dryRun || false,
      autoConfirm: req.body.confirm !== false // Default to true
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        errors: result.errors
      });
    }

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/:orderId/create-odoo error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/orders/create-pending
 * @desc Create Odoo orders for all pending eligible orders
 * @body limit - Optional: max orders to process (default 50)
 * @body dryRun - Optional: simulate without creating (default false)
 */
router.post('/orders/create-pending', async (req, res) => {
  try {
    const creator = await getCreator();

    const results = await creator.createPendingOrders({
      limit: req.body.limit || 50,
      dryRun: req.body.dryRun || false
    });

    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/create-pending error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/orders/create-fba
 * @desc Create Odoo orders for FBA orders only (uses generic customers)
 *
 * DEPRECATED: FBA orders should only be created when VCS file is uploaded.
 * This endpoint is kept for backward compatibility but will show a deprecation warning.
 * Use POST /api/amazon-vcs/upload to create FBA orders with correct tax data.
 *
 * @body limit - Optional: max orders to process (default 100)
 * @body dryRun - Optional: simulate without creating (default false)
 * @body force - Optional: set to true to bypass deprecation warning (default false)
 */
router.post('/orders/create-fba', async (req, res) => {
  try {
    // Deprecation warning
    if (!req.body.force) {
      console.warn('[SellerAPI] DEPRECATION WARNING: /orders/create-fba is deprecated. FBA orders should be created via VCS upload.');
      return res.status(400).json({
        success: false,
        error: 'DEPRECATED: FBA orders should only be created when VCS file is uploaded. This ensures correct tax rates and VAT numbers.',
        message: 'Use POST /api/amazon-vcs/upload to create FBA orders with correct tax data from Amazon.',
        hint: 'If you need to force creation anyway, add { "force": true } to the request body.',
        deprecatedSince: '2025-01-09'
      });
    }

    console.warn('[SellerAPI] DEPRECATION: Creating FBA orders directly (forced). This may result in incorrect tax data.');

    const creator = await getCreator();

    const results = await creator.createFbaOrders({
      limit: req.body.limit || 100,
      dryRun: req.body.dryRun || false
    });

    res.json({
      success: true,
      warning: 'DEPRECATED: This endpoint creates FBA orders without VCS tax data. Tax rates may be incorrect.',
      ...results
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/create-fba error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== FBM TSV IMPORT (Two-Step Flow) ====================

/**
 * @route POST /api/seller/orders/import-fbm
 * @desc Import FBM orders from Amazon "Unshipped Orders" TSV file
 *
 * TWO-STEP FLOW:
 * 1. Parse TSV and store to unified_orders (with AI address cleaning)
 * 2. Create Odoo orders with correct fiscal position and journal
 *
 * @body file - TSV file with customer names and addresses
 * @body createOdoo - Optional: create Odoo orders immediately (default true)
 */
router.post('/orders/import-fbm', uploadFbm.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { getFbmOrderImporter } = require('../../services/amazon/seller/FbmOrderImporter');
    const { getSellerOrderCreator } = require('../../services/amazon/seller/SellerOrderCreator');

    const importer = await getFbmOrderImporter();
    const tsvContent = req.file.buffer.toString('utf-8');
    const fileName = req.file.originalname;

    // Step 1: Parse TSV → unified_orders
    console.log(`[SellerAPI] Step 1: Importing TSV to unified_orders...`);
    const importResult = await importer.importToUnifiedOrders(tsvContent, { fileName });

    // Step 2: Create Odoo orders (unless explicitly disabled)
    const shouldCreateOdoo = req.body.createOdoo !== false && req.body.createOdoo !== 'false';
    let odooResult = null;

    if (shouldCreateOdoo && importResult.orderIds.length > 0) {
      console.log(`[SellerAPI] Step 2: Creating Odoo orders for ${importResult.orderIds.length} orders...`);
      const creator = await getSellerOrderCreator();
      odooResult = await creator.createOrdersFromUnified(importResult.orderIds, {
        autoConfirm: true
      });
    }

    res.json({
      success: true,
      filename: fileName,
      // Step 1 results
      import: {
        parsed: importResult.parsed,
        imported: importResult.imported,
        updated: importResult.updated,
        errors: importResult.errors
      },
      // Step 2 results (if executed)
      odoo: odooResult ? {
        processed: odooResult.processed,
        created: odooResult.created,
        skipped: odooResult.skipped,
        errors: odooResult.errors,
        orders: odooResult.orders
      } : null,
      // Summary
      summary: {
        totalParsed: importResult.parsed,
        storedToDb: importResult.imported + importResult.updated,
        odooCreated: odooResult?.created || 0,
        odooSkipped: odooResult?.skipped || 0,
        totalErrors: importResult.errors.length + (odooResult?.errors.length || 0)
      }
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/import-fbm error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/orders/import-fbm-stream
 * @desc Import FBM orders with Server-Sent Events for real-time progress
 *
 * Streams progress events:
 * - { type: 'parsing', count: N } - Parsing TSV
 * - { type: 'progress', step: 'partner', orderId, customer } - Creating partner
 * - { type: 'progress', step: 'order', orderId } - Creating order
 * - { type: 'result', orderId, status, odooName, error } - Order result
 * - { type: 'complete', summary: {...} } - Final summary
 */
router.post('/orders/import-fbm-stream', uploadFbm.single('file'), async (req, res) => {
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    if (!req.file) {
      sendEvent({ type: 'error', error: 'No file uploaded' });
      res.end();
      return;
    }

    const { getFbmOrderImporter } = require('../../services/amazon/seller/FbmOrderImporter');
    const { getSellerOrderCreator } = require('../../services/amazon/seller/SellerOrderCreator');

    const importer = await getFbmOrderImporter();
    const creator = await getSellerOrderCreator();
    const tsvContent = req.file.buffer.toString('utf-8');
    const fileName = req.file.originalname;

    // Step 1: Parse TSV
    sendEvent({ type: 'status', message: 'Parsing TSV file...' });
    const orderGroups = importer.parseTsv(tsvContent);
    const orderIds = Object.keys(orderGroups);
    sendEvent({ type: 'parsing', count: orderIds.length, message: `Found ${orderIds.length} orders in TSV` });

    // Step 2: Import to unified_orders
    sendEvent({ type: 'status', message: 'Storing orders to database...' });
    const importResult = await importer.importToUnifiedOrders(tsvContent, { fileName });
    sendEvent({
      type: 'imported',
      count: importResult.imported + importResult.updated,
      message: `Stored ${importResult.imported} new, ${importResult.updated} updated`
    });

    // Step 3: Create Odoo orders with progress tracking
    const results = {
      created: 0,
      skipped: 0,
      errors: [],
      orders: []
    };

    if (importResult.orderIds.length > 0) {
      sendEvent({ type: 'status', message: 'Creating orders in Odoo...', total: importResult.orderIds.length });

      for (let i = 0; i < importResult.orderIds.length; i++) {
        const amazonOrderId = importResult.orderIds[i];
        const orderData = orderGroups[amazonOrderId];
        const progress = Math.round(((i + 1) / importResult.orderIds.length) * 100);

        sendEvent({
          type: 'progress',
          step: 'processing',
          orderId: amazonOrderId,
          customer: orderData?.recipientName || 'Unknown',
          city: orderData?.city || '',
          current: i + 1,
          total: importResult.orderIds.length,
          percent: progress
        });

        try {
          // Create single order
          const orderResult = await creator.createOrdersFromUnified([amazonOrderId], { autoConfirm: true });

          if (orderResult.orders && orderResult.orders.length > 0) {
            const order = orderResult.orders[0];

            sendEvent({
              type: 'result',
              orderId: amazonOrderId,
              status: order.status,
              odooName: order.odooOrderName || null,
              reason: order.reason || order.error || null,
              customer: orderData?.recipientName || 'Unknown',
              city: orderData?.city || '',
              country: orderData?.country || ''
            });

            results.orders.push({
              orderId: amazonOrderId,
              status: order.status,
              odooName: order.odooOrderName,
              customer: orderData?.recipientName,
              address: {
                street: orderData?.address1,
                postalCode: orderData?.postalCode,
                city: orderData?.city,
                country: orderData?.country
              },
              reason: order.reason,
              error: order.error
            });

            if (order.status === 'created') results.created++;
            else if (order.status === 'skipped') results.skipped++;
            else if (order.status === 'error') results.errors.push({ orderId: amazonOrderId, error: order.error });
          }
        } catch (orderError) {
          sendEvent({
            type: 'result',
            orderId: amazonOrderId,
            status: 'error',
            error: orderError.message,
            customer: orderData?.recipientName || 'Unknown'
          });
          results.errors.push({ orderId: amazonOrderId, error: orderError.message });
          results.orders.push({
            orderId: amazonOrderId,
            status: 'error',
            error: orderError.message,
            customer: orderData?.recipientName
          });
        }
      }
    }

    // Final summary
    sendEvent({
      type: 'complete',
      success: true,
      parsed: importResult.parsed,
      created: results.created,
      skipped: results.skipped,
      errors: results.errors.length,
      orders: results.orders
    });

    res.end();

  } catch (error) {
    console.error('[SellerAPI] POST /orders/import-fbm-stream error:', error);
    sendEvent({ type: 'error', error: error.message });
    res.end();
  }
});

/**
 * @route POST /api/seller/orders/import-fbm-unified
 * @desc Step 1 only: Parse TSV and store to unified_orders without creating Odoo orders
 * Useful when you want to review data before creating Odoo orders
 *
 * @body file - TSV file
 */
router.post('/orders/import-fbm-unified', uploadFbm.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { getFbmOrderImporter } = require('../../services/amazon/seller/FbmOrderImporter');
    const importer = await getFbmOrderImporter();

    const tsvContent = req.file.buffer.toString('utf-8');
    const fileName = req.file.originalname;

    const result = await importer.importToUnifiedOrders(tsvContent, { fileName });

    res.json({
      success: true,
      filename: fileName,
      ...result,
      message: `${result.imported} new orders imported, ${result.updated} updated. Use /orders/create-fbm-from-unified to create Odoo orders.`
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/import-fbm-unified error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/orders/create-fbm-from-unified
 * @desc Step 2: Create Odoo orders from unified_orders that were imported via TSV
 *
 * @body orderIds - Optional: specific order IDs to create (default: all pending)
 * @body limit - Optional: max orders to process (default 100)
 */
router.post('/orders/create-fbm-from-unified', async (req, res) => {
  try {
    const { getSellerOrderCreator } = require('../../services/amazon/seller/SellerOrderCreator');
    const { getFbmOrderImporter } = require('../../services/amazon/seller/FbmOrderImporter');

    const creator = await getSellerOrderCreator();

    let orderIds = req.body.orderIds;

    // If no specific orderIds provided, get all pending FBM orders from unified_orders
    if (!orderIds || orderIds.length === 0) {
      const importer = await getFbmOrderImporter();
      const pendingOrders = await importer.getOrdersPendingOdooCreation();
      orderIds = pendingOrders.map(o => o.sourceIds.amazonOrderId);

      if (req.body.limit) {
        orderIds = orderIds.slice(0, parseInt(req.body.limit));
      }
    }

    if (orderIds.length === 0) {
      return res.json({
        success: true,
        message: 'No pending FBM orders found',
        processed: 0,
        created: 0,
        skipped: 0
      });
    }

    const result = await creator.createOrdersFromUnified(orderIds, {
      autoConfirm: true
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/create-fbm-from-unified error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/seller/orders/fbm-pending-odoo
 * @desc Get FBM orders that are in unified_orders but not yet created in Odoo
 */
router.get('/orders/fbm-pending-odoo', async (req, res) => {
  try {
    const { getFbmOrderImporter } = require('../../services/amazon/seller/FbmOrderImporter');
    const importer = await getFbmOrderImporter();

    const pendingOrders = await importer.getOrdersPendingOdooCreation();

    res.json({
      success: true,
      count: pendingOrders.length,
      orders: pendingOrders.map(o => ({
        amazonOrderId: o.sourceIds?.amazonOrderId,
        customer: o.customer?.name || o.shippingAddress?.name,
        country: o.shippingAddress?.countryCode,
        isBusinessOrder: o.isBusinessOrder,
        itemCount: o.items?.length || 0,
        total: o.totals?.total,
        importedAt: o.tsvImport?.importedAt,
        fileName: o.tsvImport?.fileName
      }))
    });
  } catch (error) {
    console.error('[SellerAPI] GET /orders/fbm-pending-odoo error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/orders/preview-fbm
 * @desc Preview FBM orders from TSV without importing
 * @body file - TSV file
 */
router.post('/orders/preview-fbm', uploadFbm.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { FbmOrderImporter } = require('../../services/amazon/seller/FbmOrderImporter');
    const importer = new FbmOrderImporter();

    const tsvContent = req.file.buffer.toString('utf-8');
    const orders = importer.parseTsv(tsvContent);
    const orderList = Object.values(orders);

    res.json({
      success: true,
      filename: req.file.originalname,
      count: orderList.length,
      orders: orderList.map(o => ({
        orderId: o.orderId,
        customer: o.recipientName,
        buyerCompanyName: o.buyerCompanyName,
        isBusinessOrder: o.isBusinessOrder,
        city: o.city,
        country: o.country,
        salesChannel: o.salesChannel,
        itemCount: o.items.length,
        items: o.items.map(i => ({
          sku: i.sku,
          resolvedSku: i.resolvedSku,
          quantity: i.quantity,
          price: i.itemPrice,
          isPromotion: i.isPromotion
        }))
      }))
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/preview-fbm error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== HISTORICAL IMPORT ====================

/**
 * @route POST /api/seller/orders/import-historical
 * @desc Import historical orders from Amazon (one-time)
 * @body fromDate - Start date (default: 2024-01-01)
 * @body toDate - End date (default: now)
 */
router.post('/orders/import-historical', async (req, res) => {
  try {
    const importer = await getImporter();

    const fromDate = req.body.fromDate
      ? new Date(req.body.fromDate)
      : new Date('2024-01-01');

    const toDate = req.body.toDate
      ? new Date(req.body.toDate)
      : new Date();

    const result = await importer.importHistorical(fromDate, toDate);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/import-historical error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== STATUS & STATS ====================

/**
 * @route GET /api/seller/status
 * @desc Get importer status and scheduler info
 */
router.get('/status', async (req, res) => {
  try {
    const importer = await getImporter();
    const status = importer.getStatus();

    // Try to get scheduler status
    let schedulerStatus = null;
    try {
      const { getSellerOrderScheduler } = require('../../services/amazon/seller');
      const scheduler = getSellerOrderScheduler();
      schedulerStatus = scheduler?.getStatus?.() || null;
    } catch (e) {
      // Scheduler may not be initialized yet
    }

    res.json({
      success: true,
      importer: status,
      scheduler: schedulerStatus
    });
  } catch (error) {
    console.error('[SellerAPI] GET /status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/seller/stats
 * @desc Get order statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const importer = await getImporter();
    const stats = await importer.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[SellerAPI] GET /stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/seller/pending
 * @desc Get orders pending Odoo creation
 */
router.get('/pending', async (req, res) => {
  try {
    const importer = await getImporter();
    const limit = parseInt(req.query.limit) || 50;
    const orders = await importer.getPendingOdooOrders(limit);

    res.json({
      success: true,
      count: orders.length,
      // Map unified schema to frontend-expected format (with legacy fallbacks)
      orders: orders.map(o => ({
        amazonOrderId: o.sourceIds?.amazonOrderId || o.amazonOrderId,
        marketplaceCountry: o.marketplace?.name || o.marketplaceCountry,
        orderStatus: o.status?.source || o.orderStatus,
        fulfillmentChannel: o.amazonSeller?.fulfillmentChannel || o.subChannel || o.fulfillmentChannel,
        purchaseDate: o.orderDate || o.purchaseDate,
        orderTotal: o.orderTotal || (o.totals ? { amount: o.totals.total, currencyCode: o.totals.currency } : null),
        itemCount: o.items?.length || 0
      }))
    });
  } catch (error) {
    console.error('[SellerAPI] GET /pending error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/seller/fbm-pending-import
 * @desc Get count of FBM orders that need manual TSV import (no address available)
 */
router.get('/fbm-pending-import', async (req, res) => {
  try {
    const importer = await getImporter();
    const result = await importer.countFbmOrdersPendingManualImport();

    res.json({
      success: true,
      count: result.count,
      orderIds: result.orderIds,
      message: result.count > 0
        ? `${result.count} FBM order(s) need manual TSV import - Amazon PII permissions not available`
        : 'No FBM orders pending manual import'
    });
  } catch (error) {
    console.error('[SellerAPI] GET /fbm-pending-import error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== CONFIGURATION ====================

/**
 * @route GET /api/seller/config
 * @desc Get seller configuration (marketplaces, etc.)
 */
router.get('/config', async (req, res) => {
  try {
    const {
      MARKETPLACE_IDS,
      MARKETPLACE_CONFIG: _MARKETPLACE_CONFIG,
      getAllMarketplaces
    } = require('../../services/amazon/seller/SellerMarketplaceConfig');

    // Check if token is configured
    const hasToken = !!process.env.AMAZON_SELLER_REFRESH_TOKEN;
    const hasLwaCredentials = !!(
      process.env.AMAZON_SP_LWA_CLIENT_ID &&
      process.env.AMAZON_SP_LWA_CLIENT_SECRET
    );

    res.json({
      success: true,
      config: {
        marketplaceIds: MARKETPLACE_IDS,
        marketplaces: getAllMarketplaces(),
        hasToken,
        hasLwaCredentials,
        configured: hasToken && hasLwaCredentials
      }
    });
  } catch (error) {
    console.error('[SellerAPI] GET /config error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/test-connection
 * @desc Test SP-API connection
 */
router.post('/test-connection', async (req, res) => {
  try {
    const { getSellerClient } = require('../../services/amazon/seller/SellerClient');
    const client = getSellerClient();
    await client.init();

    const result = await client.testConnection();

    res.json({
      success: result.success,
      message: result.message,
      ordersFound: result.ordersFound
    });
  } catch (error) {
    console.error('[SellerAPI] POST /test-connection error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== SCHEDULER CONTROL ====================

/**
 * @route POST /api/seller/scheduler/start
 * @desc Start the order polling scheduler
 */
router.post('/scheduler/start', async (req, res) => {
  try {
    const { getSellerOrderScheduler } = require('../../services/amazon/seller');
    const scheduler = getSellerOrderScheduler();
    scheduler.start();

    res.json({
      success: true,
      message: 'Scheduler started',
      status: scheduler.getStatus()
    });
  } catch (error) {
    console.error('[SellerAPI] POST /scheduler/start error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/scheduler/stop
 * @desc Stop the order polling scheduler
 */
router.post('/scheduler/stop', async (req, res) => {
  try {
    const { getSellerOrderScheduler } = require('../../services/amazon/seller');
    const scheduler = getSellerOrderScheduler();
    scheduler.stop();

    res.json({
      success: true,
      message: 'Scheduler stopped',
      status: scheduler.getStatus()
    });
  } catch (error) {
    console.error('[SellerAPI] POST /scheduler/stop error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SHIPMENT SYNC (FBA: Amazon → Odoo) ====================

/**
 * @route POST /api/seller/shipments/sync-fba
 * @desc Sync FBA shipments from Amazon to Odoo (validate pickings)
 */
router.post('/shipments/sync-fba', async (req, res) => {
  try {
    const shipmentSync = await getShipmentSync();
    const result = await shipmentSync.syncFbaShipments();

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[SellerAPI] POST /shipments/sync-fba error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/seller/shipments/fba-stats
 * @desc Get FBA shipment sync statistics
 */
router.get('/shipments/fba-stats', async (req, res) => {
  try {
    const shipmentSync = await getShipmentSync();
    const stats = await shipmentSync.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[SellerAPI] GET /shipments/fba-stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== TRACKING PUSH (FBM: Odoo → Amazon) ====================

/**
 * @route POST /api/seller/tracking/push-fbm
 * @desc Push FBM tracking from Odoo to Amazon
 */
router.post('/tracking/push-fbm', async (req, res) => {
  try {
    const trackingPusher = await getTrackingPusher();
    const result = await trackingPusher.pushPendingTracking();

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[SellerAPI] POST /tracking/push-fbm error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/seller/tracking/fbm-stats
 * @desc Get FBM tracking push statistics
 */
router.get('/tracking/fbm-stats', async (req, res) => {
  try {
    const trackingPusher = await getTrackingPusher();
    const stats = await trackingPusher.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[SellerAPI] GET /tracking/fbm-stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/orders/:orderId/push-tracking
 * @desc Push tracking for a specific FBM order
 */
router.post('/orders/:orderId/push-tracking', async (req, res) => {
  try {
    const importer = await getImporter();
    const order = await importer.getOrder(req.params.orderId);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (order.fulfillmentChannel !== 'MFN') {
      return res.status(400).json({
        success: false,
        error: 'Only FBM (MFN) orders support tracking push'
      });
    }

    const trackingPusher = await getTrackingPusher();
    const result = await trackingPusher.pushOrderTracking(order);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/:orderId/push-tracking error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/seller/orders/:orderId/sync-shipment
 * @desc Sync shipment for a specific FBA order
 */
router.post('/orders/:orderId/sync-shipment', async (req, res) => {
  try {
    const importer = await getImporter();
    const order = await importer.getOrder(req.params.orderId);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (order.fulfillmentChannel !== 'AFN') {
      return res.status(400).json({
        success: false,
        error: 'Only FBA (AFN) orders support shipment sync'
      });
    }

    const shipmentSync = await getShipmentSync();
    const result = await shipmentSync.syncOrderShipment(order);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[SellerAPI] POST /orders/:orderId/sync-shipment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== FBM STOCK REPORT DOWNLOAD ====================

/**
 * GET /api/seller/fbm-report/:filename
 * Download FBM stock update report files
 * Files are stored temporarily on server for Teams notification download
 */
router.get('/fbm-report/:filename', (req, res) => {
  const fs = require('fs');
  const path = require('path');

  try {
    const filename = req.params.filename;

    // Security: Only allow specific file extensions and no path traversal
    if (!filename.match(/^FBM_Stock_(Update|Fallback)_[\d\-T]+\.(xlsx|tsv)$/)) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }

    const reportsDir = path.join(__dirname, '..', '..', 'tmp', 'fbm-reports');
    const filePath = path.join(reportsDir, filename);

    // Check file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    // Set headers for download
    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === '.xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/tab-separated-values';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Stream file to response
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

  } catch (error) {
    console.error('[SellerAPI] GET /fbm-report/:filename error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
