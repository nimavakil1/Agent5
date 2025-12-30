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

// Test Mode support
const {
  isTestMode,
  enableTestMode,
  disableTestMode,
  getTestModeStatus,
  generateTestPOs,
  cleanupTestData
} = require('../../services/amazon/vendor/TestMode');

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

      // Find product in Odoo - try multiple search strategies
      let productId = null;
      let productData = null;

      // Strategy 1: Search by barcode (vendorProductIdentifier is often EAN)
      if (ean) {
        const products = await odoo.searchRead('product.product',
          [['barcode', '=', ean]],
          ['id', 'name', 'default_code', 'barcode', 'qty_available', 'free_qty'],
          { limit: 1 }
        );
        if (products.length > 0) {
          productData = products[0];
          productId = productData.id;
        }
      }

      // Strategy 2: Search by default_code/SKU (vendorProductIdentifier is sometimes internal SKU)
      if (!productId && ean) {
        const products = await odoo.searchRead('product.product',
          [['default_code', '=', ean]],
          ['id', 'name', 'default_code', 'barcode', 'qty_available', 'free_qty'],
          { limit: 1 }
        );
        if (products.length > 0) {
          productData = products[0];
          productId = productData.id;
        }
      }

      // Strategy 3: Try by ASIN in barcode field
      if (!productId && asin) {
        const products = await odoo.searchRead('product.product',
          [['barcode', '=', asin]],
          ['id', 'name', 'default_code', 'barcode', 'qty_available', 'free_qty'],
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
        odooBarcode: productData.barcode,  // Real EAN from Odoo
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
        odooBarcode: item.odooBarcode,  // Real EAN from Odoo
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

// ==================== ORDER CONSOLIDATION ====================

/**
 * Amazon FC (Fulfillment Center) Names by Party ID
 * These are Amazon's warehouse codes - the shipToParty.partyId
 */
const FC_NAMES = {
  // Germany (DE)
  'TEUR': 'Amazon DE - Leipzig (LEJ1/LEJ2)',
  'LEJ1': 'Amazon DE - Leipzig LEJ1',
  'LEJ2': 'Amazon DE - Leipzig LEJ2',
  'EDE4': 'Amazon DE - Dortmund',
  'CGN1': 'Amazon DE - Köln',
  'FRA1': 'Amazon DE - Bad Hersfeld',
  'FRA3': 'Amazon DE - Bad Hersfeld FRA3',
  'FRA7': 'Amazon DE - Frankfurt Rhein-Main',
  'MUC3': 'Amazon DE - Graben',
  'HAM2': 'Amazon DE - Winsen',
  'BER3': 'Amazon DE - Berlin',
  'DTM1': 'Amazon DE - Dortmund DTM1',
  'DTM2': 'Amazon DE - Werne',
  'DUS2': 'Amazon DE - Mönchengladbach',
  'PAD1': 'Amazon DE - Oelde',
  'STR1': 'Amazon DE - Pforzheim',

  // France (FR)
  'LYS1': 'Amazon FR - Montélimar',
  'ORY1': 'Amazon FR - Saran',
  'ORY4': 'Amazon FR - Brétigny',
  'MRS1': 'Amazon FR - Lauwin-Planque',
  'CDG7': 'Amazon FR - Senlis',
  'BVA1': 'Amazon FR - Amiens',

  // UK
  'LTN1': 'Amazon UK - Marston Gate',
  'BHX1': 'Amazon UK - Rugeley',
  'EUK5': 'Amazon UK - Peterborough',
  'MAN1': 'Amazon UK - Manchester',
  'EDI4': 'Amazon UK - Dunfermline',

  // Italy
  'MXP5': 'Amazon IT - Castel San Giovanni',
  'FCO1': 'Amazon IT - Passo Corese',

  // Spain
  'MAD4': 'Amazon ES - San Fernando',
  'MAD6': 'Amazon ES - Illescas',
  'BCN1': 'Amazon ES - El Prat',

  // Netherlands
  'RTM1': 'Amazon NL - Rozenburg',

  // Belgium
  'CRL1': 'Amazon BE - Charleroi',

  // Poland
  'WRO1': 'Amazon PL - Wrocław',
  'WRO2': 'Amazon PL - Bielany Wrocławskie',
  'POZ1': 'Amazon PL - Poznań',
  'LCJ1': 'Amazon PL - Łódź',
  'KTW1': 'Amazon PL - Gliwice',

  // Sweden
  'ARN1': 'Amazon SE - Eskilstuna',

  // Czech Republic
  'PRG1': 'Amazon CZ - Dobrovíz',
  'PRG2': 'Amazon CZ - Prague'
};

/**
 * Get friendly FC name from party ID
 */
function getFCName(partyId, address = null) {
  if (!partyId) return 'Unknown FC';

  const upper = partyId.toUpperCase();

  // Check known FC codes
  if (FC_NAMES[upper]) {
    return FC_NAMES[upper];
  }

  // Try to extract FC code from longer party IDs (e.g., "AMAZON_EU_FRA3" -> "FRA3")
  const parts = upper.split(/[_\s-]/);
  for (const part of parts.reverse()) {
    if (FC_NAMES[part]) {
      return FC_NAMES[part];
    }
  }

  // If we have address info, use city
  if (address?.city) {
    return `Amazon FC - ${address.city}`;
  }

  return `Amazon FC ${partyId}`;
}

/**
 * Create a group ID from FC party ID and delivery window
 */
function createConsolidationGroupId(partyId, deliveryWindowEnd) {
  const fcCode = partyId?.toUpperCase() || 'UNKNOWN';
  const dateStr = deliveryWindowEnd
    ? new Date(deliveryWindowEnd).toISOString().split('T')[0]
    : 'nodate';
  return `${fcCode}_${dateStr}`;
}

/**
 * @route GET /api/vendor/orders/consolidate
 * @desc Get orders grouped by FC (shipToParty) and delivery window for consolidated shipping
 * @query marketplace - Filter by marketplace
 * @query state - Filter by PO state (default: Acknowledged)
 * @query shipmentStatus - Filter by shipment status (default: not_shipped)
 * @query daysAhead - Days ahead to include delivery windows (default: 14)
 */
router.get('/orders/consolidate', async (req, res) => {
  try {
    const db = getDb();
    const collection = db.collection('vendor_purchase_orders');

    // Build filter - default to orders ready to ship
    // Include both New and Acknowledged states for consolidation
    const query = {
      shipmentStatus: req.query.shipmentStatus || { $in: ['not_shipped', null, undefined] }
    };

    // State filter - default to both New and Acknowledged
    if (req.query.state) {
      query.purchaseOrderState = req.query.state;
    } else {
      query.purchaseOrderState = { $in: ['New', 'Acknowledged'] };
    }

    if (req.query.marketplace) {
      query.marketplaceId = req.query.marketplace.toUpperCase();
    }

    // CRITICAL: Filter out test data unless test mode is enabled
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

    // Get orders
    const orders = await collection.find(query)
      .sort({ 'deliveryWindow.endDate': 1, 'shipToParty.partyId': 1 })
      .toArray();

    // Group by FC + delivery window end date
    const groups = {};

    for (const order of orders) {
      const partyId = order.shipToParty?.partyId || 'UNKNOWN';
      const deliveryEnd = order.deliveryWindow?.endDate;
      const groupId = createConsolidationGroupId(partyId, deliveryEnd);

      if (!groups[groupId]) {
        groups[groupId] = {
          groupId,
          fcPartyId: partyId,
          fcName: getFCName(partyId, order.shipToParty?.address),
          fcAddress: order.shipToParty?.address || null,
          deliveryWindow: order.deliveryWindow,
          marketplace: order.marketplaceId,
          orders: [],
          totalItems: 0,
          totalUnits: 0,
          totalAmount: 0,
          currency: 'EUR'
        };
      }

      const group = groups[groupId];
      group.orders.push({
        purchaseOrderNumber: order.purchaseOrderNumber,
        purchaseOrderDate: order.purchaseOrderDate,
        itemCount: order.items?.length || 0,
        totals: order.totals,
        odoo: order.odoo
      });

      group.totalItems += order.items?.length || 0;
      group.totalUnits += order.totals?.totalUnits || 0;
      group.totalAmount += order.totals?.totalAmount || 0;
      if (order.totals?.currency) group.currency = order.totals.currency;
    }

    // Convert to array and sort by delivery date
    const consolidatedGroups = Object.values(groups).sort((a, b) => {
      const dateA = a.deliveryWindow?.endDate ? new Date(a.deliveryWindow.endDate) : new Date(0);
      const dateB = b.deliveryWindow?.endDate ? new Date(b.deliveryWindow.endDate) : new Date(0);
      return dateA - dateB;
    });

    // Summary stats
    const summary = {
      totalGroups: consolidatedGroups.length,
      totalOrders: orders.length,
      totalUnits: consolidatedGroups.reduce((sum, g) => sum + g.totalUnits, 0),
      totalAmount: consolidatedGroups.reduce((sum, g) => sum + g.totalAmount, 0),
      byFC: {}
    };

    for (const group of consolidatedGroups) {
      if (!summary.byFC[group.fcPartyId]) {
        summary.byFC[group.fcPartyId] = {
          fcName: group.fcName,
          orderCount: 0,
          totalUnits: 0
        };
      }
      summary.byFC[group.fcPartyId].orderCount += group.orders.length;
      summary.byFC[group.fcPartyId].totalUnits += group.totalUnits;
    }

    res.json({
      success: true,
      summary,
      groups: consolidatedGroups
    });
  } catch (error) {
    console.error('[VendorAPI] GET /orders/consolidate error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/orders/consolidate/:groupId
 * @desc Get detailed view of a consolidation group with all items
 */
router.get('/orders/consolidate/:groupId', async (req, res) => {
  try {
    const db = getDb();
    const collection = db.collection('vendor_purchase_orders');

    // Parse group ID to get FC and date
    const [fcPartyId, dateStr] = req.params.groupId.split('_');

    if (!fcPartyId) {
      return res.status(400).json({ success: false, error: 'Invalid group ID' });
    }

    // Build query - include both New and Acknowledged states
    const query = {
      'shipToParty.partyId': { $regex: new RegExp(fcPartyId, 'i') },
      purchaseOrderState: { $in: ['New', 'Acknowledged'] },
      shipmentStatus: { $in: ['not_shipped', null, undefined] }
    };

    // CRITICAL: Filter out test data unless test mode is enabled
    if (!isTestMode()) {
      query._testData = { $ne: true };
    }

    // Add date filter if present
    if (dateStr && dateStr !== 'nodate') {
      const startOfDay = new Date(dateStr);
      const endOfDay = new Date(dateStr);
      endOfDay.setDate(endOfDay.getDate() + 1);
      query['deliveryWindow.endDate'] = { $gte: startOfDay, $lt: endOfDay };
    }

    const orders = await collection.find(query)
      .sort({ purchaseOrderNumber: 1 })
      .toArray();

    if (orders.length === 0) {
      return res.status(404).json({ success: false, error: 'No orders found for this group' });
    }

    // Consolidate all items across orders
    const itemMap = {}; // Key by product identifier
    const consolidatedItems = [];

    for (const order of orders) {
      for (const item of (order.items || [])) {
        const key = item.vendorProductIdentifier || item.amazonProductIdentifier;

        if (!itemMap[key]) {
          itemMap[key] = {
            vendorProductIdentifier: item.vendorProductIdentifier,
            amazonProductIdentifier: item.amazonProductIdentifier,
            odooProductId: item.odooProductId,
            odooProductName: item.odooProductName,
            odooSku: item.odooSku,
            totalQty: 0,
            unitOfMeasure: item.orderedQuantity?.unitOfMeasure || 'Each',
            netCost: item.netCost,
            orders: []
          };
          consolidatedItems.push(itemMap[key]);
        }

        const qty = item.orderedQuantity?.amount || 0;
        itemMap[key].totalQty += qty;
        itemMap[key].orders.push({
          purchaseOrderNumber: order.purchaseOrderNumber,
          qty,
          itemSequenceNumber: item.itemSequenceNumber
        });
      }
    }

    // Sort items by total quantity (most first)
    consolidatedItems.sort((a, b) => b.totalQty - a.totalQty);

    const firstOrder = orders[0];

    res.json({
      success: true,
      groupId: req.params.groupId,
      fcPartyId,
      fcName: getFCName(fcPartyId, firstOrder.shipToParty?.address),
      fcAddress: firstOrder.shipToParty?.address,
      deliveryWindow: firstOrder.deliveryWindow,
      orderCount: orders.length,
      orders: orders.map(o => ({
        purchaseOrderNumber: o.purchaseOrderNumber,
        purchaseOrderDate: o.purchaseOrderDate,
        marketplaceId: o.marketplaceId,
        itemCount: o.items?.length || 0,
        totals: o.totals,
        odoo: o.odoo
      })),
      consolidatedItems,
      summary: {
        totalItems: consolidatedItems.length,
        totalUnits: consolidatedItems.reduce((sum, i) => sum + i.totalQty, 0),
        totalAmount: orders.reduce((sum, o) => sum + (o.totals?.totalAmount || 0), 0)
      }
    });
  } catch (error) {
    console.error('[VendorAPI] GET /orders/consolidate/:groupId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/consolidate/:groupId/packing-list
 * @desc Generate a consolidated packing list for a group of orders
 * @body format - Output format: 'json' (default), 'html', 'csv'
 */
router.post('/orders/consolidate/:groupId/packing-list', async (req, res) => {
  try {
    const db = getDb();
    const collection = db.collection('vendor_purchase_orders');

    // Parse group ID
    const [fcPartyId, dateStr] = req.params.groupId.split('_');

    // Build query
    const query = {
      'shipToParty.partyId': { $regex: new RegExp(fcPartyId, 'i') },
      purchaseOrderState: 'Acknowledged',
      shipmentStatus: 'not_shipped'
    };

    if (dateStr && dateStr !== 'nodate') {
      const startOfDay = new Date(dateStr);
      const endOfDay = new Date(dateStr);
      endOfDay.setDate(endOfDay.getDate() + 1);
      query['deliveryWindow.endDate'] = { $gte: startOfDay, $lt: endOfDay };
    }

    const orders = await collection.find(query)
      .sort({ purchaseOrderNumber: 1 })
      .toArray();

    if (orders.length === 0) {
      return res.status(404).json({ success: false, error: 'No orders found for this group' });
    }

    // Build consolidated packing list
    const packingList = {
      generatedAt: new Date().toISOString(),
      groupId: req.params.groupId,
      shipTo: {
        fcPartyId,
        fcName: getFCName(fcPartyId, orders[0].shipToParty?.address),
        address: orders[0].shipToParty?.address
      },
      deliveryWindow: orders[0].deliveryWindow,
      purchaseOrders: orders.map(o => o.purchaseOrderNumber),
      items: [],
      summary: {
        orderCount: orders.length,
        lineCount: 0,
        totalUnits: 0
      }
    };

    // Consolidate items
    const itemMap = {};

    for (const order of orders) {
      for (const item of (order.items || [])) {
        const key = item.vendorProductIdentifier || item.amazonProductIdentifier;
        const qty = item.orderedQuantity?.amount || 0;

        if (!itemMap[key]) {
          itemMap[key] = {
            line: 0,
            sku: item.odooSku || item.vendorProductIdentifier,
            ean: item.vendorProductIdentifier,
            asin: item.amazonProductIdentifier,
            description: item.odooProductName || 'Unknown Product',
            quantity: 0,
            unitOfMeasure: item.orderedQuantity?.unitOfMeasure || 'Each',
            poNumbers: []
          };
        }

        itemMap[key].quantity += qty;
        if (!itemMap[key].poNumbers.includes(order.purchaseOrderNumber)) {
          itemMap[key].poNumbers.push(order.purchaseOrderNumber);
        }
      }
    }

    // Convert to array with line numbers
    let lineNum = 1;
    packingList.items = Object.values(itemMap)
      .sort((a, b) => (a.sku || '').localeCompare(b.sku || ''))
      .map(item => {
        item.line = lineNum++;
        return item;
      });

    packingList.summary.lineCount = packingList.items.length;
    packingList.summary.totalUnits = packingList.items.reduce((sum, i) => sum + i.quantity, 0);

    const format = req.body.format || 'json';

    if (format === 'html') {
      // Generate printable HTML
      const html = generatePackingListHTML(packingList);
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }

    if (format === 'csv') {
      // Generate CSV
      const csv = generatePackingListCSV(packingList);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="packing-list-${req.params.groupId}.csv"`);
      return res.send(csv);
    }

    res.json({
      success: true,
      packingList
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/consolidate/:groupId/packing-list error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Generate HTML packing list for printing
 */
function generatePackingListHTML(packingList) {
  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-GB') : '-';
  const address = packingList.shipTo.address || {};

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Packing List - ${packingList.groupId}</title>
  <style>
    @media print {
      @page { margin: 1cm; size: A4; }
      .no-print { display: none !important; }
    }
    body { font-family: Arial, sans-serif; font-size: 12px; margin: 20px; }
    h1 { font-size: 18px; margin-bottom: 5px; }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 15px; }
    .header-left { flex: 1; }
    .header-right { text-align: right; }
    .ship-to { background: #f5f5f5; padding: 10px; margin-bottom: 15px; border-radius: 4px; }
    .ship-to h3 { margin: 0 0 5px 0; font-size: 14px; }
    .info-row { margin: 3px 0; }
    .info-label { font-weight: bold; display: inline-block; width: 100px; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
    th { background: #e9e9e9; font-weight: bold; }
    .qty { text-align: center; font-weight: bold; }
    .line-num { text-align: center; width: 40px; }
    .summary { margin-top: 20px; padding: 10px; background: #f9f9f9; border-radius: 4px; }
    .summary-item { display: inline-block; margin-right: 30px; }
    .summary-value { font-size: 16px; font-weight: bold; }
    .po-list { font-size: 11px; color: #666; margin-top: 10px; }
    .footer { margin-top: 30px; padding-top: 10px; border-top: 1px solid #ccc; font-size: 10px; color: #666; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>CONSOLIDATED PACKING LIST</h1>
      <div>Acropaq NV</div>
    </div>
    <div class="header-right">
      <div><strong>Generated:</strong> ${formatDate(packingList.generatedAt)}</div>
      <div><strong>Group ID:</strong> ${packingList.groupId}</div>
    </div>
  </div>

  <div class="ship-to">
    <h3>SHIP TO: ${packingList.shipTo.fcName}</h3>
    <div class="info-row"><span class="info-label">FC Code:</span> ${packingList.shipTo.fcPartyId}</div>
    ${address.addressLine1 ? `<div class="info-row"><span class="info-label">Address:</span> ${address.addressLine1}</div>` : ''}
    ${address.city ? `<div class="info-row"><span class="info-label">City:</span> ${address.city} ${address.postalCode || ''}</div>` : ''}
    ${address.countryCode ? `<div class="info-row"><span class="info-label">Country:</span> ${address.countryCode}</div>` : ''}
    <div class="info-row"><span class="info-label">Deliver By:</span> ${formatDate(packingList.deliveryWindow?.endDate)}</div>
  </div>

  <div class="po-list">
    <strong>Purchase Orders:</strong> ${packingList.purchaseOrders.join(', ')}
  </div>

  <table>
    <thead>
      <tr>
        <th class="line-num">#</th>
        <th>SKU</th>
        <th>EAN</th>
        <th>Description</th>
        <th class="qty">Qty</th>
        <th>UOM</th>
      </tr>
    </thead>
    <tbody>
      ${packingList.items.map(item => `
      <tr>
        <td class="line-num">${item.line}</td>
        <td>${item.sku || '-'}</td>
        <td>${item.ean || '-'}</td>
        <td>${item.description}</td>
        <td class="qty">${item.quantity}</td>
        <td>${item.unitOfMeasure}</td>
      </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="summary">
    <div class="summary-item"><span>Orders:</span> <span class="summary-value">${packingList.summary.orderCount}</span></div>
    <div class="summary-item"><span>Line Items:</span> <span class="summary-value">${packingList.summary.lineCount}</span></div>
    <div class="summary-item"><span>Total Units:</span> <span class="summary-value">${packingList.summary.totalUnits}</span></div>
  </div>

  <div class="footer">
    Generated by Agent5 - ${new Date().toISOString()}
  </div>

  <div class="no-print" style="margin-top: 20px;">
    <button onclick="window.print()" style="padding: 10px 20px; font-size: 14px; cursor: pointer;">Print Packing List</button>
  </div>
</body>
</html>`;
}

/**
 * Generate CSV packing list
 */
function generatePackingListCSV(packingList) {
  const lines = [];

  // Header info
  lines.push(`"Packing List for ${packingList.shipTo.fcName}"`);
  lines.push(`"Ship To:","${packingList.shipTo.fcPartyId}","${packingList.shipTo.fcName}"`);
  lines.push(`"Delivery By:","${packingList.deliveryWindow?.endDate ? new Date(packingList.deliveryWindow.endDate).toISOString().split('T')[0] : ''}"`);
  lines.push(`"Purchase Orders:","${packingList.purchaseOrders.join(', ')}"`);
  lines.push('');

  // Item headers
  lines.push('"Line","SKU","EAN","ASIN","Description","Quantity","UOM","PO Numbers"');

  // Items
  for (const item of packingList.items) {
    lines.push([
      item.line,
      `"${(item.sku || '').replace(/"/g, '""')}"`,
      `"${(item.ean || '').replace(/"/g, '""')}"`,
      `"${(item.asin || '').replace(/"/g, '""')}"`,
      `"${(item.description || '').replace(/"/g, '""')}"`,
      item.quantity,
      `"${item.unitOfMeasure}"`,
      `"${item.poNumbers.join(', ')}"`
    ].join(','));
  }

  // Summary
  lines.push('');
  lines.push(`"Total Orders:","${packingList.summary.orderCount}"`);
  lines.push(`"Total Lines:","${packingList.summary.lineCount}"`);
  lines.push(`"Total Units:","${packingList.summary.totalUnits}"`);

  return lines.join('\n');
}

/**
 * @route GET /api/vendor/fc-codes
 * @desc Get list of known Amazon FC codes with names
 */
router.get('/fc-codes', async (req, res) => {
  try {
    const fcList = Object.entries(FC_NAMES).map(([code, name]) => ({ code, name }));

    res.json({
      success: true,
      count: fcList.length,
      fcCodes: fcList
    });
  } catch (error) {
    console.error('[VendorAPI] GET /fc-codes error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SSCC / LABELS ====================

const { getSSCCGenerator } = require('../../services/amazon/vendor/SSCCGenerator');
const { getSSCCLabelGenerator } = require('../../services/amazon/vendor/SSCCLabelGenerator');

/**
 * @route GET /api/vendor/sscc/stats
 * @desc Get SSCC generation statistics
 */
router.get('/sscc/stats', async (req, res) => {
  try {
    const generator = await getSSCCGenerator();
    const stats = await generator.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[VendorAPI] GET /sscc/stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/sscc/generate
 * @desc Generate SSCC codes for cartons
 * @body count - Number of SSCCs to generate
 * @body type - 'carton' or 'pallet'
 * @body purchaseOrderNumber - Associated PO
 * @body shipmentId - Associated shipment
 */
router.post('/sscc/generate', async (req, res) => {
  try {
    const generator = await getSSCCGenerator();
    const { count = 1, type = 'carton', purchaseOrderNumber, shipmentId } = req.body;

    if (count > 100) {
      return res.status(400).json({ success: false, error: 'Maximum 100 SSCCs per request' });
    }

    const results = [];
    for (let i = 0; i < count; i++) {
      const result = await generator.generateSSCC({
        type,
        purchaseOrderNumber,
        shipmentId
      });
      results.push(result);
    }

    res.json({
      success: true,
      count: results.length,
      ssccs: results
    });
  } catch (error) {
    console.error('[VendorAPI] POST /sscc/generate error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/sscc/pallet
 * @desc Generate a pallet SSCC and link cartons to it
 * @body cartonSSCCs - Array of carton SSCCs to put on this pallet
 * @body purchaseOrderNumber - Associated PO
 * @body shipmentId - Associated shipment
 */
router.post('/sscc/pallet', async (req, res) => {
  try {
    const generator = await getSSCCGenerator();
    const { cartonSSCCs = [], purchaseOrderNumber, shipmentId } = req.body;

    const palletSSCC = await generator.generatePalletSSCC(cartonSSCCs, {
      purchaseOrderNumber,
      shipmentId
    });

    res.json({
      success: true,
      pallet: palletSSCC
    });
  } catch (error) {
    console.error('[VendorAPI] POST /sscc/pallet error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/sscc/:sscc
 * @desc Get SSCC details
 */
router.get('/sscc/:sscc', async (req, res) => {
  try {
    const generator = await getSSCCGenerator();
    const record = await generator.getSSCC(req.params.sscc);

    if (!record) {
      return res.status(404).json({ success: false, error: 'SSCC not found' });
    }

    res.json({
      success: true,
      sscc: record
    });
  } catch (error) {
    console.error('[VendorAPI] GET /sscc/:sscc error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route PUT /api/vendor/sscc/:sscc/contents
 * @desc Update contents of a carton/pallet
 * @body items - Array of items { sku, ean, name, quantity }
 */
router.put('/sscc/:sscc/contents', async (req, res) => {
  try {
    const generator = await getSSCCGenerator();
    const { items } = req.body;

    await generator.updateContents(req.params.sscc, items);

    res.json({
      success: true,
      message: 'Contents updated'
    });
  } catch (error) {
    console.error('[VendorAPI] PUT /sscc/:sscc/contents error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route PUT /api/vendor/sscc/:sscc/status
 * @desc Update SSCC status
 * @body status - 'generated', 'printed', 'shipped', 'received'
 */
router.put('/sscc/:sscc/status', async (req, res) => {
  try {
    const generator = await getSSCCGenerator();
    const { status } = req.body;

    await generator.updateStatus(req.params.sscc, status);

    res.json({
      success: true,
      message: `Status updated to ${status}`
    });
  } catch (error) {
    console.error('[VendorAPI] PUT /sscc/:sscc/status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/sscc/by-po/:poNumber
 * @desc Get all SSCCs for a purchase order
 */
router.get('/sscc/by-po/:poNumber', async (req, res) => {
  try {
    const generator = await getSSCCGenerator();
    const ssccs = await generator.getSSCCsByPO(req.params.poNumber);

    res.json({
      success: true,
      count: ssccs.length,
      ssccs
    });
  } catch (error) {
    console.error('[VendorAPI] GET /sscc/by-po/:poNumber error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/sscc/:sscc/label
 * @desc Generate label for an SSCC
 * @body format - 'html' (default), 'png', 'zpl'
 * @body shipTo - Ship-to information (FC)
 * @body purchaseOrders - PO numbers
 * @body items - Items in the container
 */
router.post('/sscc/:sscc/label', async (req, res) => {
  try {
    const generator = await getSSCCGenerator();
    const labelGen = await getSSCCLabelGenerator();

    const record = await generator.getSSCC(req.params.sscc);
    if (!record) {
      return res.status(404).json({ success: false, error: 'SSCC not found' });
    }

    const {
      format = 'html',
      shipTo = {},
      purchaseOrders = record.purchaseOrderNumber ? [record.purchaseOrderNumber] : [],
      items = record.contents?.items || []
    } = req.body;

    if (record.type === 'pallet') {
      // Pallet label
      const html = await labelGen.generatePalletLabelHTML({
        sscc: req.params.sscc,
        shipTo,
        purchaseOrders,
        cartonSSCCs: record.contents?.cartonSSCCs || [],
        totalUnits: items.reduce((sum, i) => sum + (i.quantity || 0), 0),
        singleSKU: items.length === 1
      });
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }

    // Carton label
    if (format === 'html') {
      const html = await labelGen.generateCartonLabelHTML({
        sscc: req.params.sscc,
        shipTo,
        purchaseOrders,
        items
      });
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }

    if (format === 'png') {
      const png = await labelGen.generateBarcodeImage(req.params.sscc);
      res.setHeader('Content-Type', 'image/png');
      return res.send(png);
    }

    if (format === 'zpl') {
      const zpl = labelGen.generateCartonLabelZPL({
        sscc: req.params.sscc,
        shipTo,
        purchaseOrders,
        items
      });
      res.setHeader('Content-Type', 'text/plain');
      return res.send(zpl);
    }

    res.status(400).json({ success: false, error: 'Invalid format. Use html, png, or zpl' });
  } catch (error) {
    console.error('[VendorAPI] POST /sscc/:sscc/label error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/sscc/labels/batch
 * @desc Generate multiple labels at once for printing
 * @body ssccs - Array of SSCC codes
 * @body shipTo - Common ship-to information
 * @body purchaseOrders - Common PO numbers
 */
router.post('/sscc/labels/batch', async (req, res) => {
  try {
    const generator = await getSSCCGenerator();
    const labelGen = await getSSCCLabelGenerator();

    const { ssccs = [], shipTo = {}, purchaseOrders = [] } = req.body;

    if (ssccs.length === 0) {
      return res.status(400).json({ success: false, error: 'No SSCCs provided' });
    }

    if (ssccs.length > 50) {
      return res.status(400).json({ success: false, error: 'Maximum 50 labels per batch' });
    }

    // Get all SSCC records
    const cartons = [];
    for (const sscc of ssccs) {
      const record = await generator.getSSCC(sscc);
      if (record && record.type === 'carton') {
        cartons.push({
          sscc,
          shipTo,
          purchaseOrders: record.purchaseOrderNumber ? [record.purchaseOrderNumber] : purchaseOrders,
          items: record.contents?.items || []
        });
      }
    }

    const html = await labelGen.generateCartonLabelsHTML(cartons);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('[VendorAPI] POST /sscc/labels/batch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/sscc/history
 * @desc Get SSCC history with filtering and pagination
 * @query type - Filter by type (carton, pallet)
 * @query status - Filter by status (active, shipped, delivered, cancelled)
 * @query search - Search by SSCC or PO number
 * @query startDate - Filter by creation date (ISO string)
 * @query endDate - Filter by creation date (ISO string)
 * @query limit - Number of results (default 50, max 500)
 * @query skip - Offset for pagination
 */
router.get('/sscc/history', async (req, res) => {
  try {
    const db = getDb();
    const ssccCollection = db.collection('sscc_codes');
    const counterCollection = db.collection('sscc_counters');

    // Build query
    const query = {};

    if (req.query.type) {
      query.type = req.query.type;
    }

    if (req.query.status) {
      query.status = req.query.status;
    }

    if (req.query.search) {
      const searchTerm = req.query.search.trim();
      query.$or = [
        { sscc: { $regex: searchTerm, $options: 'i' } },
        { purchaseOrderNumber: { $regex: searchTerm, $options: 'i' } }
      ];
    }

    if (req.query.startDate || req.query.endDate) {
      query.createdAt = {};
      if (req.query.startDate) {
        query.createdAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        query.createdAt.$lte = new Date(req.query.endDate);
      }
    }

    // Pagination
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const skip = parseInt(req.query.skip) || 0;

    // Get SSCCs with pagination
    const ssccs = await ssccCollection.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    // Get total count for pagination
    const totalCount = await ssccCollection.countDocuments(query);

    // Get stats
    const stats = await ssccCollection.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          cartons: { $sum: { $cond: [{ $eq: ['$type', 'carton'] }, 1, 0] } },
          pallets: { $sum: { $cond: [{ $eq: ['$type', 'pallet'] }, 1, 0] } },
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          shipped: { $sum: { $cond: [{ $eq: ['$status', 'shipped'] }, 1, 0] } },
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } }
        }
      }
    ]).toArray();

    // Get counter info
    const counters = await counterCollection.find({}).toArray();
    const counterInfo = {};
    for (const c of counters) {
      counterInfo[c._id] = c.seq;
    }

    res.json({
      success: true,
      gs1Prefix: '5400882',
      counters: counterInfo,
      stats: stats[0] || {
        total: 0,
        cartons: 0,
        pallets: 0,
        active: 0,
        shipped: 0,
        delivered: 0,
        cancelled: 0
      },
      pagination: {
        total: totalCount,
        limit,
        skip,
        hasMore: skip + ssccs.length < totalCount
      },
      ssccs
    });
  } catch (error) {
    console.error('[VendorAPI] GET /sscc/history error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route PATCH /api/vendor/sscc/:sscc/status
 * @desc Update SSCC status
 * @body status - New status (active, shipped, delivered, cancelled)
 */
router.patch('/sscc/:sscc/status', async (req, res) => {
  try {
    const db = getDb();
    const collection = db.collection('sscc_codes');

    const { status } = req.body;
    const validStatuses = ['active', 'shipped', 'delivered', 'cancelled'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const result = await collection.updateOne(
      { sscc: req.params.sscc },
      {
        $set: {
          status,
          updatedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: 'SSCC not found' });
    }

    res.json({ success: true, sscc: req.params.sscc, status });
  } catch (error) {
    console.error('[VendorAPI] PATCH /sscc/:sscc/status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/sscc/:sscc
 * @desc Get single SSCC details
 */
router.get('/sscc/:sscc', async (req, res) => {
  try {
    const generator = await getSSCCGenerator();
    const record = await generator.getSSCC(req.params.sscc);

    if (!record) {
      return res.status(404).json({ success: false, error: 'SSCC not found' });
    }

    res.json({ success: true, sscc: record });
  } catch (error) {
    console.error('[VendorAPI] GET /sscc/:sscc error:', error);
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
 * @route GET /api/vendor/invoices/:poNumber/validate
 * @desc Validate invoice against PO before submission
 * @param poNumber - Purchase order number
 * @query odooInvoiceId - Optional: specific Odoo invoice ID to validate
 */
router.get('/invoices/:poNumber/validate', async (req, res) => {
  try {
    const submitter = await getVendorInvoiceSubmitter();

    const result = await submitter.validateInvoiceForPO(req.params.poNumber, {
      odooInvoiceId: req.query.odooInvoiceId ? parseInt(req.query.odooInvoiceId) : null
    });

    res.json({
      success: result.errors.length === 0,
      ...result
    });
  } catch (error) {
    console.error('[VendorAPI] GET /invoices/:poNumber/validate error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/invoices/validate-batch
 * @desc Validate multiple invoices at once
 * @body poNumbers - Array of PO numbers to validate
 */
router.post('/invoices/validate-batch', async (req, res) => {
  try {
    const submitter = await getVendorInvoiceSubmitter();
    const { poNumbers = [] } = req.body;

    if (poNumbers.length === 0) {
      return res.status(400).json({ success: false, error: 'No PO numbers provided' });
    }

    if (poNumbers.length > 50) {
      return res.status(400).json({ success: false, error: 'Maximum 50 POs per batch' });
    }

    const results = [];
    let valid = 0;
    let invalid = 0;
    let noInvoice = 0;

    for (const poNumber of poNumbers) {
      const result = await submitter.validateInvoiceForPO(poNumber);
      results.push(result);

      if (!result.hasInvoice) {
        noInvoice++;
      } else if (result.validation?.isValid) {
        valid++;
      } else {
        invalid++;
      }
    }

    res.json({
      success: true,
      summary: {
        total: poNumbers.length,
        valid,
        invalid,
        noInvoice
      },
      results
    });
  } catch (error) {
    console.error('[VendorAPI] POST /invoices/validate-batch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/invoices/:poNumber/submit
 * @desc Submit invoice to Amazon for a PO
 * @body odooInvoiceId - Optional: specific Odoo invoice ID to use
 * @body dryRun - Optional: simulate without sending (default false)
 * @body skipValidation - Optional: skip validation checks (default false)
 * @body forceSubmit - Optional: submit even with validation errors (default false)
 */
router.post('/invoices/:poNumber/submit', async (req, res) => {
  try {
    const submitter = await getVendorInvoiceSubmitter();

    const result = await submitter.submitInvoice(req.params.poNumber, {
      odooInvoiceId: req.body.odooInvoiceId || null,
      dryRun: req.body.dryRun || false,
      skipValidation: req.body.skipValidation || false,
      forceSubmit: req.body.forceSubmit || false
    });

    if (!result.success && result.errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: result.errors,
        warnings: result.warnings,
        validation: result.validation
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
      validation: result.validation,
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

// ==================== TEST MODE ====================

/**
 * @route GET /api/vendor/test-mode
 * @desc Get current test mode status
 */
router.get('/test-mode', (req, res) => {
  res.json({
    success: true,
    testMode: getTestModeStatus()
  });
});

/**
 * @route POST /api/vendor/test-mode/enable
 * @desc Enable test mode - mocks all Amazon API calls
 */
router.post('/test-mode/enable', (req, res) => {
  const user = req.body.user || 'api';
  const status = enableTestMode(user);

  res.json({
    success: true,
    message: 'Test mode ENABLED - All Amazon API calls will be mocked',
    testMode: status
  });
});

/**
 * @route POST /api/vendor/test-mode/disable
 * @desc Disable test mode - resume normal Amazon API calls
 */
router.post('/test-mode/disable', (req, res) => {
  const result = disableTestMode();

  res.json({
    success: true,
    message: 'Test mode DISABLED - Normal Amazon API calls resumed',
    wasEnabled: result.wasEnabled,
    duration: result.duration
  });
});

/**
 * @route POST /api/vendor/test-mode/generate-pos
 * @desc Generate test POs from historical data
 * @body count - Number of test POs to generate (default 5)
 */
router.post('/test-mode/generate-pos', async (req, res) => {
  try {
    if (!isTestMode()) {
      return res.status(400).json({
        success: false,
        error: 'Test mode must be enabled to generate test POs'
      });
    }

    const count = parseInt(req.body.count) || 5;
    const result = await generateTestPOs(count);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /test-mode/generate-pos error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/test-mode/cleanup
 * @desc Clean up all test data (POs marked with _testData: true)
 */
router.post('/test-mode/cleanup', async (req, res) => {
  try {
    const result = await cleanupTestData();

    res.json({
      success: true,
      message: `Cleaned up ${result.deleted} test records`,
      ...result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /test-mode/cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
