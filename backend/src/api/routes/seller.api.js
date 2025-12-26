/**
 * Amazon Seller Central API Routes
 *
 * API endpoints for managing Seller Central operations:
 * - Order import and management
 * - Odoo order creation
 * - Polling control
 *
 * @module api/seller
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../../db');

// Lazy-load seller services to avoid initialization issues
let sellerOrderImporter = null;
let sellerOrderCreator = null;

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
      orders: orders.map(o => ({
        amazonOrderId: o.amazonOrderId,
        marketplaceId: o.marketplaceId,
        marketplaceCountry: o.marketplaceCountry,
        orderStatus: o.orderStatus,
        fulfillmentChannel: o.fulfillmentChannel,
        purchaseDate: o.purchaseDate,
        orderTotal: o.orderTotal,
        buyerName: o.buyerName,
        shippingAddress: o.shippingAddress,
        isPrime: o.isPrime,
        isBusinessOrder: o.isBusinessOrder,
        itemCount: o.items?.length || 0,
        itemsFetched: o.itemsFetched,
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
      orders: orders.map(o => ({
        amazonOrderId: o.amazonOrderId,
        marketplaceCountry: o.marketplaceCountry,
        orderStatus: o.orderStatus,
        fulfillmentChannel: o.fulfillmentChannel,
        purchaseDate: o.purchaseDate,
        orderTotal: o.orderTotal,
        itemCount: o.items?.length || 0
      }))
    });
  } catch (error) {
    console.error('[SellerAPI] GET /pending error:', error);
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
      MARKETPLACE_CONFIG,
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

module.exports = router;
