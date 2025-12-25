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
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const {
  VendorClient,
  getVendorPOImporter,
  getVendorOrderCreator,
  getVendorPOAcknowledger,
  getVendorInvoiceSubmitter,
  MARKETPLACE_IDS,
  VENDOR_ACCOUNTS,
  PO_STATES,
  ACK_CODES,
  MARKETPLACE_WAREHOUSE
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

    // Get orders and total count in parallel
    const [orders, total] = await Promise.all([
      importer.getPurchaseOrders(filters, options),
      importer.countPurchaseOrders(filters)
    ]);

    res.json({
      success: true,
      count: orders.length,
      total,
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
    const body = req.body || {};

    const options = {
      daysBack: body.daysBack || 7,
      state: body.state
    };

    let result;
    if (body.marketplace) {
      result = await importer.pollMarketplace(body.marketplace.toUpperCase(), options);
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
 * @body dryRun - Optional: simulate without sending (default false)
 */
router.post('/orders/:poNumber/acknowledge', async (req, res) => {
  try {
    const acknowledger = await getVendorPOAcknowledger();

    const result = await acknowledger.acknowledgePO(req.params.poNumber, {
      status: req.body.status || ACK_CODES.ACCEPTED,
      dryRun: req.body.dryRun || false
    });

    if (!result.success && result.errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: result.errors,
        warnings: result.warnings
      });
    }

    res.json({
      success: true,
      acknowledged: !result.skipped && !result.dryRun,
      skipped: result.skipped,
      skipReason: result.skipReason,
      dryRun: result.dryRun || false,
      purchaseOrderNumber: result.purchaseOrderNumber,
      status: result.status,
      transactionId: result.transactionId,
      warnings: result.warnings,
      ...(result.payload && { payload: result.payload })
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/:poNumber/acknowledge error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/acknowledge-pending
 * @desc Acknowledge all pending POs (those not yet acknowledged)
 * @body limit - Optional: max POs to process (default 50)
 * @body status - Optional: acknowledgment status (default Accepted)
 * @body dryRun - Optional: simulate without sending (default false)
 */
router.post('/orders/acknowledge-pending', async (req, res) => {
  try {
    const acknowledger = await getVendorPOAcknowledger();

    const results = await acknowledger.acknowledgePendingPOs({
      limit: req.body.limit || 50,
      status: req.body.status || ACK_CODES.ACCEPTED,
      dryRun: req.body.dryRun || false
    });

    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/acknowledge-pending error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/:poNumber/create-odoo
 * @desc Create an Odoo sale order from a vendor PO
 * @body confirm - Optional: auto-confirm the order (default false)
 * @body dryRun - Optional: simulate without creating (default false)
 *
 * IMPORTANT: This endpoint checks if the order already exists in Odoo before creating.
 * If it exists, it returns the existing order info without creating a duplicate.
 */
router.post('/orders/:poNumber/create-odoo', async (req, res) => {
  try {
    const creator = await getVendorOrderCreator();

    const result = await creator.createOrder(req.params.poNumber, {
      dryRun: req.body.dryRun || false,
      autoConfirm: req.body.confirm || false
    });

    if (!result.success && result.errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: result.errors,
        warnings: result.warnings
      });
    }

    res.json({
      success: true,
      created: !result.skipped && !result.dryRun,
      skipped: result.skipped,
      skipReason: result.skipReason,
      dryRun: result.dryRun || false,
      purchaseOrderNumber: result.purchaseOrderNumber,
      odooOrderId: result.odooOrderId,
      odooOrderName: result.odooOrderName,
      confirmed: result.confirmed || false,
      warnings: result.warnings,
      ...(result.orderData && { orderData: result.orderData })
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/:poNumber/create-odoo error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/create-pending
 * @desc Create Odoo orders for all pending POs (those without Odoo orders)
 * @body limit - Optional: max POs to process (default 50)
 * @body confirm - Optional: auto-confirm orders (default false)
 * @body dryRun - Optional: simulate without creating (default false)
 */
router.post('/orders/create-pending', async (req, res) => {
  try {
    const creator = await getVendorOrderCreator();

    const results = await creator.createPendingOrders({
      limit: req.body.limit || 50,
      dryRun: req.body.dryRun || false,
      autoConfirm: req.body.confirm || false
    });

    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/create-pending error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/:poNumber/check-stock
 * @desc Check Odoo stock levels for PO items and update the PO with product info
 * @body warehouseCode - Optional: warehouse code to check (default from marketplace config)
 */
router.post('/orders/:poNumber/check-stock', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const po = await importer.getPurchaseOrder(req.params.poNumber);

    if (!po) {
      return res.status(404).json({ success: false, error: 'Purchase order not found' });
    }

    // Get warehouse code
    const warehouseCode = req.body.warehouseCode || MARKETPLACE_WAREHOUSE[po.marketplaceId] || 'be1';

    // Initialize Odoo client
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    // Find warehouse in Odoo
    const warehouses = await odoo.search('stock.warehouse', [['code', '=', warehouseCode]], { limit: 1 });
    const warehouseId = warehouses.length > 0 ? warehouses[0] : null;

    const productInfoList = [];
    const errors = [];

    for (const item of po.items || []) {
      const sku = item.vendorProductIdentifier;
      const asin = item.amazonProductIdentifier;

      if (!sku && !asin) {
        errors.push({ itemSequenceNumber: item.itemSequenceNumber, error: 'No SKU or ASIN' });
        continue;
      }

      // Find product in Odoo by SKU
      let productId = null;
      let productData = null;

      if (sku) {
        const products = await odoo.searchRead('product.product',
          [['default_code', '=', sku]],
          ['id', 'name', 'default_code', 'qty_available', 'free_qty'],
          { limit: 1 }
        );
        if (products.length > 0) {
          productData = products[0];
          productId = productData.id;
        }
      }

      // Try by barcode/ASIN if not found
      if (!productId && asin) {
        const products = await odoo.searchRead('product.product',
          [['barcode', '=', asin]],
          ['id', 'name', 'default_code', 'qty_available', 'free_qty'],
          { limit: 1 }
        );
        if (products.length > 0) {
          productData = products[0];
          productId = productData.id;
        }
      }

      if (!productId) {
        errors.push({ itemSequenceNumber: item.itemSequenceNumber, sku, asin, error: 'Product not found in Odoo' });
        productInfoList.push({
          vendorProductIdentifier: sku,
          odooProductId: null,
          odooProductName: null,
          qtyAvailable: 0
        });
        continue;
      }

      // Get warehouse-specific stock if warehouse found
      let qtyAvailable = productData.free_qty || 0;

      if (warehouseId) {
        // Get stock for specific warehouse using quants
        const quants = await odoo.searchRead('stock.quant',
          [
            ['product_id', '=', productId],
            ['location_id.usage', '=', 'internal'],
            ['location_id.warehouse_id', '=', warehouseId]
          ],
          ['quantity', 'reserved_quantity'],
          { limit: 100 }
        );

        if (quants.length > 0) {
          qtyAvailable = quants.reduce((sum, q) => sum + (q.quantity - q.reserved_quantity), 0);
        }
      }

      productInfoList.push({
        vendorProductIdentifier: sku,
        odooProductId: productId,
        odooProductName: productData.name,
        qtyAvailable: Math.max(0, qtyAvailable)
      });
    }

    // Update PO with product info
    if (productInfoList.length > 0) {
      await importer.updateItemsProductInfo(req.params.poNumber, productInfoList);
    }

    // Get updated PO
    const updatedPO = await importer.getPurchaseOrder(req.params.poNumber);

    res.json({
      success: true,
      purchaseOrderNumber: req.params.poNumber,
      warehouseCode,
      itemsChecked: productInfoList.length,
      errors: errors.length > 0 ? errors : undefined,
      items: updatedPO.items.map(item => ({
        itemSequenceNumber: item.itemSequenceNumber,
        vendorProductIdentifier: item.vendorProductIdentifier,
        amazonProductIdentifier: item.amazonProductIdentifier,
        orderedQty: item.orderedQuantity?.amount || 0,
        odooProductId: item.odooProductId,
        odooProductName: item.odooProductName,
        qtyAvailable: item.qtyAvailable,
        acknowledgeQty: item.acknowledgeQty,
        backorderQty: item.backorderQty,
        productAvailability: item.productAvailability
      }))
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/:poNumber/check-stock error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/:poNumber/update-acknowledgments
 * @desc Update line-level acknowledgment quantities for a PO
 * @body items - Array of { vendorProductIdentifier, acknowledgeQty, backorderQty, productAvailability }
 * @body scheduledShipDate - Optional: scheduled ship date
 * @body scheduledDeliveryDate - Optional: scheduled delivery date
 * @body autoFill - Optional: if true, auto-fill based on stock levels
 */
router.post('/orders/:poNumber/update-acknowledgments', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const po = await importer.getPurchaseOrder(req.params.poNumber);

    if (!po) {
      return res.status(404).json({ success: false, error: 'Purchase order not found' });
    }

    // Auto-fill based on stock if requested
    if (req.body.autoFill) {
      await importer.autoFillAcknowledgments(req.params.poNumber);
    } else if (req.body.items && req.body.items.length > 0) {
      // Manual update
      await importer.updateLineAcknowledgments(
        req.params.poNumber,
        req.body.items,
        {
          scheduledShipDate: req.body.scheduledShipDate,
          scheduledDeliveryDate: req.body.scheduledDeliveryDate
        }
      );
    }

    // Get updated PO
    const updatedPO = await importer.getPurchaseOrder(req.params.poNumber);

    res.json({
      success: true,
      purchaseOrderNumber: req.params.poNumber,
      items: updatedPO.items.map(item => ({
        itemSequenceNumber: item.itemSequenceNumber,
        vendorProductIdentifier: item.vendorProductIdentifier,
        orderedQty: item.orderedQuantity?.amount || 0,
        acknowledgeQty: item.acknowledgeQty,
        backorderQty: item.backorderQty,
        productAvailability: item.productAvailability,
        qtyAvailable: item.qtyAvailable
      })),
      acknowledgment: updatedPO.acknowledgment
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/:poNumber/update-acknowledgments error:', error);
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
 * @body odooInvoiceId - Optional: specific Odoo invoice ID to use
 * @body dryRun - Optional: simulate without sending (default false)
 */
router.post('/invoices/:poNumber/submit', async (req, res) => {
  try {
    const submitter = await getVendorInvoiceSubmitter();

    const result = await submitter.submitInvoice(req.params.poNumber, {
      odooInvoiceId: req.body.odooInvoiceId || null,
      dryRun: req.body.dryRun || false
    });

    if (!result.success && result.errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: result.errors,
        warnings: result.warnings
      });
    }

    res.json({
      success: true,
      submitted: !result.skipped && !result.dryRun,
      skipped: result.skipped,
      skipReason: result.skipReason,
      dryRun: result.dryRun || false,
      purchaseOrderNumber: result.purchaseOrderNumber,
      invoiceNumber: result.invoiceNumber,
      transactionId: result.transactionId,
      warnings: result.warnings,
      ...(result.payload && { payload: result.payload })
    });
  } catch (error) {
    console.error('[VendorAPI] POST /invoices/:poNumber/submit error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/invoices/submit-pending
 * @desc Submit invoices for all POs ready for invoicing
 * @body limit - Optional: max POs to process (default 50)
 * @body dryRun - Optional: simulate without sending (default false)
 */
router.post('/invoices/submit-pending', async (req, res) => {
  try {
    const submitter = await getVendorInvoiceSubmitter();

    const results = await submitter.submitPendingInvoices({
      limit: req.body.limit || 50,
      dryRun: req.body.dryRun || false
    });

    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('[VendorAPI] POST /invoices/submit-pending error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/invoices/stats
 * @desc Get invoice submission statistics
 */
router.get('/invoices/stats', async (req, res) => {
  try {
    const submitter = await getVendorInvoiceSubmitter();
    const stats = await submitter.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[VendorAPI] GET /invoices/stats error:', error);
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
