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
const fs = require('fs');
const path = require('path');
const { getDb } = require('../../db');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// Load paid invoices data from remittance import
let paidInvoicesData = { paidInvoices: {} };
try {
  const paidInvoicesPath = path.join(__dirname, '../../../data/vendor-paid-invoices.json');
  if (fs.existsSync(paidInvoicesPath)) {
    paidInvoicesData = JSON.parse(fs.readFileSync(paidInvoicesPath, 'utf8'));
    console.log(`[VendorAPI] Loaded ${Object.keys(paidInvoicesData.paidInvoices).length} paid invoice records`);
  }
} catch (e) {
  console.warn('[VendorAPI] Could not load paid invoices data:', e.message);
}
const {
  VendorClient,
  getVendorPOImporter,
  getVendorOrderCreator,
  getVendorPOAcknowledger,
  getVendorInvoiceSubmitter,
  getVendorASNCreator,
  getVendorChargebackTracker,
  getVendorRemittanceParser,
  getVendorPartyMapping,
  MARKETPLACE_IDS,
  VENDOR_ACCOUNTS,
  PO_STATES,
  ACK_CODES,
  MARKETPLACE_WAREHOUSE,
  CHARGEBACK_TYPES,
  DISPUTE_STATUS,
  PAYMENT_STATUS,
  PARTY_TYPES
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

    // Handle stat filter (from clicking stat cards)
    if (req.query.statFilter) {
      switch (req.query.statFilter) {
        case 'new':
          filters.state = 'New';
          break;
        case 'not-shipped':
          filters.state = 'Acknowledged';
          filters.shipmentStatus = 'not_shipped';
          break;
        case 'action-required':
          // New orders OR Acknowledged but not shipped
          filters.actionRequired = true;
          break;
        case 'invoice-pending':
          filters.state = 'Acknowledged';
          filters.shipmentStatus = 'fully_shipped';
          filters.invoicePending = true;
          break;
        case 'closed':
          filters.state = 'Closed';
          break;
        case 'cancelled':
          filters.shipmentStatus = 'cancelled';
          break;
      }
    } else {
      // Regular filters
      if (req.query.marketplace) filters.marketplace = req.query.marketplace.toUpperCase();
      if (req.query.state) filters.state = req.query.state;
      if (req.query.acknowledged !== undefined) filters.acknowledged = req.query.acknowledged === 'true';
      if (req.query.hasOdooOrder !== undefined) filters.hasOdooOrder = req.query.hasOdooOrder === 'true';
      if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
      if (req.query.dateTo) filters.dateTo = req.query.dateTo;
      // Shipping status filter: not-shipped, open (partial), shipped (fully shipped)
      if (req.query.shippingStatus) {
        switch (req.query.shippingStatus) {
          case 'not-shipped':
            filters.shipmentStatus = 'not_shipped';
            break;
          case 'open':
            filters.shipmentStatus = 'partially_shipped';
            break;
          case 'shipped':
            filters.shipmentStatus = 'fully_shipped';
            break;
        }
      }
    }

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
        shipmentStatus: o.shipmentStatus,
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

    // Always use Central Warehouse (CW) for stock checks
    const warehouseCode = 'CW';

    // Initialize Odoo client
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    // Find Central Warehouse in Odoo
    const warehouses = await odoo.search('stock.warehouse', [['code', '=', warehouseCode]], { limit: 1 });
    const warehouseId = warehouses.length > 0 ? warehouses[0] : null;

    if (!warehouseId) {
      return res.status(500).json({ success: false, error: 'Central Warehouse (CW) not found in Odoo' });
    }

    const productInfoList = [];
    const errors = [];

    for (const item of po.items || []) {
      // vendorProductIdentifier from Amazon = EAN/barcode
      // amazonProductIdentifier = ASIN
      const ean = item.vendorProductIdentifier;
      const asin = item.amazonProductIdentifier;

      if (!ean && !asin) {
        errors.push({ itemSequenceNumber: item.itemSequenceNumber, error: 'No EAN or ASIN' });
        continue;
      }

      // Find product in Odoo by barcode (EAN)
      let productId = null;
      let productData = null;

      if (ean) {
        const products = await odoo.searchRead('product.product',
          [['barcode', '=', ean]],
          ['id', 'name', 'default_code', 'qty_available', 'free_qty'],
          { limit: 1 }
        );
        if (products.length > 0) {
          productData = products[0];
          productId = productData.id;
        }
      }

      // Try by ASIN in barcode field if not found by EAN
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
        errors.push({ itemSequenceNumber: item.itemSequenceNumber, ean, asin, error: 'Product not found in Odoo' });
        productInfoList.push({
          vendorProductIdentifier: ean,
          odooProductId: null,
          odooProductName: null,
          qtyAvailable: 0
        });
        continue;
      }

      // Get stock from Central Warehouse using stock.quant
      const quants = await odoo.searchRead('stock.quant',
        [
          ['product_id', '=', productId],
          ['location_id.usage', '=', 'internal'],
          ['location_id.warehouse_id', '=', warehouseId]
        ],
        ['quantity', 'reserved_quantity'],
        { limit: 100 }
      );

      const qtyAvailable = quants.length > 0
        ? quants.reduce((sum, q) => sum + (q.quantity - q.reserved_quantity), 0)
        : 0;

      productInfoList.push({
        vendorProductIdentifier: ean,
        odooProductId: productId,
        odooProductName: productData.name,
        odooSku: productData.default_code,
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
        odooSku: item.odooSku,
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
 * @route GET /api/vendor/invoices/odoo
 * @desc Get Amazon invoices from Odoo with submission status
 * @query limit - Max results (default 100)
 * @query offset - Skip N results
 * @query dateFrom - Filter by date from
 * @query dateTo - Filter by date to
 */
router.get('/invoices/odoo', async (req, res) => {
  try {
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    // Build date filter
    const dateFilter = [];
    if (req.query.dateFrom) {
      dateFilter.push(['invoice_date', '>=', req.query.dateFrom]);
    }
    if (req.query.dateTo) {
      dateFilter.push(['invoice_date', '<=', req.query.dateTo]);
    }

    // Find the Amazon Vendor sales team
    const vendorTeams = await odoo.searchRead('crm.team',
      [['name', 'ilike', 'vendor']],
      ['id', 'name'],
      { limit: 5 }
    );

    if (vendorTeams.length === 0) {
      return res.json({ success: true, count: 0, invoices: [], error: 'No vendor sales team found' });
    }

    const vendorTeamIds = vendorTeams.map(t => t.id);

    // Get invoices with Sales Team = Amazon Vendor
    const invoiceFilter = [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['team_id', 'in', vendorTeamIds],
      ...dateFilter
    ];

    const invoices = await odoo.searchRead('account.move',
      invoiceFilter,
      ['id', 'name', 'partner_id', 'amount_total', 'amount_untaxed', 'invoice_date', 'invoice_date_due', 'invoice_origin', 'ref', 'payment_state'],
      { limit, offset, order: 'invoice_date desc' }
    );

    // Get invoice transaction history to check submission status
    const invoiceIds = invoices.map(i => i.id);
    const transactionHistory = await odoo.searchRead('amazon.vendor.transaction.history',
      [['transaction_type', '=', 'invoice'], ['account_move_id', 'in', invoiceIds]],
      ['account_move_id', 'response_data', 'create_date', 'transaction_id'],
      { limit: 500 }
    );

    // Build a map of invoice ID -> submission info
    const submissionMap = {};
    transactionHistory.forEach(tx => {
      const invoiceId = tx.account_move_id ? tx.account_move_id[0] : null;
      if (invoiceId) {
        let status = 'submitted';
        let errorMessage = null;
        if (tx.response_data) {
          try {
            const resp = JSON.parse(tx.response_data);
            if (resp.transactionStatus?.status === 'Failure') {
              status = 'failed';
              errorMessage = resp.transactionStatus?.errors?.[0]?.message || 'Submission failed';
            } else if (resp.transactionStatus?.status === 'Success') {
              status = 'accepted';
            }
          } catch (e) {}
        }
        submissionMap[invoiceId] = {
          status,
          submittedAt: tx.create_date,
          transactionId: tx.transaction_id,
          errorMessage
        };
      }
    });

    // Get total count for pagination
    const totalCount = await odoo.execute('account.move', 'search_count', [invoiceFilter]);

    // Format response
    const formattedInvoices = invoices.map(inv => {
      const submission = submissionMap[inv.id];
      const partnerId = inv.partner_id ? inv.partner_id[0] : null;
      const partnerName = inv.partner_id ? inv.partner_id[1] : null;

      // Extract marketplace from partner name (e.g., "Amazon EU SARL Deutschland" -> "DE")
      let marketplace = null;
      if (partnerName) {
        const lower = partnerName.toLowerCase();
        if (lower.includes('deutschland') || lower.includes('germany')) marketplace = 'DE';
        else if (lower.includes('france')) marketplace = 'FR';
        else if (lower.includes('italy') || lower.includes('itali')) marketplace = 'IT';
        else if (lower.includes('spain') || lower.includes('espa')) marketplace = 'ES';
        else if (lower.includes('netherlands') || lower.includes(' nl')) marketplace = 'NL';
        else if (lower.includes('belgium') || lower.includes('belgi')) marketplace = 'BE';
        else if (lower.includes('poland') || lower.includes('pologne')) marketplace = 'PL';
        else if (lower.includes('sweden') || lower.includes('suède')) marketplace = 'SE';
        else if (lower.includes('uk') || lower.includes('kingdom')) marketplace = 'UK';
        else if (lower.includes('czech')) marketplace = 'CZ';
      }

      // Check if this invoice was paid via Amazon remittance
      const paidInfo = paidInvoicesData.paidInvoices[String(inv.id)];

      return {
        id: inv.id,
        invoiceNumber: inv.name,
        partnerId,
        partnerName,
        marketplace,
        amountTotal: inv.amount_total,
        amountUntaxed: inv.amount_untaxed,
        invoiceDate: inv.invoice_date,
        invoiceDateDue: inv.invoice_date_due,
        origin: inv.invoice_origin || inv.ref,
        paymentState: inv.payment_state,
        amazonSubmission: submission ? {
          status: submission.status,
          submittedAt: submission.submittedAt,
          transactionId: submission.transactionId,
          errorMessage: submission.errorMessage
        } : {
          status: 'not_submitted'
        },
        amazonPayment: paidInfo ? {
          status: 'paid',
          amazonInvoiceNumber: paidInfo.amazonInvoice,
          amazonAmount: paidInfo.amazonAmount,
          netPaid: paidInfo.netPaid
        } : null
      };
    });

    res.json({
      success: true,
      count: formattedInvoices.length,
      total: totalCount,
      offset,
      limit,
      invoices: formattedInvoices
    });
  } catch (error) {
    console.error('[VendorAPI] GET /invoices/odoo error:', error);
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
 * @route POST /api/vendor/shipments/poll
 * @desc Poll shipments from Amazon Vendor Central
 * @query marketplace - Marketplace code (default: DE)
 * @query days - Number of days to look back (default: 30)
 */
router.post('/shipments/poll', async (req, res) => {
  try {
    const marketplace = req.query.marketplace || req.body.marketplace || 'DE';
    const days = parseInt(req.query.days || req.body.days) || 30;

    const client = new VendorClient(marketplace);
    await client.init();

    const createdAfter = new Date();
    createdAfter.setDate(createdAfter.getDate() - days);

    // Fetch shipments from Amazon
    const result = await client.getShipmentDetails({
      createdAfter: createdAfter.toISOString(),
      limit: 100
    });

    const shipments = result.shipments || [];

    // Store shipments in MongoDB
    if (shipments.length > 0) {
      const db = getDb();
      const collection = db.collection('vendor_shipments');

      for (const shipment of shipments) {
        await collection.updateOne(
          { shipmentId: shipment.shipmentIdentifier },
          {
            $set: {
              ...shipment,
              marketplaceId: marketplace,
              source: 'amazon_poll',
              updatedAt: new Date()
            },
            $setOnInsert: {
              createdAt: new Date()
            }
          },
          { upsert: true }
        );
      }
    }

    res.json({
      success: true,
      marketplace,
      found: shipments.length,
      message: shipments.length === 0
        ? 'No shipments found in Amazon. Shipments appear after ASN submission.'
        : `Found and synced ${shipments.length} shipments from Amazon`
    });
  } catch (error) {
    console.error('[VendorAPI] POST /shipments/poll error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/shipments/:poNumber/create-asn
 * @desc Create ASN/shipment confirmation for a PO
 * @body odooPickingId - Optional: specific Odoo picking ID
 * @body dryRun - Optional: simulate without sending (default false)
 */
router.post('/shipments/:poNumber/create-asn', async (req, res) => {
  try {
    const asnCreator = await getVendorASNCreator();

    const result = await asnCreator.submitASN(req.params.poNumber, {
      odooPickingId: req.body.odooPickingId || null,
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
      submitted: !result.dryRun,
      dryRun: result.dryRun || false,
      purchaseOrderNumber: result.purchaseOrderNumber,
      shipmentId: result.shipmentId,
      transactionId: result.transactionId,
      warnings: result.warnings,
      ...(result.payload && { payload: result.payload })
    });
  } catch (error) {
    console.error('[VendorAPI] POST /shipments/:poNumber/create-asn error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/shipments/ready
 * @desc Get POs that are ready to ship (acknowledged but no ASN sent)
 * NOTE: This route MUST be defined before /shipments/:shipmentId to avoid matching "ready" as a shipmentId
 */
router.get('/shipments/ready', async (req, res) => {
  try {
    const asnCreator = await getVendorASNCreator();
    const readyPOs = await asnCreator.findPOsReadyToShip();

    res.json({
      success: true,
      count: readyPOs.length,
      orders: readyPOs.map(po => ({
        purchaseOrderNumber: po.purchaseOrderNumber,
        marketplaceId: po.marketplaceId,
        purchaseOrderDate: po.purchaseOrderDate,
        odoo: po.odoo,
        totals: po.totals
      }))
    });
  } catch (error) {
    console.error('[VendorAPI] GET /shipments/ready error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/shipments/:shipmentId
 * @desc Get a specific shipment by ID
 */
router.get('/shipments/:shipmentId', async (req, res) => {
  try {
    const asnCreator = await getVendorASNCreator();
    const shipment = await asnCreator.getShipment(req.params.shipmentId);

    if (!shipment) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    res.json({
      success: true,
      shipment
    });
  } catch (error) {
    console.error('[VendorAPI] GET /shipments/:shipmentId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/shipments/:shipmentId/check-status
 * @desc Check transaction status with Amazon for a shipment
 */
router.post('/shipments/:shipmentId/check-status', async (req, res) => {
  try {
    const asnCreator = await getVendorASNCreator();
    const status = await asnCreator.checkTransactionStatus(req.params.shipmentId);

    if (status.error) {
      return res.status(400).json({ success: false, error: status.error });
    }

    res.json({
      success: true,
      shipmentId: req.params.shipmentId,
      status
    });
  } catch (error) {
    console.error('[VendorAPI] POST /shipments/:shipmentId/check-status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/shipments/submit-pending
 * @desc Submit ASNs for all POs ready to ship
 * @body dryRun - Optional: simulate without sending (default false)
 */
router.post('/shipments/submit-pending', async (req, res) => {
  try {
    const asnCreator = await getVendorASNCreator();
    const results = await asnCreator.autoSubmitASNs(req.body.dryRun || false);

    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('[VendorAPI] POST /shipments/submit-pending error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== CHARGEBACKS ====================

/**
 * @route GET /api/vendor/chargebacks
 * @desc Get chargebacks with filters
 */
router.get('/chargebacks', async (req, res) => {
  try {
    const tracker = await getVendorChargebackTracker();

    const filters = {};
    if (req.query.marketplace) filters.marketplaceId = req.query.marketplace.toUpperCase();
    if (req.query.type) filters.chargebackType = req.query.type;
    if (req.query.status) filters.disputeStatus = req.query.status;
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;

    const options = {
      limit: parseInt(req.query.limit) || 50,
      skip: parseInt(req.query.skip) || 0
    };

    const chargebacks = await tracker.getChargebacks(filters, options);

    res.json({
      success: true,
      count: chargebacks.length,
      chargebacks
    });
  } catch (error) {
    console.error('[VendorAPI] GET /chargebacks error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/chargebacks/stats
 * @desc Get chargeback statistics
 */
router.get('/chargebacks/stats', async (req, res) => {
  try {
    const tracker = await getVendorChargebackTracker();

    const filters = {};
    if (req.query.marketplace) filters.marketplaceId = req.query.marketplace.toUpperCase();
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;

    const stats = await tracker.getStats(filters);

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[VendorAPI] GET /chargebacks/stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/chargebacks/:chargebackId
 * @desc Get a specific chargeback
 */
router.get('/chargebacks/:chargebackId', async (req, res) => {
  try {
    const tracker = await getVendorChargebackTracker();
    const chargeback = await tracker.getChargeback(req.params.chargebackId);

    if (!chargeback) {
      return res.status(404).json({ success: false, error: 'Chargeback not found' });
    }

    res.json({
      success: true,
      chargeback
    });
  } catch (error) {
    console.error('[VendorAPI] GET /chargebacks/:chargebackId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/chargebacks/import
 * @desc Import chargebacks from CSV file
 * @body csvContent - CSV file content
 * @body marketplace - Marketplace ID
 */
router.post('/chargebacks/import', async (req, res) => {
  try {
    const tracker = await getVendorChargebackTracker();

    if (!req.body.csvContent) {
      return res.status(400).json({ success: false, error: 'CSV content is required' });
    }

    const result = await tracker.importFromCSV(req.body.csvContent, {
      marketplace: req.body.marketplace || 'DE'
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /chargebacks/import error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/chargebacks
 * @desc Manually create a chargeback entry
 */
router.post('/chargebacks', async (req, res) => {
  try {
    const tracker = await getVendorChargebackTracker();

    const chargeback = await tracker.createChargeback(req.body);

    res.json({
      success: true,
      chargeback
    });
  } catch (error) {
    console.error('[VendorAPI] POST /chargebacks error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route PUT /api/vendor/chargebacks/:chargebackId/dispute
 * @desc Update dispute status for a chargeback
 * @body status - Dispute status (pending, accepted, disputed, won, lost, partial)
 * @body notes - Optional notes
 */
router.put('/chargebacks/:chargebackId/dispute', async (req, res) => {
  try {
    const tracker = await getVendorChargebackTracker();

    if (!req.body.status) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    const updated = await tracker.updateDisputeStatus(
      req.params.chargebackId,
      req.body.status,
      req.body.notes
    );

    if (!updated) {
      return res.status(404).json({ success: false, error: 'Chargeback not found or not updated' });
    }

    res.json({
      success: true,
      chargebackId: req.params.chargebackId,
      status: req.body.status
    });
  } catch (error) {
    console.error('[VendorAPI] PUT /chargebacks/:chargebackId/dispute error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route DELETE /api/vendor/chargebacks/:chargebackId
 * @desc Delete a chargeback
 */
router.delete('/chargebacks/:chargebackId', async (req, res) => {
  try {
    const tracker = await getVendorChargebackTracker();
    const deleted = await tracker.deleteChargeback(req.params.chargebackId);

    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Chargeback not found' });
    }

    res.json({
      success: true,
      deleted: true
    });
  } catch (error) {
    console.error('[VendorAPI] DELETE /chargebacks/:chargebackId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== REMITTANCES ====================

/**
 * @route GET /api/vendor/remittances
 * @desc Get remittances with filters
 */
router.get('/remittances', async (req, res) => {
  try {
    const parser = await getVendorRemittanceParser();

    const filters = {};
    if (req.query.marketplace) filters.marketplaceId = req.query.marketplace.toUpperCase();
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;

    const options = {
      limit: parseInt(req.query.limit) || 50,
      skip: parseInt(req.query.skip) || 0
    };

    const remittances = await parser.getRemittances(filters, options);

    res.json({
      success: true,
      count: remittances.length,
      remittances
    });
  } catch (error) {
    console.error('[VendorAPI] GET /remittances error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/remittances/stats
 * @desc Get remittance/payment statistics
 */
router.get('/remittances/stats', async (req, res) => {
  try {
    const parser = await getVendorRemittanceParser();

    const filters = {};
    if (req.query.marketplace) filters.marketplaceId = req.query.marketplace.toUpperCase();
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;

    const stats = await parser.getStats(filters);

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[VendorAPI] GET /remittances/stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/remittances/:remittanceId
 * @desc Get a specific remittance with payment lines
 */
router.get('/remittances/:remittanceId', async (req, res) => {
  try {
    const parser = await getVendorRemittanceParser();
    const remittance = await parser.getRemittance(req.params.remittanceId);

    if (!remittance) {
      return res.status(404).json({ success: false, error: 'Remittance not found' });
    }

    res.json({
      success: true,
      remittance
    });
  } catch (error) {
    console.error('[VendorAPI] GET /remittances/:remittanceId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/remittances/import
 * @desc Import remittance from CSV file
 * @body csvContent - CSV file content
 * @body marketplace - Marketplace ID
 */
router.post('/remittances/import', async (req, res) => {
  try {
    const parser = await getVendorRemittanceParser();

    if (!req.body.csvContent) {
      return res.status(400).json({ success: false, error: 'CSV content is required' });
    }

    const result = await parser.importFromCSV(req.body.csvContent, {
      marketplace: req.body.marketplace || 'DE'
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /remittances/import error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/payments
 * @desc Get payment lines with filters
 */
router.get('/payments', async (req, res) => {
  try {
    const parser = await getVendorRemittanceParser();

    const filters = {};
    if (req.query.marketplace) filters.marketplaceId = req.query.marketplace.toUpperCase();
    if (req.query.invoiceNumber) filters.invoiceNumber = req.query.invoiceNumber;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.remittanceId) filters.remittanceId = req.query.remittanceId;
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;

    const options = {
      limit: parseInt(req.query.limit) || 50,
      skip: parseInt(req.query.skip) || 0
    };

    const payments = await parser.getPayments(filters, options);

    res.json({
      success: true,
      count: payments.length,
      payments
    });
  } catch (error) {
    console.error('[VendorAPI] GET /payments error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/payments/reconcile
 * @desc Reconcile payments with invoices
 */
router.post('/payments/reconcile', async (req, res) => {
  try {
    const parser = await getVendorRemittanceParser();
    const results = await parser.reconcilePayments();

    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('[VendorAPI] POST /payments/reconcile error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/invoices/unpaid
 * @desc Get unpaid invoices
 */
router.get('/invoices/unpaid', async (req, res) => {
  try {
    const parser = await getVendorRemittanceParser();
    const unpaidInvoices = await parser.getUnpaidInvoices();

    res.json({
      success: true,
      count: unpaidInvoices.length,
      invoices: unpaidInvoices
    });
  } catch (error) {
    console.error('[VendorAPI] GET /invoices/unpaid error:', error);
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

// ==================== PARTY MAPPING ====================

/**
 * @route GET /api/vendor/party-mappings
 * @desc Get all party mappings
 * @query partyType - Filter by party type (shipTo, billTo, buying, selling)
 * @query marketplace - Filter by marketplace
 * @query active - Filter by active status (true/false)
 */
router.get('/party-mappings', async (req, res) => {
  try {
    const mapping = await getVendorPartyMapping();

    const filters = {};
    if (req.query.partyType) filters.partyType = req.query.partyType;
    if (req.query.marketplace) filters.marketplace = req.query.marketplace.toUpperCase();
    if (req.query.active !== undefined) filters.active = req.query.active === 'true';

    const mappings = await mapping.getAllMappings(filters);

    res.json({
      success: true,
      count: mappings.length,
      mappings
    });
  } catch (error) {
    console.error('[VendorAPI] GET /party-mappings error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/party-mappings/stats
 * @desc Get party mapping statistics
 */
router.get('/party-mappings/stats', async (req, res) => {
  try {
    const mapping = await getVendorPartyMapping();
    const stats = await mapping.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[VendorAPI] GET /party-mappings/stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/party-mappings/unmapped
 * @desc Get unmapped party IDs from existing orders
 */
router.get('/party-mappings/unmapped', async (req, res) => {
  try {
    const mapping = await getVendorPartyMapping();
    const unmapped = await mapping.getUnmappedPartyIds();

    res.json({
      success: true,
      count: unmapped.length,
      unmapped
    });
  } catch (error) {
    console.error('[VendorAPI] GET /party-mappings/unmapped error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/party-mappings/:partyId
 * @desc Get a specific party mapping
 */
router.get('/party-mappings/:partyId', async (req, res) => {
  try {
    const mapping = await getVendorPartyMapping();
    const result = mapping.getMapping(req.params.partyId.toUpperCase());

    if (!result) {
      return res.status(404).json({ success: false, error: 'Party mapping not found' });
    }

    res.json({
      success: true,
      mapping: result
    });
  } catch (error) {
    console.error('[VendorAPI] GET /party-mappings/:partyId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/party-mappings
 * @desc Create or update a party mapping
 * @body partyId - Amazon party code (required)
 * @body partyType - Party type: shipTo, billTo, buying, selling
 * @body odooPartnerId - Odoo res.partner ID (required)
 * @body odooPartnerName - Odoo partner name
 * @body vatNumber - VAT number
 * @body address - Address string
 * @body country - Country
 * @body marketplace - Optional marketplace filter
 * @body notes - Optional notes
 */
router.post('/party-mappings', async (req, res) => {
  try {
    if (!req.body.partyId) {
      return res.status(400).json({ success: false, error: 'partyId is required' });
    }
    if (!req.body.odooPartnerId) {
      return res.status(400).json({ success: false, error: 'odooPartnerId is required' });
    }

    const mapping = await getVendorPartyMapping();
    const result = await mapping.upsertMapping({
      partyId: req.body.partyId.toUpperCase(),
      partyType: req.body.partyType || PARTY_TYPES.SHIP_TO,
      odooPartnerId: parseInt(req.body.odooPartnerId),
      odooPartnerName: req.body.odooPartnerName || null,
      vatNumber: req.body.vatNumber || null,
      address: req.body.address || null,
      country: req.body.country || null,
      marketplace: req.body.marketplace ? req.body.marketplace.toUpperCase() : null,
      notes: req.body.notes || null,
      active: req.body.active !== false
    });

    res.json({
      success: true,
      mapping: result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /party-mappings error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route DELETE /api/vendor/party-mappings/:partyId
 * @desc Delete a party mapping
 */
router.delete('/party-mappings/:partyId', async (req, res) => {
  try {
    const mapping = await getVendorPartyMapping();
    await mapping.deleteMapping(req.params.partyId.toUpperCase());

    res.json({
      success: true,
      deleted: true
    });
  } catch (error) {
    console.error('[VendorAPI] DELETE /party-mappings/:partyId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/party-mappings/import-odoo
 * @desc Import party mappings from existing Odoo partners
 * @body dryRun - If true, show what would be imported without saving
 * @body overwrite - If true, overwrite existing mappings
 */
router.post('/party-mappings/import-odoo', async (req, res) => {
  try {
    const mapping = await getVendorPartyMapping();
    const result = await mapping.importFromOdoo({
      dryRun: req.body.dryRun || false,
      overwrite: req.body.overwrite || false
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /party-mappings/import-odoo error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/party-mappings/search-odoo
 * @desc Search Odoo partners for potential mapping matches
 * @query q - Search term
 */
router.get('/party-mappings/search-odoo', async (req, res) => {
  try {
    if (!req.query.q || req.query.q.length < 2) {
      return res.status(400).json({ success: false, error: 'Search term (q) must be at least 2 characters' });
    }

    const mapping = await getVendorPartyMapping();
    const partners = await mapping.searchOdooPartners(req.query.q);

    res.json({
      success: true,
      count: partners.length,
      partners
    });
  } catch (error) {
    console.error('[VendorAPI] GET /party-mappings/search-odoo error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== REMITTANCE / PAYMENTS ====================

const { VendorRemittanceImporter } = require('../../services/amazon/vendor/VendorRemittanceImporter');
const multer = require('multer');

// Configure multer for file uploads
const remittanceUpload = multer({
  dest: '/tmp/remittance-uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel (.xlsx, .xls) and CSV files are allowed'));
    }
  }
});

/**
 * @route POST /api/vendor/remittance/upload
 * @desc Upload and import a remittance file
 */
router.post('/remittance/upload', remittanceUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const importer = new VendorRemittanceImporter();
    await importer.init();

    const result = await importer.importRemittance(req.file.path);

    // Clean up temp file
    fs.unlink(req.file.path, () => {});

    res.json({
      success: true,
      fileName: req.file.originalname,
      ...result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /remittance/upload error:', error);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/remittance/import-local
 * @desc Import remittance from a local file path (admin only)
 * @body filePath - Path to the remittance file
 */
router.post('/remittance/import-local', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'filePath is required' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(400).json({ success: false, error: 'File not found: ' + filePath });
    }

    const importer = new VendorRemittanceImporter();
    await importer.init();

    const result = await importer.importRemittance(filePath);

    res.json({
      success: true,
      filePath,
      ...result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /remittance/import-local error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/remittance/summary
 * @desc Get remittance import summary and statistics
 */
router.get('/remittance/summary', async (req, res) => {
  try {
    const importer = new VendorRemittanceImporter();
    await importer.init();

    const summary = await importer.getImportSummary();

    res.json({
      success: true,
      ...summary
    });
  } catch (error) {
    console.error('[VendorAPI] GET /remittance/summary error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/invoices/payment-status
 * @desc Get payment status for invoices from remittance data
 * @query invoiceIds - Comma-separated list of Odoo invoice IDs
 */
router.get('/invoices/payment-status', async (req, res) => {
  try {
    if (!req.query.invoiceIds) {
      return res.status(400).json({ success: false, error: 'invoiceIds query parameter required' });
    }

    const invoiceIds = req.query.invoiceIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));

    const importer = new VendorRemittanceImporter();
    await importer.init();

    const statusMap = await importer.getInvoicePaymentStatus(invoiceIds);

    res.json({
      success: true,
      statusMap
    });
  } catch (error) {
    console.error('[VendorAPI] GET /invoices/payment-status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
