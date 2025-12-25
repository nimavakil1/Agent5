/**
 * Amazon Vendor Central API Routes
 *
 * API endpoints for managing Vendor Central operations:
 * - Purchase Order import and management
 * - PO Acknowledgment
 * - Invoice submission
 * - Shipment/ASN creation
 *
 * @module api/vendor
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../../db');
const {
  VendorClient,
  getVendorPOImporter,
  MARKETPLACE_IDS,
  VENDOR_ACCOUNTS,
  PO_STATES
} = require('../../services/amazon/vendor');

// ==================== PURCHASE ORDERS ====================

/**
 * @route GET /api/vendor/orders
 * @desc Get purchase orders with optional filters
 * @query marketplace - Filter by marketplace (FR, DE, etc.)
 * @query state - Filter by PO state (New, Acknowledged, Closed)
 * @query acknowledged - Filter by acknowledgment status (true/false)
 * @query hasOdooOrder - Filter by Odoo order status (true/false)
 * @query dateFrom - Filter by date from
 * @query dateTo - Filter by date to
 * @query limit - Max results (default 50)
 * @query skip - Skip N results (pagination)
 */
router.get('/orders', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();

    const filters = {};
    if (req.query.marketplace) filters.marketplace = req.query.marketplace.toUpperCase();
    if (req.query.state) filters.state = req.query.state;
    if (req.query.acknowledged !== undefined) filters.acknowledged = req.query.acknowledged === 'true';
    if (req.query.hasOdooOrder !== undefined) filters.hasOdooOrder = req.query.hasOdooOrder === 'true';
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;

    const options = {
      limit: parseInt(req.query.limit) || 50,
      skip: parseInt(req.query.skip) || 0
    };

    const orders = await importer.getPurchaseOrders(filters, options);

    res.json({
      success: true,
      count: orders.length,
      orders: orders.map(o => ({
        purchaseOrderNumber: o.purchaseOrderNumber,
        marketplaceId: o.marketplaceId,
        purchaseOrderState: o.purchaseOrderState,
        purchaseOrderType: o.purchaseOrderType,
        purchaseOrderDate: o.purchaseOrderDate,
        deliveryWindow: o.deliveryWindow,
        totals: o.totals,
        acknowledgment: o.acknowledgment,
        odoo: o.odoo,
        itemCount: o.items?.length || 0
      }))
    });
  } catch (error) {
    console.error('[VendorAPI] GET /orders error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/orders/:poNumber
 * @desc Get a specific purchase order with full details
 */
router.get('/orders/:poNumber', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const order = await importer.getPurchaseOrder(req.params.poNumber);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Purchase order not found' });
    }

    res.json({
      success: true,
      order
    });
  } catch (error) {
    console.error('[VendorAPI] GET /orders/:poNumber error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/poll
 * @desc Manually trigger PO polling from Amazon
 * @body marketplace - Optional: specific marketplace to poll
 * @body daysBack - Optional: days to look back (default 7)
 * @body state - Optional: PO state filter
 */
router.post('/orders/poll', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();

    const options = {
      daysBack: req.body.daysBack || 7,
      state: req.body.state
    };

    let result;
    if (req.body.marketplace) {
      result = await importer.pollMarketplace(req.body.marketplace.toUpperCase(), options);
    } else {
      result = await importer.pollAllMarketplaces(options);
    }

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/poll error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/:poNumber/acknowledge
 * @desc Send acknowledgment to Amazon for a PO
 * @body status - Acknowledgment status: Accepted, Rejected, Backordered
 * @body items - Optional: item-level acknowledgments
 */
router.post('/orders/:poNumber/acknowledge', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const order = await importer.getPurchaseOrder(req.params.poNumber);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Purchase order not found' });
    }

    if (order.acknowledgment?.acknowledged) {
      return res.status(400).json({
        success: false,
        error: 'Order already acknowledged',
        acknowledgedAt: order.acknowledgment.acknowledgedAt
      });
    }

    // Create vendor client for the marketplace
    const client = new VendorClient(order.marketplaceId);

    // Build acknowledgment
    const acknowledgementCode = req.body.status || 'Accepted';
    const acknowledgement = client.buildAcknowledgement(
      order.purchaseOrderNumber,
      acknowledgementCode,
      req.body.items || order.items
    );

    // Submit to Amazon
    const response = await client.submitAcknowledgement(acknowledgement);

    // Update local record
    await importer.markAcknowledged(order.purchaseOrderNumber, acknowledgementCode);

    res.json({
      success: true,
      message: 'Purchase order acknowledged',
      purchaseOrderNumber: order.purchaseOrderNumber,
      status: acknowledgementCode,
      amazonResponse: response
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/:poNumber/acknowledge error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/:poNumber/create-odoo
 * @desc Create an Odoo sale order from a vendor PO
 * @body confirm - Optional: auto-confirm the order (default false)
 */
router.post('/orders/:poNumber/create-odoo', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const order = await importer.getPurchaseOrder(req.params.poNumber);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Purchase order not found' });
    }

    if (order.odoo?.saleOrderId) {
      return res.status(400).json({
        success: false,
        error: 'Odoo order already exists',
        odooOrderId: order.odoo.saleOrderId,
        odooOrderName: order.odoo.saleOrderName
      });
    }

    // TODO: Implement VendorOrderCreator
    // For now, return a placeholder response
    res.status(501).json({
      success: false,
      error: 'VendorOrderCreator not yet implemented',
      message: 'This feature will create Odoo sale.order from Vendor PO'
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/:poNumber/create-odoo error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== INVOICES ====================

/**
 * @route GET /api/vendor/invoices
 * @desc Get vendor invoices
 */
router.get('/invoices', async (req, res) => {
  try {
    const db = getDb();
    const collection = db.collection('vendor_invoices');

    const query = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.marketplace) query.marketplaceId = req.query.marketplace.toUpperCase();

    const invoices = await collection.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(req.query.limit) || 50)
      .toArray();

    res.json({
      success: true,
      count: invoices.length,
      invoices
    });
  } catch (error) {
    console.error('[VendorAPI] GET /invoices error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/invoices/:poNumber/submit
 * @desc Submit invoice to Amazon for a PO
 */
router.post('/invoices/:poNumber/submit', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const order = await importer.getPurchaseOrder(req.params.poNumber);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Purchase order not found' });
    }

    // TODO: Implement VendorInvoiceSubmitter
    res.status(501).json({
      success: false,
      error: 'VendorInvoiceSubmitter not yet implemented',
      message: 'This feature will submit invoices to Amazon'
    });
  } catch (error) {
    console.error('[VendorAPI] POST /invoices/:poNumber/submit error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SHIPMENTS ====================

/**
 * @route GET /api/vendor/shipments
 * @desc Get vendor shipments/ASNs
 */
router.get('/shipments', async (req, res) => {
  try {
    const db = getDb();
    const collection = db.collection('vendor_shipments');

    const query = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.marketplace) query.marketplaceId = req.query.marketplace.toUpperCase();

    const shipments = await collection.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(req.query.limit) || 50)
      .toArray();

    res.json({
      success: true,
      count: shipments.length,
      shipments
    });
  } catch (error) {
    console.error('[VendorAPI] GET /shipments error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/shipments/:poNumber/create-asn
 * @desc Create ASN/shipment confirmation for a PO
 */
router.post('/shipments/:poNumber/create-asn', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const order = await importer.getPurchaseOrder(req.params.poNumber);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Purchase order not found' });
    }

    // TODO: Implement VendorASNCreator
    res.status(501).json({
      success: false,
      error: 'VendorASNCreator not yet implemented',
      message: 'This feature will create ASN/shipment confirmations'
    });
  } catch (error) {
    console.error('[VendorAPI] POST /shipments/:poNumber/create-asn error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== STATS & DASHBOARD ====================

/**
 * @route GET /api/vendor/stats
 * @desc Get vendor central statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const stats = await importer.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[VendorAPI] GET /stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/pending
 * @desc Get pending items that need action
 */
router.get('/pending', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();

    const [pendingAck, pendingOdoo, readyInvoice] = await Promise.all([
      importer.getPendingAcknowledgment(10),
      importer.getPendingOdooOrders(10),
      importer.getReadyForInvoicing(10)
    ]);

    res.json({
      success: true,
      pending: {
        acknowledgment: {
          count: pendingAck.length,
          orders: pendingAck.map(o => ({
            purchaseOrderNumber: o.purchaseOrderNumber,
            marketplaceId: o.marketplaceId,
            purchaseOrderDate: o.purchaseOrderDate,
            totals: o.totals
          }))
        },
        odooOrders: {
          count: pendingOdoo.length,
          orders: pendingOdoo.map(o => ({
            purchaseOrderNumber: o.purchaseOrderNumber,
            marketplaceId: o.marketplaceId,
            purchaseOrderDate: o.purchaseOrderDate,
            totals: o.totals
          }))
        },
        invoicing: {
          count: readyInvoice.length,
          orders: readyInvoice.map(o => ({
            purchaseOrderNumber: o.purchaseOrderNumber,
            marketplaceId: o.marketplaceId,
            odoo: o.odoo,
            totals: o.totals
          }))
        }
      }
    });
  } catch (error) {
    console.error('[VendorAPI] GET /pending error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/config
 * @desc Get vendor configuration (marketplaces, accounts)
 */
router.get('/config', async (req, res) => {
  try {
    // Check which tokens are configured
    const configuredMarketplaces = [];
    const tokenStatus = {};

    for (const [marketplace, envVar] of Object.entries(require('../../services/amazon/vendor').VENDOR_TOKEN_MAP)) {
      if (marketplace === 'DE_FR') continue;

      const hasToken = !!process.env[envVar];
      tokenStatus[marketplace] = hasToken;
      if (hasToken) {
        configuredMarketplaces.push(marketplace);
      }
    }

    res.json({
      success: true,
      config: {
        marketplaces: MARKETPLACE_IDS,
        accounts: VENDOR_ACCOUNTS,
        configuredMarketplaces,
        tokenStatus
      }
    });
  } catch (error) {
    console.error('[VendorAPI] GET /config error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/test-connection
 * @desc Test SP-API connection for a marketplace
 * @body marketplace - Marketplace to test (FR, DE, etc.)
 */
router.post('/test-connection', async (req, res) => {
  try {
    const marketplace = (req.body.marketplace || 'DE').toUpperCase();

    const client = new VendorClient(marketplace);

    // Try to fetch recent POs as a connection test
    const result = await client.getPurchaseOrders({
      createdAfter: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      limit: 1
    });

    res.json({
      success: true,
      marketplace,
      message: 'Connection successful',
      ordersFound: result.orders?.length || 0
    });
  } catch (error) {
    console.error('[VendorAPI] POST /test-connection error:', error);
    res.status(500).json({
      success: false,
      marketplace: req.body.marketplace,
      error: error.message
    });
  }
});

module.exports = router;
