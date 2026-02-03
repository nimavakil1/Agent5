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
const { OdooDirectClient, getCachedOdooClient } = require('../../core/agents/integrations/OdooMCP');

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
  PO_STATES: _PO_STATES,
  ACK_CODES,
  MARKETPLACE_WAREHOUSE: _MARKETPLACE_WAREHOUSE,
  CHARGEBACK_TYPES: _CHARGEBACK_TYPES,
  DISPUTE_STATUS: _DISPUTE_STATUS,
  PAYMENT_STATUS: _PAYMENT_STATUS,
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

/**
 * Vendor Groups Configuration
 *
 * Orders can only be consolidated within the same vendor group.
 * This is because each vendor account must submit its own ASN to Amazon.
 *
 * Group 'EU': NL + DE accounts (Pan-EU fulfillment)
 * Group 'FR': FR account only (France-specific)
 */
const VENDOR_GROUPS = {
  EU: {
    name: 'Pan-EU (NL/DE)',
    marketplaces: ['NL', 'DE'],
    vendorCodes: ['HN6VB', '5O6JS'] // NL and DE vendor codes
  },
  FR: {
    name: 'France',
    marketplaces: ['FR'],
    vendorCodes: ['C86K8'] // FR vendor code
  }
};

/**
 * Get vendor group for a marketplace code
 * @param {string} marketplaceCode - e.g., 'NL', 'DE', 'FR'
 * @returns {string} Vendor group code ('EU' or 'FR')
 */
function getVendorGroup(marketplaceCode) {
  for (const [groupCode, group] of Object.entries(VENDOR_GROUPS)) {
    if (group.marketplaces.includes(marketplaceCode)) {
      return groupCode;
    }
  }
  // Default to marketplace code if not in a group
  return marketplaceCode || 'UNKNOWN';
}

/**
 * Get vendor group name for display
 * @param {string} groupCode - e.g., 'EU', 'FR'
 * @returns {string} Human-readable group name
 */
function getVendorGroupName(groupCode) {
  return VENDOR_GROUPS[groupCode]?.name || groupCode;
}

// ==================== PRODUCT PACKAGING ====================

/**
 * @route GET /api/vendor/products/:sku/packaging
 * @desc Get packaging info for a product from MongoDB
 * @param sku - Product SKU
 */
router.get('/products/:sku/packaging', async (req, res) => {
  try {
    const db = getDb();
    const { sku } = req.params;

    // Find product by SKU in MongoDB products collection
    const product = await db.collection('products').findOne({ sku });

    if (!product) {
      return res.json({ success: true, packaging: [] });
    }

    // Return packaging array, sorted by qty descending
    const packaging = (product.packaging || [])
      .map(p => ({
        name: p.name,
        qty: p.qty
      }))
      .sort((a, b) => b.qty - a.qty);

    res.json({ success: true, packaging });
  } catch (error) {
    console.error('Product packaging fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

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
        // Map unified schema to API response format
        purchaseOrderNumber: o.sourceIds?.amazonVendorPONumber || o.purchaseOrderNumber,
        marketplaceId: o.marketplace?.code || o.marketplaceId,
        purchaseOrderState: o.amazonVendor?.purchaseOrderState || o.purchaseOrderState,
        purchaseOrderType: o.amazonVendor?.purchaseOrderType || o.purchaseOrderType,
        purchaseOrderDate: o.orderDate || o.purchaseOrderDate,
        deliveryWindow: o.amazonVendor?.deliveryWindow || o.deliveryWindow,
        shipmentStatus: o.amazonVendor?.shipmentStatus || o.shipmentStatus,
        totals: o.totals,
        acknowledgment: o.amazonVendor?.acknowledgment || o.acknowledgment,
        odoo: o.odoo,
        itemCount: o.items?.length || 0
      }))
    });
  } catch (error) {
    console.error('[VendorAPI] GET /orders error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// CONSOLIDATION ROUTES - Must be defined before :poNumber wildcard route
// =============================================================================

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
    // Sync shipment status from Odoo before loading consolidation data
    // This ensures we show accurate delivery status (takes ~600-1000ms)
    try {
      const importer = await getVendorPOImporter();
      await importer.syncShipmentStatusFromOdoo({ limit: 100 });
    } catch (syncError) {
      console.warn('[VendorAPI] Consolidate sync warning:', syncError.message);
      // Continue even if sync fails - show potentially stale data
    }

    const db = getDb();
    // IMPORTANT: Use unified_orders collection (same as VendorPOImporter)
    const collection = db.collection('unified_orders');

    // Build filter - default to orders ready to ship
    // Include both New and Acknowledged states for consolidation
    // Filter for not_shipped status - exclude fully_shipped and cancelled
    // IMPORTANT: Exclude orders already shipped in Odoo (deliveryStatus = 'full')
    //
    // Status filter:
    // - 'open' (default): Only show orders not yet shipped (not_shipped, odoo not full)
    // - 'all': Show all orders including completed ones
    const statusFilter = req.query.status || 'open';
    const shipmentStatusFilter = req.query.shipmentStatus || 'not_shipped';

    const query = {
      // Only vendor orders (note: hyphen not underscore)
      channel: 'amazon-vendor'
    };

    // Apply filters based on status
    if (statusFilter === 'open') {
      // Default: only show open orders
      query['amazonVendor.shipmentStatus'] = shipmentStatusFilter;
      query['odoo.deliveryStatus'] = { $ne: 'full' };
    }
    // For 'all', we don't add shipmentStatus or deliveryStatus filters

    // State filter - default to both New and Acknowledged (using unified schema)
    if (req.query.state) {
      query['amazonVendor.purchaseOrderState'] = req.query.state;
    } else {
      query['amazonVendor.purchaseOrderState'] = { $in: ['New', 'Acknowledged'] };
    }

    if (req.query.marketplace) {
      query['marketplace.code'] = req.query.marketplace.toUpperCase();
    }

    // PO number search filter (case-insensitive partial match)
    const poSearch = req.query.po?.trim();

    // CRITICAL: Isolate test data from production data
    if (isTestMode()) {
      query._testData = true; // In test mode, ONLY show test data
      // Add PO filter if provided
      if (poSearch) {
        query['sourceIds.amazonVendorPONumber'] = { $regex: poSearch, $options: 'i' };
      }
    } else {
      query._testData = { $ne: true }; // In production, exclude test data
      // Combine TST exclusion with optional PO search using $and
      if (poSearch) {
        query.$and = [
          { 'sourceIds.amazonVendorPONumber': { $not: /^TST/ } },
          { 'sourceIds.amazonVendorPONumber': { $regex: poSearch, $options: 'i' } }
        ];
      } else {
        // Just exclude TST orders
        query['sourceIds.amazonVendorPONumber'] = { $not: /^TST/ };
      }
    }

    // Get orders
    console.log('[VendorAPI] Consolidate query:', JSON.stringify(query));
    const orders = await collection.find(query)
      .sort({ 'amazonVendor.deliveryWindow.endDate': 1, 'amazonVendor.shipToParty.partyId': 1 })
      .toArray();
    console.log('[VendorAPI] Found', orders.length, 'orders for consolidation');

    // Group by VENDOR GROUP + FC + delivery window end date
    // CRITICAL: Orders from different vendor groups cannot be consolidated
    // because each vendor account must submit its own ASN to Amazon
    const groups = {};

    for (const order of orders) {
      // Use unified schema field paths
      const poNumber = order.sourceIds?.amazonVendorPONumber || order.purchaseOrderNumber;
      const partyId = order.amazonVendor?.shipToParty?.partyId || 'UNKNOWN';
      const deliveryEnd = order.amazonVendor?.deliveryWindow?.endDate;
      const marketplaceCode = order.marketplace?.code || 'UNKNOWN';
      const vendorGroup = getVendorGroup(marketplaceCode);

      // If order has a consolidationOverride, it gets its own separate group
      const groupId = order.amazonVendor?.consolidationOverride
        ? `${createConsolidationGroupId(vendorGroup, partyId, deliveryEnd)}_SEP_${poNumber}`
        : createConsolidationGroupId(vendorGroup, partyId, deliveryEnd);

      if (!groups[groupId]) {
        groups[groupId] = {
          groupId,
          vendorGroup,
          vendorGroupName: getVendorGroupName(vendorGroup),
          fcPartyId: partyId,
          fcName: getFCName(partyId, order.amazonVendor?.shipToParty?.address),
          fcCountry: getFCCountry(partyId),
          fcAddress: order.amazonVendor?.shipToParty?.address || null,
          deliveryWindow: order.amazonVendor?.deliveryWindow,
          marketplace: order.marketplace?.code,
          orders: [],
          totalItems: 0,
          totalUnits: 0,
          totalAmount: 0,
          currency: 'EUR'
        };
      }

      const group = groups[groupId];
      group.orders.push({
        purchaseOrderNumber: poNumber,
        purchaseOrderDate: order.orderDate,
        itemCount: order.items?.length || 0,
        totals: order.totals,
        odoo: order.odoo
      });

      group.totalItems += order.items?.length || 0;
      // Calculate units and amount from items - use acknowledgeQty (accepted) if available
      let orderUnits = 0;
      let orderAmount = 0;
      for (const item of (order.items || [])) {
        const qty = item.acknowledgeQty ?? item.orderedQuantity?.amount ?? item.quantity ?? 0;
        const unitPrice = parseFloat(item.netCost?.amount) || 0;
        orderUnits += qty;
        orderAmount += qty * unitPrice;
      }
      group.totalUnits += orderUnits;
      group.totalAmount += orderAmount;
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
 * @route POST /api/vendor/orders/consolidation/remove
 * @desc Remove a PO from its consolidation group (creates separate shipment)
 */
router.post('/orders/consolidation/remove', async (req, res) => {
  try {
    const { groupId, poNumber } = req.body;

    if (!poNumber) {
      return res.status(400).json({ success: false, error: 'PO number required' });
    }

    const db = getDb();

    // Find the order in unified_orders collection
    const order = await db.collection('unified_orders').findOne({
      'sourceIds.amazonVendorPONumber': poNumber
    });
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Set consolidationOverride to force separate group
    await db.collection('unified_orders').updateOne(
      { 'sourceIds.amazonVendorPONumber': poNumber },
      {
        $set: {
          'amazonVendor.consolidationOverride': true,
          'amazonVendor.consolidationOverrideAt': new Date(),
          'amazonVendor.consolidationOverrideReason': `Removed from group ${groupId}`
        }
      }
    );

    console.log(`[VendorAPI] PO ${poNumber} removed from consolidation group ${groupId}`);

    res.json({
      success: true,
      message: `PO ${poNumber} will now ship separately`,
      poNumber
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/consolidation/remove error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/consolidation/restore
 * @desc Restore a PO to its original consolidation group
 */
router.post('/orders/consolidation/restore', async (req, res) => {
  try {
    const { poNumber } = req.body;

    if (!poNumber) {
      return res.status(400).json({ success: false, error: 'PO number required' });
    }

    const db = getDb();

    // Remove consolidationOverride from unified_orders
    await db.collection('unified_orders').updateOne(
      { 'sourceIds.amazonVendorPONumber': poNumber },
      {
        $unset: {
          'amazonVendor.consolidationOverride': '',
          'amazonVendor.consolidationOverrideAt': '',
          'amazonVendor.consolidationOverrideReason': ''
        }
      }
    );

    console.log(`[VendorAPI] PO ${poNumber} restored to original consolidation`);

    res.json({
      success: true,
      message: `PO ${poNumber} restored to original consolidation`,
      poNumber
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/consolidation/restore error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/orders/consolidate/:groupId
 * @desc Get detailed view of a consolidation group with all items
 */
router.get('/orders/consolidate/:groupId', async (req, res) => {
  try {
    // Sync shipment status from Odoo to ensure consistency with main list
    // This ensures the detail view shows the same orders as the header
    try {
      const importer = await getVendorPOImporter();
      await importer.syncShipmentStatusFromOdoo({ limit: 50 });
    } catch (syncError) {
      console.warn('[VendorAPI] Consolidate detail sync warning:', syncError.message);
      // Continue even if sync fails
    }

    const db = getDb();
    // Use unified_orders collection (same as VendorPOImporter)
    const collection = db.collection('unified_orders');

    const groupId = req.params.groupId;
    let query;

    // Parse the group ID to extract components
    const parsed = parseConsolidationGroupId(groupId);
    const { vendorGroup, fcPartyId, dateStr, isSeparate, poNumber } = parsed;

    console.log('[VendorAPI] Consolidate detail - parsed:', JSON.stringify(parsed));

    // Status filter: 'open' (default) or 'all' (include completed)
    const statusFilter = req.query.status || 'open';

    if (isSeparate) {
      // Separate/override group - query for that specific PO
      query = {
        channel: 'amazon-vendor',
        'sourceIds.amazonVendorPONumber': poNumber,
        'amazonVendor.consolidationOverride': true,
        'amazonVendor.purchaseOrderState': { $in: ['New', 'Acknowledged'] }
      };

      // Only filter by shipment/delivery status if status=open
      if (statusFilter === 'open') {
        query['amazonVendor.shipmentStatus'] = 'not_shipped';
        query['odoo.deliveryStatus'] = { $ne: 'full' };
      }

      console.log('[VendorAPI] Consolidate detail (SEPARATE) - groupId:', groupId, 'poNumber:', poNumber, 'status:', statusFilter);
    } else {
      if (!fcPartyId) {
        return res.status(400).json({ success: false, error: 'Invalid group ID' });
      }

      // CRITICAL: Use SAME filters as main consolidation list for consistency
      // This ensures header stats match expanded details
      query = {
        channel: 'amazon-vendor',
        'amazonVendor.shipToParty.partyId': fcPartyId,
        'amazonVendor.consolidationOverride': { $ne: true },
        'amazonVendor.purchaseOrderState': { $in: ['New', 'Acknowledged'] }
      };

      // Only filter by shipment/delivery status if status=open
      if (statusFilter === 'open') {
        query['amazonVendor.shipmentStatus'] = 'not_shipped';
        query['odoo.deliveryStatus'] = { $ne: 'full' };
      }

      // CRITICAL: Filter by vendor group to ensure only orders from same group are shown
      // Orders from different vendor groups cannot be consolidated (different ASNs)
      if (vendorGroup && VENDOR_GROUPS[vendorGroup]) {
        query['marketplace.code'] = { $in: VENDOR_GROUPS[vendorGroup].marketplaces };
      }

      console.log('[VendorAPI] Consolidate detail - groupId:', groupId, 'vendorGroup:', vendorGroup, 'fcPartyId:', fcPartyId, 'dateStr:', dateStr);
    }

    // CRITICAL: Isolate test data from production data
    if (isTestMode()) {
      query._testData = true;
    } else {
      query._testData = { $ne: true };
      // Only add TST exclusion if NOT a separate group (separate groups already have specific PO filter)
      if (!isSeparate) {
        query['sourceIds.amazonVendorPONumber'] = { $not: /^TST/ };
      }
    }

    // Add date filter if present - use UTC to match database dates
    if (!isSeparate && dateStr && dateStr !== 'nodate') {
      const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
      const endOfDay = new Date(dateStr + 'T00:00:00.000Z');
      endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
      query['amazonVendor.deliveryWindow.endDate'] = { $gte: startOfDay, $lt: endOfDay };
    }

    console.log('[VendorAPI] Consolidate detail query:', JSON.stringify(query));
    console.log('[VendorAPI] Date range:', dateStr, '- startOfDay:', query['amazonVendor.deliveryWindow.endDate']?.$gte, 'endOfDay:', query['amazonVendor.deliveryWindow.endDate']?.$lt);
    const orders = await collection.find(query)
      .sort({ 'sourceIds.amazonVendorPONumber': 1 })
      .toArray();

    if (orders.length === 0) {
      return res.status(404).json({ success: false, error: 'No orders found for this group' });
    }

    // Consolidate all items across orders
    const itemMap = {}; // Key by product identifier
    const consolidatedItems = [];

    // Collect all SKUs to look up weights from products collection
    const allSkus = new Set();
    for (const order of orders) {
      for (const item of (order.items || [])) {
        if (item.odooSku) allSkus.add(item.odooSku);
      }
    }

    // Fetch product weights from MongoDB
    const productWeights = {};
    if (allSkus.size > 0) {
      const products = await db.collection('products').find(
        { sku: { $in: Array.from(allSkus) } },
        { projection: { sku: 1, weight: 1 } }
      ).toArray();
      for (const p of products) {
        if (p.weight) productWeights[p.sku] = p.weight;
      }
    }

    for (const order of orders) {
      for (const item of (order.items || [])) {
        const key = item.vendorProductIdentifier || item.amazonProductIdentifier;

        if (!itemMap[key]) {
          // Get weight: first from item, then from products collection, then default to 0
          const sku = item.odooSku || item.sku || item.vendorProductIdentifier;
          const weight = item.weight || (sku && productWeights[sku]) || 0;

          // Fallbacks for SKU and product name when odoo data is not available
          const displaySku = item.odooSku || item.sku || item.vendorProductIdentifier || '-';
          const displayName = item.odooProductName || item.name || item.title ||
            (item.vendorProductIdentifier ? `Product ${item.vendorProductIdentifier}` : '-');

          itemMap[key] = {
            vendorProductIdentifier: item.vendorProductIdentifier,
            amazonProductIdentifier: item.amazonProductIdentifier,
            odooProductId: item.odooProductId,
            odooProductName: displayName,
            odooSku: displaySku,
            odooBarcode: item.odooBarcode, // Real EAN from Odoo
            totalQty: 0,
            weight, // Unit weight from item, products collection, or 0
            netCost: item.netCost,
            orders: []
          };
          consolidatedItems.push(itemMap[key]);
        }

        // Use acknowledgeQty (accepted quantity) if available, not orderedQuantity
        const qty = item.acknowledgeQty ?? item.orderedQuantity?.amount ?? item.quantity ?? 0;
        itemMap[key].totalQty += qty;
        itemMap[key].orders.push({
          purchaseOrderNumber: order.sourceIds?.amazonVendorPONumber || order.purchaseOrderNumber,
          qty,
          itemSequenceNumber: item.itemSequenceNumber
        });
      }
    }

    // Sort items by total quantity (most first)
    consolidatedItems.sort((a, b) => b.totalQty - a.totalQty);

    const firstOrder = orders[0];
    const actualVendorGroup = vendorGroup || getVendorGroup(firstOrder.marketplace?.code);

    res.json({
      success: true,
      groupId: req.params.groupId,
      vendorGroup: actualVendorGroup,
      vendorGroupName: getVendorGroupName(actualVendorGroup),
      fcPartyId,
      fcName: getFCName(fcPartyId, firstOrder.amazonVendor?.shipToParty?.address),
      fcAddress: firstOrder.amazonVendor?.shipToParty?.address || null,
      deliveryWindow: firstOrder.amazonVendor?.deliveryWindow,
      orderCount: orders.length,
      orders: orders.map(o => ({
        purchaseOrderNumber: o.sourceIds?.amazonVendorPONumber || o.purchaseOrderNumber,
        purchaseOrderDate: o.orderDate || o.purchaseOrderDate,
        marketplaceId: o.marketplace?.code || o.marketplaceId,
        itemCount: o.items?.length || 0,
        totals: o.totals,
        odoo: o.odoo
      })),
      consolidatedItems,
      summary: {
        totalItems: consolidatedItems.length,
        totalUnits: consolidatedItems.reduce((sum, i) => sum + i.totalQty, 0),
        // Calculate amount from accepted quantities × unit price
        totalAmount: consolidatedItems.reduce((sum, i) =>
          sum + (i.totalQty * (parseFloat(i.netCost?.amount) || 0)), 0)
      }
    });
  } catch (error) {
    console.error('[VendorAPI] GET /orders/consolidate/:groupId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// WILDCARD ROUTE - Must come after specific routes
// =============================================================================

/**
 * @route GET /api/vendor/orders/:poNumber
 * @desc Get a specific purchase order with full details
 */
router.get('/orders/:poNumber', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const o = await importer.getPurchaseOrder(req.params.poNumber);

    if (!o) {
      return res.status(404).json({ success: false, error: 'Purchase order not found' });
    }

    // Map unified schema to API response format
    // Transform items to expected format (unified -> legacy field names)
    const transformedItems = (o.items || []).map(item => ({
      // Keep original item data for backwards compatibility
      ...item,
      // Map unified fields to expected legacy format
      vendorProductIdentifier: item.vendorProductIdentifier || item.ean || item.sku,
      amazonProductIdentifier: item.amazonProductIdentifier || item.asin,
      orderedQuantity: item.orderedQuantity || { amount: item.quantity || 0, unitOfMeasure: 'Each' },
      netCost: item.netCost || { amount: item.unitPrice || 0, currencyCode: o.totals?.currency || 'EUR' },
      // Preserve any existing odoo product info (don't fallback to item.name which may be "ASIN: xxx" placeholder)
      odooSku: item.odooSku || item.sku,
      odooProductName: item.odooProductName || null,
      odooProductId: item.odooProductId
    }));

    const order = {
      purchaseOrderNumber: o.sourceIds?.amazonVendorPONumber || o.purchaseOrderNumber,
      marketplaceId: o.marketplace?.code || o.marketplaceId,
      purchaseOrderState: o.amazonVendor?.purchaseOrderState || o.purchaseOrderState,
      purchaseOrderType: o.amazonVendor?.purchaseOrderType || o.purchaseOrderType,
      purchaseOrderDate: o.orderDate || o.purchaseOrderDate,
      deliveryWindow: o.amazonVendor?.deliveryWindow || o.deliveryWindow,
      shipmentStatus: o.amazonVendor?.shipmentStatus || o.shipmentStatus,
      totals: o.totals,
      acknowledgment: o.amazonVendor?.acknowledgment || o.acknowledgment,
      odoo: o.odoo,
      items: transformedItems,
      buyingParty: o.amazonVendor?.buyingParty || o.buyingParty,
      sellingParty: o.amazonVendor?.sellingParty || o.sellingParty,
      shipToParty: o.amazonVendor?.shipToParty || o.shipToParty,
      billToParty: o.amazonVendor?.billToParty || o.billToParty,
      shipments: o.amazonVendor?.shipments || o.shipments || []
    };

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
 * @route POST /api/vendor/orders/sync-shipment-status
 * @desc Sync shipment status from Odoo pickings
 * Checks if orders have been delivered in Odoo and updates shipmentStatus
 */
router.post('/orders/sync-shipment-status', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const result = await importer.syncShipmentStatusFromOdoo({
      limit: req.body.limit || 500
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/sync-shipment-status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/orders/sync-invoices
 * @desc Sync invoice data from Odoo to MongoDB
 * Links Odoo invoices to MongoDB vendor_purchase_orders
 */
router.post('/orders/sync-invoices', async (req, res) => {
  try {
    const importer = await getVendorPOImporter();
    const result = await importer.syncInvoicesFromOdoo({
      limit: req.body.limit || 500
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/sync-invoices error:', error);
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
      dryRun: req.body.dryRun || false,
      force: req.body.force || false  // Allow re-acknowledgment for qty updates
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
 * @route POST /api/vendor/orders/:poNumber/update-odoo
 * @desc Update an existing Odoo order with new quantities from MongoDB
 * @desc Used when quantities are changed after initial acknowledgment
 */
router.post('/orders/:poNumber/update-odoo', async (req, res) => {
  try {
    const creator = await getVendorOrderCreator();

    const result = await creator.updateOrder(req.params.poNumber);

    if (!result.success && result.errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: result.errors,
        warnings: result.warnings
      });
    }

    res.json({
      success: true,
      updated: result.updated,
      purchaseOrderNumber: result.purchaseOrderNumber,
      odooOrderId: result.odooOrderId,
      odooOrderName: result.odooOrderName,
      linesUpdated: result.linesUpdated,
      linesRemoved: result.linesRemoved,
      warnings: result.warnings
    });
  } catch (error) {
    console.error('[VendorAPI] POST /orders/:poNumber/update-odoo error:', error);
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

// Cache for warehouse ID (CW) - avoids repeated lookups
let cachedWarehouseId = null;

/**
 * @route POST /api/vendor/orders/:poNumber/check-stock
 * @desc Check Odoo stock levels for PO items and update the PO with product info
 * @body warehouseCode - Optional: warehouse code to check (default from marketplace config)
 *
 * OPTIMIZATIONS:
 * 1. Uses cached Odoo client (avoids re-authentication)
 * 2. Uses cached warehouse ID
 * 3. Uses cached product mappings if already stored in PO
 * 4. Batch searches products by EAN/barcode instead of individual queries
 * 5. Batch fetches stock quants for all products at once
 */
router.post('/orders/:poNumber/check-stock', async (req, res) => {
  const startTime = Date.now();
  const timings = {};

  try {
    let t0 = Date.now();
    const importer = await getVendorPOImporter();
    const po = await importer.getPurchaseOrder(req.params.poNumber);
    timings.getPO = Date.now() - t0;

    if (!po) {
      return res.status(404).json({ success: false, error: 'Purchase order not found' });
    }

    // Always use Central Warehouse (CW) for stock checks
    const warehouseCode = 'CW';

    // Get cached Odoo client (reuses authenticated session)
    t0 = Date.now();
    const odoo = await getCachedOdooClient();
    timings.odooAuth = Date.now() - t0;

    // Find Central Warehouse in Odoo (cached)
    t0 = Date.now();
    if (!cachedWarehouseId) {
      const warehouses = await odoo.search('stock.warehouse', [['code', '=', warehouseCode]], { limit: 1 });
      cachedWarehouseId = warehouses.length > 0 ? warehouses[0] : null;
    }
    const warehouseId = cachedWarehouseId;
    timings.warehouseLookup = Date.now() - t0;

    if (!warehouseId) {
      return res.status(500).json({ success: false, error: 'Central Warehouse (CW) not found in Odoo' });
    }

    const productInfoList = [];
    const errors = [];

    // Separate items into cached (have odooProductId) and uncached
    // Handle both unified schema (ean, asin) and legacy schema (vendorProductIdentifier, amazonProductIdentifier)
    const cachedItems = [];
    const uncachedItems = [];

    for (const item of po.items || []) {
      // Unified schema uses ean/asin, legacy uses vendorProductIdentifier/amazonProductIdentifier
      const ean = item.ean || item.vendorProductIdentifier;
      const asin = item.asin || item.amazonProductIdentifier;

      if (item.odooProductId) {
        cachedItems.push({ ...item, _ean: ean, _asin: asin });
      } else if (ean || asin) {
        uncachedItems.push({ ...item, _ean: ean, _asin: asin });
      } else {
        errors.push({ itemSequenceNumber: item.itemSequenceNumber, error: 'No EAN or ASIN' });
      }
    }

    // Map of vendorProductIdentifier -> product data
    const productMap = new Map();

    // For cached items, we already have the product info
    for (const item of cachedItems) {
      productMap.set(item._ean, {
        id: item.odooProductId,
        name: item.odooProductName,
        default_code: item.odooSku,
        barcode: item.odooBarcode
      });
    }

    // BATCH SEARCH: For uncached items, search by EAN/barcode in one query
    if (uncachedItems.length > 0) {
      t0 = Date.now();
      const eans = uncachedItems.map(it => it._ean).filter(Boolean);
      const asins = uncachedItems.map(it => it._asin).filter(Boolean);
      const allIdentifiers = [...new Set([...eans, ...asins])];

      if (allIdentifiers.length > 0) {
        // Search by barcode (batch)
        const productsByBarcode = await odoo.searchRead('product.product',
          [['barcode', 'in', allIdentifiers]],
          ['id', 'name', 'default_code', 'barcode']
        );

        // Index by barcode for quick lookup
        const barcodeIndex = new Map();
        for (const p of productsByBarcode) {
          if (p.barcode) barcodeIndex.set(p.barcode, p);
        }

        // Find products not found by barcode, try by default_code
        const notFoundEans = eans.filter(ean => !barcodeIndex.has(ean));
        if (notFoundEans.length > 0) {
          const productsBySku = await odoo.searchRead('product.product',
            [['default_code', 'in', notFoundEans]],
            ['id', 'name', 'default_code', 'barcode']
          );
          for (const p of productsBySku) {
            if (p.default_code && !barcodeIndex.has(p.default_code)) {
              barcodeIndex.set(p.default_code, p);
            }
          }
        }

        // Map each item to its product
        for (const item of uncachedItems) {
          const ean = item._ean;
          const asin = item._asin;

          let productData = barcodeIndex.get(ean) || barcodeIndex.get(asin);

          if (productData) {
            productMap.set(ean, productData);
          } else {
            errors.push({ itemSequenceNumber: item.itemSequenceNumber, ean, asin, error: 'Product not found in Odoo' });
            productMap.set(ean, null);
          }
        }
      }
      timings.productSearch = Date.now() - t0;
    }

    // BATCH STOCK QUERY: Get stock for all products at once
    t0 = Date.now();
    const productIds = [...productMap.values()].filter(p => p?.id).map(p => p.id);
    const stockByProductId = new Map();

    if (productIds.length > 0) {
      const quants = await odoo.searchRead('stock.quant',
        [
          ['product_id', 'in', productIds],
          ['location_id.usage', '=', 'internal'],
          ['location_id.warehouse_id', '=', warehouseId]
        ],
        ['product_id', 'quantity', 'reserved_quantity'],
        { limit: 1000 }
      );

      // Aggregate stock by product
      for (const q of quants) {
        const prodId = q.product_id[0];
        const available = (q.quantity || 0) - (q.reserved_quantity || 0);
        stockByProductId.set(prodId, (stockByProductId.get(prodId) || 0) + available);
      }
    }
    timings.stockQuery = Date.now() - t0;

    // Build product info list
    for (const item of po.items || []) {
      // Handle unified schema (ean) and legacy (vendorProductIdentifier)
      const ean = item.ean || item.vendorProductIdentifier;
      if (!ean) continue;

      const productData = productMap.get(ean);

      if (productData) {
        const qtyAvailable = Math.max(0, stockByProductId.get(productData.id) || 0);
        productInfoList.push({
          vendorProductIdentifier: ean,
          odooProductId: productData.id,
          odooProductName: productData.name,
          odooSku: productData.default_code,
          odooBarcode: productData.barcode,
          qtyAvailable
        });
      } else {
        productInfoList.push({
          vendorProductIdentifier: ean,
          odooProductId: null,
          odooProductName: null,
          qtyAvailable: 0
        });
      }
    }

    // Update PO with product info (cache for next time)
    t0 = Date.now();
    if (productInfoList.length > 0) {
      await importer.updateItemsProductInfo(req.params.poNumber, productInfoList);
    }

    // Get updated PO
    const updatedPO = await importer.getPurchaseOrder(req.params.poNumber);
    timings.dbUpdate = Date.now() - t0;

    timings.total = Date.now() - startTime;
    timings.cachedItems = cachedItems.length;
    timings.uncachedItems = uncachedItems.length;

    console.log(`[VendorAPI] check-stock ${req.params.poNumber}: ${JSON.stringify(timings)}`);

    res.json({
      success: true,
      purchaseOrderNumber: req.params.poNumber,
      warehouseCode,
      itemsChecked: productInfoList.length,
      timings, // Include timings in response for debugging
      errors: errors.length > 0 ? errors : undefined,
      items: updatedPO.items.map(item => ({
        itemSequenceNumber: item.itemSequenceNumber,
        // Handle unified schema (ean/asin) and legacy (vendorProductIdentifier/amazonProductIdentifier)
        vendorProductIdentifier: item.ean || item.vendorProductIdentifier,
        amazonProductIdentifier: item.asin || item.amazonProductIdentifier,
        orderedQty: item.orderedQuantity?.amount || item.quantity || 0,
        odooProductId: item.odooProductId,
        odooProductName: item.odooProductName || null,
        odooSku: item.odooSku || item.sku,
        odooBarcode: item.odooBarcode,
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
 * Get FC address from Amazon order data
 * Simply returns the address from the order's shipToParty
 */
function getFCAddress(orderAddress) {
  if (!orderAddress) {
    return null;
  }
  // Return the address as-is from the Amazon order
  return orderAddress;
}

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
 * Get country code from FC party ID
 */
function getFCCountry(partyId) {
  if (!partyId) return null;
  const upper = partyId.toUpperCase();
  const fcName = FC_NAMES[upper];
  if (fcName) {
    // Extract country code from "Amazon XX - City" format
    const match = fcName.match(/Amazon\s+(\w+)\s+-/);
    if (match) return match[1];
  }
  return null;
}

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
 * Create a group ID from vendor group, FC party ID and delivery window
 * Format: {vendorGroup}_{fcCode}_{date}
 * Example: EU_CDG7_2026-01-19, FR_CDG7_2026-01-19
 */
function createConsolidationGroupId(vendorGroup, partyId, deliveryWindowEnd) {
  const vg = vendorGroup || 'UNKNOWN';
  const fcCode = partyId?.toUpperCase() || 'UNKNOWN';
  const dateStr = deliveryWindowEnd
    ? new Date(deliveryWindowEnd).toISOString().split('T')[0]
    : 'nodate';
  return `${vg}_${fcCode}_${dateStr}`;
}

/**
 * Parse a consolidation group ID to extract components
 * @param {string} groupId - e.g., 'EU_CDG7_2026-01-19' or 'FR_CDG7_2026-01-19_SEP_PONUM'
 * @returns {Object} { vendorGroup, fcPartyId, dateStr, isSeparate, poNumber }
 */
function parseConsolidationGroupId(groupId) {
  // Check for _SEP_ (separated order)
  const isSeparate = groupId.includes('_SEP_');
  let baseGroupId = groupId;
  let poNumber = null;

  if (isSeparate) {
    const sepIndex = groupId.indexOf('_SEP_');
    poNumber = groupId.substring(sepIndex + 5);
    baseGroupId = groupId.substring(0, sepIndex);
  }

  // Parse: vendorGroup_fcCode_date
  const parts = baseGroupId.split('_');
  if (parts.length >= 3) {
    const vendorGroup = parts[0];
    const dateStr = parts[parts.length - 1];
    // FC code might contain underscores, so join middle parts
    const fcPartyId = parts.slice(1, -1).join('_');
    return { vendorGroup, fcPartyId, dateStr, isSeparate, poNumber };
  }

  // Fallback for old format without vendor group (fcCode_date)
  if (parts.length === 2) {
    return {
      vendorGroup: null, // Will need to infer from orders
      fcPartyId: parts[0],
      dateStr: parts[1],
      isSeparate,
      poNumber
    };
  }

  return { vendorGroup: null, fcPartyId: groupId, dateStr: 'nodate', isSeparate, poNumber };
}

/**
 * @route GET/POST /api/vendor/orders/consolidate/:groupId/packing-list
 * @desc Generate a consolidated packing list for a group of orders
 * @query format - Output format: 'json' (default), 'html', 'csv'
 */
async function generatePackingList(req, res) {
  try {
    const db = getDb();
    // IMPORTANT: Use unified_orders collection (same as consolidation endpoint)
    const collection = db.collection('unified_orders');

    // Parse group ID using consistent parser
    const groupId = req.params.groupId;
    const parsed = parseConsolidationGroupId(groupId);
    const { vendorGroup, fcPartyId, dateStr, isSeparate, poNumber } = parsed;

    console.log('[VendorAPI] Packing list - parsed:', JSON.stringify(parsed));

    // CRITICAL: Build query with EXACT same filters as main consolidation endpoint
    // This ensures packing list matches what's shown in the consolidation view
    const query = {
      channel: 'amazon-vendor',
      'amazonVendor.shipToParty.partyId': { $regex: new RegExp(fcPartyId, 'i') },
      'amazonVendor.purchaseOrderState': { $in: ['New', 'Acknowledged'] },
      'amazonVendor.shipmentStatus': 'not_shipped',
      'odoo.deliveryStatus': { $ne: 'full' },
      'amazonVendor.consolidationOverride': { $ne: true }
    };

    // CRITICAL: Filter by vendor group to ensure only orders from same group are shown
    if (vendorGroup && VENDOR_GROUPS[vendorGroup]) {
      query['marketplace.code'] = { $in: VENDOR_GROUPS[vendorGroup].marketplaces };
    }

    // CRITICAL: Isolate test data from production data
    if (isTestMode()) {
      query._testData = true;
    } else {
      query._testData = { $ne: true };
      // Also exclude TST orders by PO number pattern
      query['sourceIds.amazonVendorPONumber'] = { $not: /^TST/ };
    }

    if (dateStr && dateStr !== 'nodate') {
      const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
      const endOfDay = new Date(dateStr + 'T00:00:00.000Z');
      endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
      query['amazonVendor.deliveryWindow.endDate'] = { $gte: startOfDay, $lt: endOfDay };
    }

    console.log('[VendorAPI] Packing list query:', JSON.stringify(query));
    const orders = await collection.find(query)
      .sort({ 'sourceIds.amazonVendorPONumber': 1 })
      .toArray();
    console.log('[VendorAPI] Packing list found', orders.length, 'orders');

    if (orders.length === 0) {
      return res.status(404).json({ success: false, error: 'No orders found for this group' });
    }

    // Build consolidated packing list (using unified schema fields)
    const packingList = {
      generatedAt: new Date().toISOString(),
      groupId: req.params.groupId,
      shipTo: {
        fcPartyId,
        fcName: getFCName(fcPartyId, orders[0].amazonVendor?.shipToParty?.address),
        address: orders[0].amazonVendor?.shipToParty?.address
      },
      deliveryWindow: orders[0].amazonVendor?.deliveryWindow,
      purchaseOrders: orders.map(o => o.sourceIds?.amazonVendorPONumber || o.purchaseOrderNumber),
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
        // Use acknowledgeQty (accepted quantity) if available
        const qty = item.acknowledgeQty ?? item.orderedQuantity?.amount ?? 0;

        if (!itemMap[key]) {
          // Only show SKU if different from EAN
          const sku = item.odooSku && item.odooSku !== item.vendorProductIdentifier
            ? item.odooSku
            : '-';
          // Use odooBarcode (real EAN from Odoo) if available
          const ean = item.odooBarcode || item.vendorProductIdentifier;
          itemMap[key] = {
            line: 0,
            sku,
            ean,
            asin: item.amazonProductIdentifier,
            description: item.odooProductName || '-',
            quantity: 0,
            poNumbers: []
          };
        }

        itemMap[key].quantity += qty;
        const poNumber = order.sourceIds?.amazonVendorPONumber || order.purchaseOrderNumber;
        if (!itemMap[key].poNumbers.includes(poNumber)) {
          itemMap[key].poNumbers.push(poNumber);
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

    const format = req.body?.format || req.query?.format || 'json';

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
    console.error('[VendorAPI] /orders/consolidate/:groupId/packing-list error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// Support both GET and POST for packing list
router.get('/orders/consolidate/:groupId/packing-list', generatePackingList);
router.post('/orders/consolidate/:groupId/packing-list', generatePackingList);

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
    ${address.city ? `<div class="info-row"><span class="info-label">City:</span> ${address.city} ${address.postalOrZipCode || address.postalCode || ''}</div>` : ''}
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
  lines.push('"Line","SKU","EAN","ASIN","Description","Quantity","PO Numbers"');

  // Items
  for (const item of packingList.items) {
    lines.push([
      item.line,
      `"${(item.sku || '').replace(/"/g, '""')}"`,
      `"${(item.ean || '').replace(/"/g, '""')}"`,
      `"${(item.asin || '').replace(/"/g, '""')}"`,
      `"${(item.description || '').replace(/"/g, '""')}"`,
      item.quantity,
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
router.get('/fc-codes', (req, res) => {
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
          } catch (e) { /* ignore parse errors */ }
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
 * @route POST /api/vendor/shipments/:poNumber/replace-asn
 * @desc Submit a Replace ASN to correct shipment details
 * @body shipmentId - Required: the original shipmentId to replace
 * @body dryRun - Optional: simulate without sending (default false)
 */
router.post('/shipments/:poNumber/replace-asn', async (req, res) => {
  try {
    const { shipmentId, dryRun = false } = req.body;

    if (!shipmentId) {
      return res.status(400).json({ success: false, error: 'shipmentId is required' });
    }

    const db = getDb();
    const asnCreator = await getVendorASNCreator();

    // Get original shipment to get carton data
    const originalShipment = await db.collection('vendor_shipments').findOne({
      shipmentId: shipmentId
    });

    if (!originalShipment) {
      return res.status(404).json({ success: false, error: `Original shipment not found: ${shipmentId}` });
    }

    // Get packing shipment for full carton data
    const packingShipment = await db.collection('packing_shipments').findOne({
      purchaseOrders: req.params.poNumber
    });

    if (!packingShipment) {
      return res.status(404).json({ success: false, error: 'Packing shipment not found' });
    }

    // Build carton data from parcels
    const cartons = packingShipment.parcels.map(parcel => ({
      sscc: parcel.sscc,
      trackingNumber: parcel.glsTrackingNumber || parcel.trackingNumber || null,
      weight: parcel.weight || parcel.estimatedWeight || null,
      items: (parcel.items || []).map(item => ({
        ean: item.ean,
        sku: item.sku,
        quantity: item.quantity
      }))
    }));

    const totalWeight = packingShipment.parcels.reduce((sum, p) => sum + (p.weight || p.estimatedWeight || 0), 0);
    const masterTrackingNumber = packingShipment.trackingNumber ||
      (packingShipment.parcels.find(p => p.glsTrackingNumber || p.trackingNumber)?.glsTrackingNumber) ||
      (packingShipment.parcels.find(p => p.glsTrackingNumber || p.trackingNumber)?.trackingNumber) ||
      null;

    const carrier = {
      scac: 'GLSFR',
      name: 'GLS',
      mode: 'Road',
      trackingNumber: masterTrackingNumber
    };

    const measurements = {
      totalWeight: totalWeight,
      weightUnit: 'Kg'
    };

    console.log(`[VendorAPI] Submitting Replace ASN for PO ${req.params.poNumber}, shipmentId: ${shipmentId}`);

    const result = await asnCreator.submitASNWithSSCC(req.params.poNumber, { cartons, carrier, measurements }, {
      dryRun: dryRun,
      replaceShipmentId: shipmentId
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
      submitted: !dryRun,
      dryRun: dryRun,
      purchaseOrderNumber: req.params.poNumber,
      shipmentId: result.shipmentId,
      transactionId: result.transactionId,
      confirmationType: 'Replace',
      warnings: result.warnings,
      ...(result.payload && { payload: result.payload })
    });
  } catch (error) {
    console.error('[VendorAPI] POST /shipments/:poNumber/replace-asn error:', error);
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
router.get('/config', (req, res) => {
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

// ==================== PACKING / GLS INTEGRATION ====================

const { getGLSClient } = require('../../services/shipping/GLSClient');

// Acropaq sender address for GLS shipments
const ACROPAQ_SENDER = {
  name: 'Acropaq NV',
  street: 'Zoggelaan',
  streetNumber: '2',
  zipCode: '2960',
  city: 'Brecht',
  countryCode: 'BE',
  email: 'info@acropaq.com',
  phone: '+32 3 355 03 10'
};

// Default product weights (kg) - used for weight estimation
const DEFAULT_PRODUCT_WEIGHTS = {
  'LAM-A4-100': 1.8,
  'LAM-A4-80': 1.5,
  'LAM-A3-50': 2.2,
  'LAM-A3-80': 2.8,
  'TRIM-A4': 0.8,
  'TRIM-A3': 1.2,
  'PROT-A4': 0.4,
  'PROT-A3': 0.6,
  default: 1.0
};

/**
 * @route POST /api/vendor/packing/create-shipment
 * @desc Create a packing shipment for a consolidation group with parcels
 * @body groupId - Consolidation group ID
 * @body parcels - Array of parcel definitions { items, weight, estimatedWeight }
 * @body fcAddress - Fulfillment center address
 * @body fcName - FC name
 * @body purchaseOrders - Array of PO numbers
 */
router.post('/packing/create-shipment', async (req, res) => {
  try {
    const db = getDb();
    const { groupId, parcels = [], fcAddress, fcName, purchaseOrders = [] } = req.body;

    if (!groupId) {
      return res.status(400).json({ success: false, error: 'groupId is required' });
    }

    if (parcels.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one parcel is required' });
    }

    // Get delivery address from Odoo sale order
    let deliveryAddress = fcAddress || {};
    if (purchaseOrders.length > 0) {
      try {
        // Get the first PO to find the linked Odoo sale order
        const firstPO = await db.collection('unified_orders').findOne({
          'sourceIds.amazonVendorPONumber': purchaseOrders[0]
        });

        if (firstPO?.odoo?.saleOrderId) {
          const odoo = new OdooDirectClient();
          await odoo.authenticate();

          // Get the sale order with partner_shipping_id
          const [saleOrder] = await odoo.read('sale.order', [firstPO.odoo.saleOrderId],
            ['partner_shipping_id']);

          if (saleOrder?.partner_shipping_id) {
            const shippingPartnerId = Array.isArray(saleOrder.partner_shipping_id)
              ? saleOrder.partner_shipping_id[0]
              : saleOrder.partner_shipping_id;

            // Get the full address from res.partner
            const [partner] = await odoo.read('res.partner', [shippingPartnerId],
              ['name', 'street', 'street2', 'city', 'zip', 'country_id']);

            if (partner) {
              const countryCode = partner.country_id
                ? (Array.isArray(partner.country_id) ? partner.country_id[1] : partner.country_id)
                : '';
              // Map country name to code
              const countryMap = { 'France': 'FR', 'Germany': 'DE', 'Belgium': 'BE', 'Netherlands': 'NL', 'Italy': 'IT', 'Spain': 'ES' };

              deliveryAddress = {
                name: partner.name || '',
                addressLine1: partner.street || '',
                street2: partner.street2 || '',
                city: (partner.city || '').trim(),
                postalOrZipCode: partner.zip || '',
                countryCode: countryMap[countryCode] || countryCode || 'FR'
              };
              console.log(`[VendorAPI] create-shipment: Got delivery address from Odoo partner ${shippingPartnerId}:`, partner.name);
            }
          }
        }
      } catch (odooError) {
        console.error('[VendorAPI] create-shipment: Failed to fetch address from Odoo:', odooError.message);
        // Continue with provided fcAddress as fallback
      }
    }

    // Create shipment record
    const shipmentId = `PKG-${Date.now()}`;
    const shipment = {
      shipmentId,
      groupId,
      fcName: deliveryAddress.name || fcName || '',
      fcAddress: deliveryAddress,
      purchaseOrders,
      status: 'created',
      parcels: parcels.map((p, idx) => ({
        parcelNumber: idx + 1,
        items: p.items || [],
        weight: parseFloat(p.weight) || 1.0,
        estimatedWeight: parseFloat(p.estimatedWeight) || parseFloat(p.weight) || 1.0,
        sscc: null,
        ssccFormatted: null,
        glsTrackingNumber: null,
        glsParcelNumber: null,
        glsLabelPdf: null
      })),
      totalParcels: parcels.length,
      totalWeight: parcels.reduce((sum, p) => sum + (parseFloat(p.weight) || 1.0), 0),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('packing_shipments').insertOne(shipment);

    res.json({
      success: true,
      shipment: {
        shipmentId: shipment.shipmentId,
        groupId: shipment.groupId,
        parcelCount: shipment.parcels.length,
        totalWeight: shipment.totalWeight,
        status: shipment.status
      }
    });
  } catch (error) {
    console.error('[VendorAPI] POST /packing/create-shipment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/packing/shipment/:shipmentId
 * @desc Get packing shipment details
 */
router.get('/packing/shipment/:shipmentId', async (req, res) => {
  try {
    const db = getDb();
    const shipment = await db.collection('packing_shipments').findOne({
      shipmentId: req.params.shipmentId
    });

    if (!shipment) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    res.json({ success: true, shipment });
  } catch (error) {
    console.error('[VendorAPI] GET /packing/shipment/:shipmentId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/packing/by-group/:groupId
 * @desc Get packing shipments for a consolidation group
 */
router.get('/packing/by-group/:groupId', async (req, res) => {
  try {
    const db = getDb();
    const shipments = await db.collection('packing_shipments')
      .find({ groupId: req.params.groupId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      success: true,
      count: shipments.length,
      shipments
    });
  } catch (error) {
    console.error('[VendorAPI] GET /packing/by-group/:groupId error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/packing/shipment-by-po/:poNumber
 * @desc Get packing shipment that contains a specific PO
 */
router.get('/packing/shipment-by-po/:poNumber', async (req, res) => {
  try {
    const db = getDb();
    const shipment = await db.collection('packing_shipments').findOne({
      purchaseOrders: req.params.poNumber
    }, { sort: { createdAt: -1 } });

    if (!shipment) {
      return res.status(404).json({ success: false, error: 'No shipment found for this PO' });
    }

    res.json({
      success: true,
      shipment
    });
  } catch (error) {
    console.error('[VendorAPI] GET /packing/shipment-by-po/:poNumber error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/packing/:shipmentId/generate-labels
 * @desc Generate carrier labels and SSCC codes for all parcels in a packing shipment
 * @body {carrier: 'gls'|'dachser'|'none'} - Selected carrier for label generation
 */
router.post('/packing/:shipmentId/generate-labels', async (req, res) => {
  try {
    const db = getDb();
    const generator = await getSSCCGenerator();
    const { carrier = 'gls', palletInfo } = req.body;

    const shipment = await db.collection('packing_shipments').findOne({
      shipmentId: req.params.shipmentId
    });

    if (!shipment) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    // Initialize carrier client based on selection
    let glsClient = null;
    let dachserClient = null;

    console.log(`[VendorAPI] generate-labels: carrier=${carrier}, shipmentId=${req.params.shipmentId}`);
    console.log(`[VendorAPI] generate-labels: fcAddress=${JSON.stringify(shipment.fcAddress)}`);
    if (palletInfo) {
      console.log(`[VendorAPI] generate-labels: palletInfo=${JSON.stringify(palletInfo)}`);
    }

    if (carrier === 'gls') {
      try {
        glsClient = getGLSClient();
        console.log('[VendorAPI] GLS client initialized successfully');
      } catch (err) {
        console.warn('[VendorAPI] GLS not configured:', err.message);
      }
    } else if (carrier === 'dachser') {
      try {
        const { getDachserClient } = require('../../services/shipping/DachserClient');
        dachserClient = getDachserClient();
        if (!dachserClient.isConfigured()) {
          console.warn('[VendorAPI] Dachser not configured');
          dachserClient = null;
        }
      } catch (err) {
        console.warn('[VendorAPI] Dachser not available:', err.message);
      }
    }

    const results = [];
    const updatedParcels = [...shipment.parcels];

    // STEP 1: Generate SSCCs for all parcels that don't have one
    for (let i = 0; i < updatedParcels.length; i++) {
      const parcel = updatedParcels[i];
      if (!parcel.sscc) {
        const ssccResult = await generator.generateSSCC({
          type: 'carton',
          purchaseOrderNumber: shipment.purchaseOrders[0] || '',
          shipmentId: shipment.shipmentId
        });
        parcel.sscc = ssccResult.sscc;
        parcel.ssccFormatted = ssccResult.ssccFormatted;
        await generator.updateContents(parcel.sscc, parcel.items);
      }
    }

    // STEP 2: Generate GLS labels for ALL parcels in ONE request (multi-parcel shipment)
    // This ensures labels show "Parcel 1 of 3", "Parcel 2 of 3", etc.
    const parcelsNeedingGLS = updatedParcels.filter(p => !p.glsTrackingNumber);

    if (glsClient && parcelsNeedingGLS.length > 0 && shipment.fcAddress) {
      console.log(`[VendorAPI] Creating multi-parcel GLS shipment for ${parcelsNeedingGLS.length} parcels`);

      const receiverAddress = {
        name: shipment.fcAddress.name || shipment.fcName || 'Amazon FC',
        street: shipment.fcAddress.addressLine1 || shipment.fcAddress.street || '',
        streetNumber: shipment.fcAddress.streetNumber || '',
        zipCode: shipment.fcAddress.postalOrZipCode || shipment.fcAddress.postalCode || shipment.fcAddress.zipCode || '',
        city: shipment.fcAddress.city || '',
        countryCode: shipment.fcAddress.countryCode || 'FR',
        email: '',
        phone: ''
      };

      const glsResult = await glsClient.createMultiParcelShipment({
        sender: ACROPAQ_SENDER,
        receiver: receiverAddress,
        reference: shipment.shipmentId,
        parcels: parcelsNeedingGLS.map((parcel, idx) => ({
          reference: `${shipment.shipmentId}-P${parcel.parcelNumber}`,
          weight: parcel.weight || 1
        })),
        product: 'Parcel'
      });

      if (glsResult.success && glsResult.parcels.length > 0) {
        console.log(`[VendorAPI] GLS multi-parcel success: ${glsResult.parcels.length} labels received`);
        // Map GLS results back to parcels
        parcelsNeedingGLS.forEach((parcel, idx) => {
          if (glsResult.parcels[idx]) {
            const glsParcel = glsResult.parcels[idx];
            parcel.glsTrackingNumber = glsParcel.trackingNumber;
            parcel.glsParcelNumber = glsParcel.parcelNumber;
            parcel.glsLabelPdf = glsParcel.labelPdf ? glsParcel.labelPdf.toString('base64') : null;
            parcel.carrier = 'gls';
          }
        });
      } else {
        console.error(`[VendorAPI] GLS multi-parcel failed:`, glsResult.error);
        // Mark all parcels with the error
        parcelsNeedingGLS.forEach(parcel => {
          parcel.glsError = glsResult.error;
        });
      }
    }

    // STEP 2b: Create Dachser transport order (freight shipment with pallet info)
    let dachserResult = null;
    if (dachserClient && palletInfo && shipment.fcAddress) {
      console.log(`[VendorAPI] Creating Dachser transport order with ${palletInfo.count} pallet(s)`);

      const dachserReceiverAddress = {
        name: shipment.fcAddress.name || shipment.fcName || 'Amazon FC',
        street: shipment.fcAddress.addressLine1 || shipment.fcAddress.street || '',
        postalCode: shipment.fcAddress.postalOrZipCode || shipment.fcAddress.postalCode || shipment.fcAddress.zipCode || '',
        city: shipment.fcAddress.city || '',
        countryCode: shipment.fcAddress.countryCode || 'FR',
        phone: shipment.fcAddress.phone || '',
        email: shipment.fcAddress.email || ''
      };

      // Build packages array - one entry per pallet with its weight
      const packages = [];
      for (let p = 0; p < palletInfo.count; p++) {
        packages.push({
          packingType: palletInfo.packingType || 'EU', // Euro pallet
          quantity: 1,
          weight: palletInfo.weights?.[p] || 0,
          length: 120, // Euro pallet dimensions (cm)
          width: 80,
          height: 150 // Default stacking height
        });
      }

      try {
        // Calculate goods value - fetch from unified_orders for accurate pricing
        let goodsValueAmount = 0;

        // Get orders from the group to calculate total value
        if (shipment.groupId) {
          const parsed = parseConsolidationGroupId(shipment.groupId);
          let ordersQuery;

          if (parsed.isSeparate) {
            ordersQuery = {
              channel: 'amazon-vendor',
              'sourceIds.amazonVendorPONumber': parsed.poNumber
            };
          } else {
            ordersQuery = {
              channel: 'amazon-vendor',
              'amazonVendor.shipToParty.partyId': parsed.fcPartyId,
              'amazonVendor.consolidationOverride': { $ne: true }
            };
            if (parsed.vendorGroup && VENDOR_GROUPS[parsed.vendorGroup]) {
              ordersQuery['marketplace.code'] = { $in: VENDOR_GROUPS[parsed.vendorGroup].marketplaces };
            }
            if (parsed.dateStr && parsed.dateStr !== 'nodate') {
              const startOfDay = new Date(parsed.dateStr + 'T00:00:00.000Z');
              const endOfDay = new Date(parsed.dateStr + 'T00:00:00.000Z');
              endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
              ordersQuery['amazonVendor.deliveryWindow.endDate'] = { $gte: startOfDay, $lt: endOfDay };
            }
          }

          ordersQuery._testData = isTestMode() ? true : { $ne: true };

          const orders = await db.collection('unified_orders').find(ordersQuery).toArray();
          for (const order of orders) {
            for (const item of (order.items || [])) {
              const qty = item.acknowledgeQty ?? item.orderedQuantity?.amount ?? item.quantity ?? 0;
              const unitPrice = parseFloat(item.netCost?.amount) || 0;
              goodsValueAmount += qty * unitPrice;
            }
          }
        }

        // Fallback: try parcel items if group calculation failed
        if (goodsValueAmount === 0) {
          for (const parcel of updatedParcels) {
            for (const item of (parcel.items || [])) {
              const unitPrice = item.netCost || item.price || 0;
              const qty = item.quantity || 0;
              goodsValueAmount += unitPrice * qty;
            }
          }
        }

        // Build delivery instructions
        const poNumbers = shipment.purchaseOrders || [];
        const palletCount = palletInfo?.count || 1;
        const cartonCount = updatedParcels.length;
        const deliveryInstructions = `Purchase order ${poNumbers.join(' + ')} | Shipment ID: ${shipment.shipmentId} | ${palletCount} PAL - ${cartonCount} cartons`;

        dachserResult = await dachserClient.createTransportOrder({
          receiver: dachserReceiverAddress,
          packages,
          references: [
            { type: 'SHIPMENT', value: shipment.shipmentId },
            { type: 'CUSTOMER_REF', value: poNumbers.join(',') }
          ],
          goodsValue: {
            amount: Math.round(goodsValueAmount * 100) / 100,
            currency: 'EUR'
          },
          natureOfGoods: 'mixed office stuff',
          deliveryInstructions,
          collectionDate: new Date() // Tomorrow or next business day would be better
        });

        if (dachserResult.success) {
          console.log(`[VendorAPI] Dachser transport order created: ${dachserResult.trackingNumber}`);

          // Mark all parcels with Dachser info
          updatedParcels.forEach(parcel => {
            parcel.carrier = 'dachser';
            parcel.dachserTrackingNumber = dachserResult.trackingNumber;
            parcel.dachserShipmentId = dachserResult.shipmentId;
          });
        } else {
          console.error(`[VendorAPI] Dachser transport order failed:`, dachserResult.error);
          updatedParcels.forEach(parcel => {
            parcel.dachserError = dachserResult.error || 'Dachser booking failed';
          });
        }
      } catch (dachserErr) {
        console.error('[VendorAPI] Dachser booking exception:', dachserErr.message);
        updatedParcels.forEach(parcel => {
          parcel.dachserError = dachserErr.message;
        });
      }
    }

    // STEP 3: Build results for response
    for (let i = 0; i < updatedParcels.length; i++) {
      const parcel = updatedParcels[i];
      const parcelResult = {
        parcelNumber: parcel.parcelNumber,
        sscc: parcel.sscc,
        ssccFormatted: parcel.ssccFormatted,
        carrierTrackingNumber: parcel.glsTrackingNumber || parcel.dachserTrackingNumber || null,
        carrierError: parcel.glsError || parcel.dachserError || null,
        glsTrackingNumber: parcel.glsTrackingNumber || null,
        glsError: parcel.glsError || null,
        dachserTrackingNumber: parcel.dachserTrackingNumber || null,
        dachserError: parcel.dachserError || null
      };

      // Handle carrier not configured case
      if (carrier !== 'none' && !glsClient && !dachserClient) {
        parcelResult.carrierError = `${carrier.toUpperCase()} not configured`;
        parcelResult.glsError = carrier === 'gls' ? 'GLS not configured' : null;
      }

      results.push(parcelResult);
    }

    // Update shipment with carrier info and pallet data
    const shipmentUpdate = {
      parcels: updatedParcels,
      carrier: carrier,
      status: 'labels_generated',
      labelsGeneratedAt: new Date(),
      updatedAt: new Date()
    };

    // Store pallet info if provided
    if (palletInfo) {
      shipmentUpdate.palletInfo = palletInfo;
    }

    // Store Dachser booking info
    if (dachserResult && dachserResult.success) {
      shipmentUpdate.dachser = {
        trackingNumber: dachserResult.trackingNumber,
        shipmentId: dachserResult.shipmentId,
        labelPdf: dachserResult.labelPdf,
        trackingUrl: dachserClient.getTrackingUrl(dachserResult.trackingNumber),
        bookedAt: new Date()
      };
    }

    await db.collection('packing_shipments').updateOne(
      { shipmentId: req.params.shipmentId },
      { $set: shipmentUpdate }
    );

    // Build response
    const response = {
      success: true,
      shipmentId: shipment.shipmentId,
      carrier: carrier,
      parcels: results,
      glsConfigured: !!glsClient,
      dachserConfigured: !!dachserClient
    };

    // Include Dachser shipment info in response
    if (dachserResult && dachserResult.success) {
      response.dachser = {
        trackingNumber: dachserResult.trackingNumber,
        trackingUrl: dachserClient.getTrackingUrl(dachserResult.trackingNumber),
        labelPdf: dachserResult.labelPdf ? true : false // Just indicate if we have it
      };
    }

    res.json(response);
  } catch (error) {
    console.error('[VendorAPI] POST /packing/:shipmentId/generate-labels error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/packing/:shipmentId/labels
 * @desc Get combined labels page (GLS + SSCC) for printing
 */
router.get('/packing/:shipmentId/labels', async (req, res) => {
  try {
    const db = getDb();

    const shipment = await db.collection('packing_shipments').findOne({
      shipmentId: req.params.shipmentId
    });

    if (!shipment) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    // Parse groupId for FC info
    const lastUnderscoreIndex = (shipment.groupId || '').lastIndexOf('_');
    const fcPartyId = lastUnderscoreIndex > 0
      ? shipment.groupId.substring(0, lastUnderscoreIndex)
      : (shipment.groupId || '');

    const shipTo = {
      fcPartyId,
      fcName: shipment.fcName || FC_NAMES[fcPartyId] || fcPartyId,
      address: shipment.fcAddress
    };

    // Build combined labels HTML
    const labelsHtml = [];
    labelsHtml.push(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Shipment Labels - ${shipment.shipmentId}</title>
        <style>
          @media print {
            .page-break { page-break-after: always; }
            .no-print { display: none !important; }
            body { margin: 0; padding: 0; }
          }
          body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
          .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .header h1 { margin: 0 0 10px 0; color: #333; }
          .header-info { display: flex; gap: 30px; color: #666; }
          .label-container { background: white; margin-bottom: 20px; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .parcel-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; border-bottom: 2px solid #eee; margin-bottom: 15px; }
          .parcel-header h2 { margin: 0; color: #333; }
          .parcel-meta { color: #666; font-size: 14px; }
          .label-section { border: 2px solid #ddd; padding: 15px; margin-bottom: 15px; border-radius: 6px; }
          .label-section.gls { border-color: #ffc107; background: #fffef0; }
          .label-section.sscc { border-color: #28a745; background: #f0fff4; }
          .label-title { font-weight: bold; font-size: 16px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
          .label-title.gls { color: #856404; }
          .label-title.sscc { color: #155724; }
          .tracking-code { font-family: monospace; font-size: 18px; background: #f8f9fa; padding: 8px 12px; border-radius: 4px; display: inline-block; }
          .label-pdf { width: 100%; height: 450px; border: 1px solid #ddd; border-radius: 4px; }
          .items-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
          .items-table th, .items-table td { padding: 8px; text-align: left; border-bottom: 1px solid #eee; }
          .items-table th { background: #f8f9fa; font-weight: 600; color: #666; }
          .no-label { color: #999; font-style: italic; padding: 20px; text-align: center; }
          .actions-bar {
            position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            padding: 15px 30px;
            display: flex; justify-content: space-between; align-items: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          }
          .actions-bar h2 { color: white; margin: 0; font-size: 18px; }
          .actions-buttons { display: flex; gap: 12px; }
          .action-btn {
            padding: 12px 24px; font-size: 14px; font-weight: bold;
            border: none; border-radius: 6px; cursor: pointer;
            display: flex; align-items: center; gap: 8px;
            text-decoration: none; transition: all 0.2s;
          }
          .action-btn.labels { background: #ffc107; color: #000; }
          .action-btn.labels:hover { background: #e0a800; }
          .action-btn.delivery { background: #17a2b8; color: white; }
          .action-btn.delivery:hover { background: #138496; }
          .action-btn svg { width: 18px; height: 18px; }
          .content-wrapper { padding-top: 80px; }
        </style>
      </head>
      <body>
        <div class="actions-bar no-print">
          <h2>Shipment: ${shipment.shipmentId}</h2>
          <div class="actions-buttons">
            <a href="/api/vendor/packing/${shipment.shipmentId}/labels.pdf" class="action-btn labels" download>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>
              All Labels PDF (GLS + SSCC)
            </a>
            <a href="/api/vendor/packing/${shipment.shipmentId}/delivery-note.pdf" class="action-btn delivery" download>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              Delivery Note PDF (A4)
            </a>
          </div>
        </div>

        <div class="content-wrapper">
        <div class="header no-print">
          <h1>Shipment: ${shipment.shipmentId}</h1>
          <div class="header-info">
            <div><strong>Destination:</strong> ${shipTo.fcName}</div>
            <div><strong>Parcels:</strong> ${shipment.parcels.length}</div>
            <div><strong>Total Weight:</strong> ${shipment.totalWeight} kg</div>
            <div><strong>Status:</strong> ${shipment.status}</div>
          </div>
        </div>
    `);

    for (let i = 0; i < shipment.parcels.length; i++) {
      const parcel = shipment.parcels[i];
      const isLast = i === shipment.parcels.length - 1;

      labelsHtml.push(`
        <div class="label-container${!isLast ? ' page-break' : ''}">
          <div class="parcel-header">
            <h2>📦 Parcel ${parcel.parcelNumber} of ${shipment.parcels.length}</h2>
            <div class="parcel-meta">
              <strong>Weight:</strong> ${parcel.weight} kg |
              <strong>Items:</strong> ${parcel.items?.length || 0} SKUs
            </div>
          </div>
      `);

      // GLS Label section
      labelsHtml.push('<div class="label-section gls">');
      labelsHtml.push('<div class="label-title gls">🚚 GLS Shipping Label</div>');

      if (parcel.glsTrackingNumber) {
        labelsHtml.push(`
          <p><strong>Tracking Number:</strong> <span class="tracking-code">${parcel.glsTrackingNumber}</span></p>
          ${parcel.glsLabelPdf ? `
            <iframe class="label-pdf" src="data:application/pdf;base64,${parcel.glsLabelPdf}"></iframe>
          ` : '<p class="no-label">GLS label PDF not available - print from GLS portal</p>'}
        `);
      } else {
        labelsHtml.push('<p class="no-label">GLS label not generated (GLS integration not configured or disabled)</p>');
      }
      labelsHtml.push('</div>');

      // SSCC Label section
      labelsHtml.push('<div class="label-section sscc">');
      labelsHtml.push('<div class="label-title sscc">📋 Amazon SSCC Label</div>');

      if (parcel.sscc) {
        labelsHtml.push(`<p><strong>SSCC:</strong> <span class="tracking-code">${parcel.ssccFormatted || parcel.sscc}</span></p>`);
        labelsHtml.push(`<iframe class="label-pdf" src="/api/vendor/packing/${shipment.shipmentId}/sscc-label/${parcel.parcelNumber}.pdf"></iframe>`);
      } else {
        labelsHtml.push('<p class="no-label">SSCC not generated</p>');
      }
      labelsHtml.push('</div>');

      // Items in this parcel
      if (parcel.items && parcel.items.length > 0) {
        labelsHtml.push(`
          <div style="margin-top: 15px;">
            <strong>Items in this parcel:</strong>
            <table class="items-table">
              <thead>
                <tr><th>SKU</th><th>EAN</th><th>Description</th><th style="text-align: right;">Qty</th></tr>
              </thead>
              <tbody>
                ${parcel.items.map(item => `
                  <tr>
                    <td>${item.sku || '-'}</td>
                    <td>${item.ean || '-'}</td>
                    <td>${item.name || 'Unknown'}</td>
                    <td style="text-align: right; font-weight: bold; color: #28a745;">${item.quantity || 0}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `);
      }

      labelsHtml.push('</div>'); // Close label-container
    }

    labelsHtml.push('</div>'); // Close content-wrapper
    labelsHtml.push('</body></html>');

    res.setHeader('Content-Type', 'text/html');
    res.send(labelsHtml.join(''));
  } catch (error) {
    console.error('[VendorAPI] GET /packing/:shipmentId/labels error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/packing/:shipmentId/labels.pdf
 * @desc Get combined GLS + SSCC labels as PDF for Zebra label printer (100x150mm per label)
 */
router.get('/packing/:shipmentId/labels.pdf', async (req, res) => {
  let browser = null;
  try {
    const db = getDb();
    const labelGen = await getSSCCLabelGenerator();
    const puppeteer = require('puppeteer');
    const { PDFDocument } = require('pdf-lib');

    const shipment = await db.collection('packing_shipments').findOne({
      shipmentId: req.params.shipmentId
    });

    if (!shipment) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    // Parse groupId for FC info
    const sepIndex = (shipment.groupId || '').indexOf('_SEP_');
    let fcPartyId;
    if (sepIndex > 0) {
      const baseGroupId = shipment.groupId.substring(0, sepIndex);
      const lastUnderscoreIndex = baseGroupId.lastIndexOf('_');
      fcPartyId = lastUnderscoreIndex > 0 ? baseGroupId.substring(0, lastUnderscoreIndex) : baseGroupId;
    } else {
      const lastUnderscoreIndex = (shipment.groupId || '').lastIndexOf('_');
      fcPartyId = lastUnderscoreIndex > 0 ? shipment.groupId.substring(0, lastUnderscoreIndex) : (shipment.groupId || '');
    }

    const shipTo = {
      fcPartyId,
      fcName: shipment.fcName || FC_NAMES[fcPartyId] || fcPartyId,
      address: shipment.fcAddress
    };

    // Create merged PDF document
    const mergedPdf = await PDFDocument.create();

    // Launch puppeteer for SSCC label generation
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Process each parcel: GLS label first, then SSCC label
    for (const parcel of shipment.parcels) {
      // 1. Add GLS label if available
      if (parcel.glsLabelPdf) {
        try {
          const glsPdfBytes = Buffer.from(parcel.glsLabelPdf, 'base64');
          const glsPdf = await PDFDocument.load(glsPdfBytes);
          const glsPages = await mergedPdf.copyPages(glsPdf, glsPdf.getPageIndices());
          glsPages.forEach(p => mergedPdf.addPage(p));
        } catch (glsErr) {
          console.error(`[VendorAPI] Error adding GLS label for parcel ${parcel.parcelNumber}:`, glsErr.message);
        }
      }

      // 2. Add SSCC label if available
      if (parcel.sscc) {
        const ssccLabelHtml = await labelGen.generateCartonLabelHTML({
          sscc: parcel.sscc,
          shipTo,
          purchaseOrders: shipment.purchaseOrders || [],
          items: parcel.items || []
        });

        await page.setContent(ssccLabelHtml, { waitUntil: 'domcontentloaded', timeout: 10000 });
        const ssccPdfBuffer = await page.pdf({
          width: '100mm',
          height: '150mm',
          printBackground: true,
          margin: { top: 0, right: 0, bottom: 0, left: 0 }
        });

        const ssccPdf = await PDFDocument.load(ssccPdfBuffer);
        const ssccPages = await mergedPdf.copyPages(ssccPdf, ssccPdf.getPageIndices());
        ssccPages.forEach(p => mergedPdf.addPage(p));
      }
    }

    await browser.close();
    browser = null;

    if (mergedPdf.getPageCount() === 0) {
      return res.status(400).json({ success: false, error: 'No labels to generate' });
    }

    const pdfBuffer = await mergedPdf.save();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="labels-${shipment.shipmentId}.pdf"`);
    res.send(Buffer.from(pdfBuffer));
  } catch (error) {
    if (browser) await browser.close();
    console.error('[VendorAPI] GET /packing/:shipmentId/labels.pdf error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/packing/:shipmentId/sscc-label/:parcelNumber.pdf
 * @desc Get individual SSCC label as PDF for preview embedding
 */
router.get('/packing/:shipmentId/sscc-label/:parcelNumber.pdf', async (req, res) => {
  let browser = null;
  try {
    const db = getDb();
    const labelGen = await getSSCCLabelGenerator();
    const puppeteer = require('puppeteer');

    const shipment = await db.collection('packing_shipments').findOne({
      shipmentId: req.params.shipmentId
    });

    if (!shipment) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    const parcelNumber = parseInt(req.params.parcelNumber);
    const parcel = shipment.parcels.find(p => p.parcelNumber === parcelNumber);

    if (!parcel || !parcel.sscc) {
      return res.status(404).json({ success: false, error: 'Parcel or SSCC not found' });
    }

    // Parse groupId for FC info
    const sepIndex = (shipment.groupId || '').indexOf('_SEP_');
    let fcPartyId;
    if (sepIndex > 0) {
      const baseGroupId = shipment.groupId.substring(0, sepIndex);
      const lastUnderscoreIndex = baseGroupId.lastIndexOf('_');
      fcPartyId = lastUnderscoreIndex > 0 ? baseGroupId.substring(0, lastUnderscoreIndex) : baseGroupId;
    } else {
      const lastUnderscoreIndex = (shipment.groupId || '').lastIndexOf('_');
      fcPartyId = lastUnderscoreIndex > 0 ? shipment.groupId.substring(0, lastUnderscoreIndex) : (shipment.groupId || '');
    }

    const shipTo = {
      fcPartyId,
      fcName: shipment.fcName || FC_NAMES[fcPartyId] || fcPartyId,
      address: shipment.fcAddress
    };

    // Generate SSCC label HTML
    const ssccLabelHtml = await labelGen.generateCartonLabelHTML({
      sscc: parcel.sscc,
      shipTo,
      purchaseOrders: shipment.purchaseOrders || [],
      items: parcel.items || []
    });

    // Convert to PDF using puppeteer
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    // Use 'domcontentloaded' instead of 'networkidle0' to avoid timeout on simple HTML
    await page.setContent(ssccLabelHtml, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const pdfBuffer = await page.pdf({
      width: '100mm',
      height: '150mm',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    await browser.close();
    browser = null;

    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuffer);
  } catch (error) {
    if (browser) await browser.close();
    console.error('[VendorAPI] GET /packing/:shipmentId/sscc-label/:parcelNumber.pdf error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/packing/:shipmentId/delivery-note.pdf
 * @desc Get delivery note as PDF for A4 printer
 */
router.get('/packing/:shipmentId/delivery-note.pdf', async (req, res) => {
  let browser = null;
  try {
    const db = getDb();
    const puppeteer = require('puppeteer');

    const shipment = await db.collection('packing_shipments').findOne({
      shipmentId: req.params.shipmentId
    });

    if (!shipment) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    // Parse groupId for FC info
    const sepIndex = (shipment.groupId || '').indexOf('_SEP_');
    let fcPartyId;
    if (sepIndex > 0) {
      const baseGroupId = shipment.groupId.substring(0, sepIndex);
      const lastUnderscoreIndex = baseGroupId.lastIndexOf('_');
      fcPartyId = lastUnderscoreIndex > 0 ? baseGroupId.substring(0, lastUnderscoreIndex) : baseGroupId;
    } else {
      const lastUnderscoreIndex = (shipment.groupId || '').lastIndexOf('_');
      fcPartyId = lastUnderscoreIndex > 0 ? shipment.groupId.substring(0, lastUnderscoreIndex) : (shipment.groupId || '');
    }

    const fcName = shipment.fcName || FC_NAMES[fcPartyId] || fcPartyId;
    const fcAddress = shipment.fcAddress || {};

    // Build all items aggregated across all parcels
    const allItemsMap = {};
    for (const parcel of shipment.parcels) {
      for (const item of (parcel.items || [])) {
        const key = item.sku || item.ean || item.name;
        if (!allItemsMap[key]) {
          allItemsMap[key] = { ...item, quantity: 0 };
        }
        allItemsMap[key].quantity += item.quantity || 0;
      }
    }
    const allItems = Object.values(allItemsMap).sort((a, b) => (a.sku || '').localeCompare(b.sku || ''));
    const totalUnits = allItems.reduce((sum, i) => sum + (i.quantity || 0), 0);

    // Generate delivery note HTML - compact to fit on single A4 page
    const deliveryNoteHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Delivery Note - ${shipment.shipmentId}</title>
  <style>
    @page { size: A4; margin: 10mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 9pt; line-height: 1.3; color: #333; }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 10px; }
    .logo { font-size: 20pt; font-weight: bold; color: #1a5f7a; }
    .company-name { font-size: 8pt; color: #666; }
    .doc-info { text-align: right; }
    .doc-title { font-size: 16pt; font-weight: bold; margin-bottom: 2px; }
    .doc-number { font-size: 10pt; color: #666; }
    .doc-date { font-size: 9pt; color: #888; }
    .addresses { display: flex; gap: 20px; margin-bottom: 10px; }
    .address-box { flex: 1; border: 1px solid #ddd; padding: 8px; border-radius: 4px; }
    .address-label { font-size: 8pt; color: #666; text-transform: uppercase; font-weight: bold; margin-bottom: 4px; }
    .address-name { font-size: 11pt; font-weight: bold; margin-bottom: 2px; }
    .address-line { font-size: 9pt; }
    .shipment-info { background: #f8f9fa; padding: 8px; border-radius: 4px; margin-bottom: 10px; }
    .info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .info-label { font-size: 8pt; color: #666; text-transform: uppercase; }
    .info-value { font-size: 10pt; font-weight: bold; }
    .section-title { font-size: 11pt; font-weight: bold; margin-bottom: 5px; border-bottom: 2px solid #1a5f7a; padding-bottom: 3px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
    th { background: #1a5f7a; color: white; padding: 5px 6px; text-align: left; font-size: 8pt; text-transform: uppercase; }
    td { padding: 5px 6px; border-bottom: 1px solid #eee; font-size: 9pt; }
    tr:nth-child(even) { background: #f9f9f9; }
    .qty-cell { text-align: center; font-weight: bold; }
    .parcels-section { margin-top: 10px; }
    .parcel-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .parcel-box { border: 1px solid #ddd; padding: 6px; border-radius: 4px; font-size: 8pt; }
    .parcel-header { font-weight: bold; font-size: 9pt; border-bottom: 1px solid #eee; padding-bottom: 4px; margin-bottom: 4px; }
    .parcel-detail { font-size: 8pt; color: #666; }
    .sscc-code { font-family: 'Courier New', monospace; font-size: 7pt; background: #f0f0f0; padding: 2px 4px; border-radius: 2px; display: inline-block; margin-top: 3px; }
    .footer { margin-top: 10px; border-top: 1px solid #ddd; padding-top: 5px; font-size: 7pt; color: #aaa; text-align: center; }
    .totals-row { background: #1a5f7a !important; color: white; font-weight: bold; }
    .totals-row td { border: none; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-section">
      <div class="logo">ACROPAQ</div>
      <div class="company-name">www.acropaq.com</div>
    </div>
    <div class="doc-info">
      <div class="doc-title">DELIVERY NOTE</div>
      <div class="doc-number">${shipment.shipmentId}</div>
      <div class="doc-date">${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
    </div>
  </div>

  <div class="addresses">
    <div class="address-box">
      <div class="address-label">From</div>
      <div class="address-name">ACROPAQ BV</div>
      <div class="address-line">Schoonheidslaan 10-12, 2980 Zoersel, Belgium</div>
    </div>
    <div class="address-box">
      <div class="address-label">Ship To</div>
      <div class="address-name">${fcName}</div>
      <div class="address-line">${fcAddress.addressLine1 || ''}, ${fcAddress.postalOrZipCode || fcAddress.postalCode || ''} ${fcAddress.city || ''}, ${fcAddress.countryCode || ''}</div>
    </div>
  </div>

  <div class="shipment-info">
    <div class="info-grid">
      <div class="info-item">
        <div class="info-label">Purchase Orders</div>
        <div class="info-value">${(shipment.purchaseOrders || []).join(', ')}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Total Parcels</div>
        <div class="info-value">${shipment.parcels.length}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Total Weight</div>
        <div class="info-value">${shipment.totalWeight || 0} kg</div>
      </div>
      <div class="info-item">
        <div class="info-label">Total Units</div>
        <div class="info-value">${totalUnits}</div>
      </div>
    </div>
  </div>

  <div class="section-title">Contents</div>
  <table>
    <thead>
      <tr>
        <th style="width: 12%;">SKU</th>
        <th style="width: 20%;">EAN</th>
        <th style="width: 50%;">Description</th>
        <th style="width: 15%; text-align: center;">Quantity</th>
      </tr>
    </thead>
    <tbody>
      ${allItems.map(item => `
        <tr>
          <td>${item.sku || '-'}</td>
          <td>${item.ean || '-'}</td>
          <td>${item.name || 'Unknown'}</td>
          <td class="qty-cell">${item.quantity}</td>
        </tr>
      `).join('')}
      <tr class="totals-row">
        <td colspan="3" style="text-align: right;">TOTAL</td>
        <td class="qty-cell">${totalUnits}</td>
      </tr>
    </tbody>
  </table>

  <div class="parcels-section">
    <div class="section-title">Parcel Details</div>
    <div class="parcel-grid">
      ${shipment.parcels.map((parcel, idx) => `
        <div class="parcel-box">
          <div class="parcel-header">Parcel ${idx + 1} of ${shipment.parcels.length}</div>
          <div class="parcel-detail">Weight: ${parcel.weight || 0} kg</div>
          <div class="parcel-detail">Items: ${(parcel.items || []).reduce((s, i) => s + (i.quantity || 0), 0)} units</div>
          ${parcel.glsTrackingNumber ? `<div class="parcel-detail">GLS: ${parcel.glsTrackingNumber}</div>` : ''}
          ${parcel.sscc ? `<div class="sscc-code">${parcel.ssccFormatted || parcel.sscc}</div>` : ''}
        </div>
      `).join('')}
    </div>
  </div>

  <div class="footer">
    Generated by ACROPAQ Vendor Management System | ${new Date().toISOString()}
  </div>
</body>
</html>`;

    // Launch puppeteer and generate PDF
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(deliveryNoteHtml, { waitUntil: 'domcontentloaded', timeout: 10000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    await browser.close();
    browser = null;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="delivery-note-${shipment.shipmentId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    if (browser) await browser.close();
    console.error('[VendorAPI] GET /packing/:shipmentId/delivery-note.pdf error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/packing/:shipmentId/submit-asn
 * @desc Complete Odoo delivery and submit ASN to Amazon for a packing shipment
 *
 * This endpoint:
 * 1. Finds Odoo deliveries for the consolidated POs
 * 2. Sets quantities done and validates the pickings
 * 3. Attaches labels PDF and delivery note PDF to Odoo
 * 4. Submits ASN to Amazon Vendor Central with SSCC data
 */
router.post('/packing/:shipmentId/submit-asn', async (req, res) => {
  try {
    const db = getDb();
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    const shipment = await db.collection('packing_shipments').findOne({
      shipmentId: req.params.shipmentId
    });

    if (!shipment) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    // Check if labels were generated - either by status or by checking parcels have tracking/SSCC
    const validStatuses = ['labels_generated', 'completed', 'invoiced', 'asn_submitted'];
    const hasLabels = shipment.parcels?.some(p => p.glsTrackingNumber || p.sscc);

    if (!validStatuses.includes(shipment.status) && !hasLabels) {
      return res.status(400).json({
        success: false,
        error: 'Labels must be generated before submitting ASN'
      });
    }

    const result = {
      success: true,
      shipmentId: shipment.shipmentId,
      odoo: { pickingsValidated: [], attachmentsCreated: [], invoicesCreated: [], invoicesPosted: [], errors: [] },
      amazon: { asnSubmitted: false, transactionIds: [], invoicesSubmitted: [], errors: [] }
    };

    // ========================================
    // STEP 1: Process Odoo Deliveries
    // ========================================
    const poNumbers = shipment.purchaseOrders || [];
    const processedPickings = new Set();

    for (const poNumber of poNumbers) {
      try {
        // Get PO from MongoDB to find linked Odoo sale order
        // Use unified_orders collection with sourceIds path
        const po = await db.collection('unified_orders').findOne({ 'sourceIds.amazonVendorPONumber': poNumber });
        if (!po || !po.odoo?.saleOrderId) {
          result.odoo.errors.push(`PO ${poNumber}: No linked Odoo sale order`);
          continue;
        }

        // Find outgoing deliveries for this sale order
        const pickings = await odoo.searchRead('stock.picking',
          [
            ['sale_id', '=', po.odoo.saleOrderId],
            ['picking_type_code', '=', 'outgoing'],
            ['state', 'in', ['assigned', 'confirmed', 'waiting']]
          ],
          ['id', 'name', 'state', 'move_ids_without_package']
        );

        for (const picking of pickings) {
          if (processedPickings.has(picking.id)) continue;
          processedPickings.add(picking.id);

          try {
            // Get move lines for this picking - only non-cancelled moves
            const moves = await odoo.searchRead('stock.move',
              [
                ['picking_id', '=', picking.id],
                ['state', 'not in', ['cancel', 'done']]  // Skip cancelled and already done moves
              ],
              ['id', 'product_id', 'product_uom_qty', 'quantity_done', 'state']
            );

            // Set quantity done on each move (only for moves that can be modified)
            for (const move of moves) {
              if (move.state === 'cancel') continue; // Extra safety check
              await odoo.write('stock.move', [move.id], {
                quantity_done: move.product_uom_qty
              });
            }

            // Validate the picking (button_validate)
            await odoo.execute('stock.picking', 'button_validate', [[picking.id]]);

            result.odoo.pickingsValidated.push({
              id: picking.id,
              name: picking.name,
              poNumber
            });

          } catch (pickingErr) {
            result.odoo.errors.push(`Picking ${picking.name}: ${pickingErr.message}`);
          }
        }
      } catch (poErr) {
        result.odoo.errors.push(`PO ${poNumber}: ${poErr.message}`);
      }
    }

    // ========================================
    // STEP 2: Attach PDFs to Odoo (to first validated picking)
    // ========================================
    if (result.odoo.pickingsValidated.length > 0) {
      const firstPicking = result.odoo.pickingsValidated[0];

      try {
        // Generate labels PDF
        const labelsPdfUrl = `/api/vendor/packing/${shipment.shipmentId}/labels.pdf`;
        const deliveryNotePdfUrl = `/api/vendor/packing/${shipment.shipmentId}/delivery-note.pdf`;

        // Create attachments in Odoo
        // Note: We store the URL reference, actual PDF generation happens on demand
        const labelsAttachment = await odoo.create('ir.attachment', {
          name: `Labels-${shipment.shipmentId}.pdf`,
          type: 'url',
          url: labelsPdfUrl,
          res_model: 'stock.picking',
          res_id: firstPicking.id,
          mimetype: 'application/pdf'
        });

        const deliveryNoteAttachment = await odoo.create('ir.attachment', {
          name: `DeliveryNote-${shipment.shipmentId}.pdf`,
          type: 'url',
          url: deliveryNotePdfUrl,
          res_model: 'stock.picking',
          res_id: firstPicking.id,
          mimetype: 'application/pdf'
        });

        result.odoo.attachmentsCreated.push(
          { id: labelsAttachment, name: `Labels-${shipment.shipmentId}.pdf` },
          { id: deliveryNoteAttachment, name: `DeliveryNote-${shipment.shipmentId}.pdf` }
        );
      } catch (attachErr) {
        result.odoo.errors.push(`Attachments: ${attachErr.message}`);
      }
    }

    // ========================================
    // STEP 3: Submit SINGLE consolidated ASN to Amazon for ALL POs
    // Per Amazon API: one shipment confirmation can contain multiple POs
    // Each item specifies its purchaseOrderNumber in itemDetails
    // ========================================
    try {
      console.log(`[VendorAPI] STEP 3: Submit CONSOLIDATED ASN to Amazon for ${poNumbers.length} PO(s): ${poNumbers.join(', ')}`);
      const asnCreator = await getVendorASNCreator();

      // Build EAN -> PO mapping from all POs
      const eanToPOMap = {};
      for (const poNumber of poNumbers) {
        const po = await db.collection('unified_orders').findOne({ 'sourceIds.amazonVendorPONumber': poNumber });
        if (po?.items) {
          for (const item of po.items) {
            if (item.vendorProductIdentifier) {
              eanToPOMap[item.vendorProductIdentifier] = poNumber;
            }
          }
        }
      }
      console.log(`[VendorAPI] EAN to PO mapping:`, eanToPOMap);

      // Build carton data from parcels - include weight, tracking, AND poNumber per item
      const cartons = shipment.parcels.map(parcel => ({
        sscc: parcel.sscc,
        trackingNumber: parcel.glsTrackingNumber || parcel.trackingNumber || null,
        weight: parcel.weight || parcel.estimatedWeight || null,
        items: (parcel.items || []).map(item => ({
          ean: item.ean,
          sku: item.sku,
          quantity: item.quantity,
          poNumber: eanToPOMap[item.ean] || poNumbers[0] // Look up which PO this item belongs to
        }))
      }));

      // Calculate total weight from all parcels
      const totalWeight = shipment.parcels.reduce((sum, p) => sum + (p.weight || p.estimatedWeight || 0), 0);

      // Get tracking number (use first parcel's tracking or shipment-level tracking)
      const masterTrackingNumber = shipment.trackingNumber ||
        (shipment.parcels.find(p => p.glsTrackingNumber || p.trackingNumber)?.glsTrackingNumber) ||
        (shipment.parcels.find(p => p.glsTrackingNumber || p.trackingNumber)?.trackingNumber) ||
        null;

      console.log(`[VendorAPI] Consolidated ASN carton data: ${cartons.length} carton(s), totalWeight=${totalWeight}kg, tracking=${masterTrackingNumber}`);
      cartons.forEach((c, i) => {
        console.log(`[VendorAPI]   Carton ${i + 1}: SSCC=${c.sscc}, weight=${c.weight}kg, tracking=${c.trackingNumber}`);
        c.items.forEach(it => console.log(`[VendorAPI]     - EAN=${it.ean}, SKU=${it.sku}, qty=${it.quantity}, PO=${it.poNumber}`));
      });

      // Build carrier info
      const carrier = {
        scac: 'GLSFR',
        name: 'GLS',
        mode: 'Road',
        trackingNumber: masterTrackingNumber
      };

      // Build measurements
      const measurements = {
        totalWeight: totalWeight,
        weightUnit: 'Kg'
      };

      // Submit ONE consolidated ASN for ALL POs
      const asnResult = await asnCreator.submitConsolidatedASN(poNumbers, { cartons, carrier, measurements }, {
        dryRun: false
      });

      console.log(`[VendorAPI] Consolidated ASN result:`, JSON.stringify({
        success: asnResult.success,
        shipmentId: asnResult.shipmentId,
        transactionId: asnResult.transactionId,
        errors: asnResult.errors,
        warnings: asnResult.warnings
      }));

      if (asnResult.success) {
        result.amazon.asnSubmitted = true;
        if (asnResult.transactionId) {
          result.amazon.transactionIds.push({
            poNumbers: poNumbers,
            transactionId: asnResult.transactionId,
            shipmentId: asnResult.shipmentId,
            consolidated: true
          });
        }
      } else {
        result.amazon.errors.push(`Consolidated ASN: ${asnResult.errors.join(', ')}`);
      }

    } catch (amazonErr) {
      console.error('[VendorAPI] Amazon ASN fatal error:', amazonErr);
      result.amazon.errors.push(`Amazon ASN: ${amazonErr.message}`);
    }

    // ========================================
    // STEP 4: Create Invoices from Delivered Quantities
    // ========================================
    // Only create invoices for pickings that were successfully validated and confirmed as 'done'
    const invoiceSubmitter = await getVendorInvoiceSubmitter();

    for (const pickingInfo of result.odoo.pickingsValidated) {
      try {
        // Re-fetch the picking to VERIFY it's actually in 'done' state
        const [verifiedPicking] = await odoo.searchRead('stock.picking',
          [['id', '=', pickingInfo.id]],
          ['id', 'name', 'state', 'sale_id', 'move_ids_without_package']
        );

        if (!verifiedPicking || verifiedPicking.state !== 'done') {
          result.odoo.errors.push(`Picking ${pickingInfo.name}: Not in 'done' state (${verifiedPicking?.state || 'not found'}), skipping invoice`);
          continue;
        }

        const saleOrderId = verifiedPicking.sale_id?.[0];
        if (!saleOrderId) {
          result.odoo.errors.push(`Picking ${pickingInfo.name}: No linked sale order, skipping invoice`);
          continue;
        }

        // Check if invoice already exists for this sale order
        const existingInvoices = await odoo.searchRead('account.move',
          [['invoice_origin', 'ilike', verifiedPicking.sale_id[1]], ['move_type', '=', 'out_invoice']],
          ['id', 'name', 'state']
        );

        if (existingInvoices.length > 0) {
          console.log(`[VendorAPI] Invoice already exists for ${verifiedPicking.sale_id[1]}: ${existingInvoices[0].name}`);
          // If it's already posted, we can try to submit it to Amazon
          if (existingInvoices[0].state === 'posted') {
            result.odoo.invoicesCreated.push({
              id: existingInvoices[0].id,
              name: existingInvoices[0].name,
              saleOrder: verifiedPicking.sale_id[1],
              existing: true
            });
          }
          continue;
        }

        // Get the sale order details
        const [saleOrder] = await odoo.searchRead('sale.order',
          [['id', '=', saleOrderId]],
          ['id', 'name', 'partner_id', 'order_line']
        );

        if (!saleOrder) {
          result.odoo.errors.push(`Picking ${pickingInfo.name}: Sale order ${saleOrderId} not found`);
          continue;
        }

        // Get DELIVERED quantities from stock.move (actual shipped quantities)
        const stockMoves = await odoo.searchRead('stock.move',
          [['picking_id', '=', pickingInfo.id], ['state', '=', 'done']],
          ['id', 'product_id', 'product_uom_qty', 'quantity_done', 'sale_line_id']
        );

        // Build a map of sale_line_id -> delivered qty
        const deliveredByLine = {};
        for (const move of stockMoves) {
          if (move.sale_line_id) {
            const lineId = move.sale_line_id[0];
            deliveredByLine[lineId] = (deliveredByLine[lineId] || 0) + (move.quantity_done || move.product_uom_qty);
          }
        }

        // Get sale order lines with their details
        const orderLines = await odoo.searchRead('sale.order.line',
          [['order_id', '=', saleOrderId]],
          ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'tax_id', 'qty_delivered']
        );

        // Build invoice lines based on DELIVERED quantities
        const invoiceLines = [];
        for (const line of orderLines) {
          if (!line.product_id) continue;

          // Use delivered quantity from stock moves, or qty_delivered field
          const deliveredQty = deliveredByLine[line.id] || line.qty_delivered || 0;
          if (deliveredQty <= 0) continue; // Skip lines with nothing delivered

          invoiceLines.push([0, 0, {
            product_id: line.product_id[0],
            name: line.name,
            quantity: deliveredQty,
            price_unit: line.price_unit,
            tax_ids: line.tax_id ? [[6, 0, line.tax_id]] : false,
            sale_line_ids: [[4, line.id]], // Link to sale order line
          }]);
        }

        if (invoiceLines.length === 0) {
          result.odoo.errors.push(`Picking ${pickingInfo.name}: No delivered items to invoice`);
          continue;
        }

        // Create the invoice
        console.log(`[VendorAPI] Creating invoice for ${saleOrder.name} with ${invoiceLines.length} lines...`);
        const invoiceId = await odoo.create('account.move', {
          move_type: 'out_invoice',
          partner_id: saleOrder.partner_id[0],
          invoice_origin: saleOrder.name,
          invoice_line_ids: invoiceLines,
        });

        if (!invoiceId) {
          result.odoo.errors.push(`Picking ${pickingInfo.name}: Failed to create invoice`);
          continue;
        }

        // Get the invoice details
        const [newInvoice] = await odoo.searchRead('account.move',
          [['id', '=', invoiceId]],
          ['id', 'name', 'state', 'amount_total']
        );

        result.odoo.invoicesCreated.push({
          id: invoiceId,
          name: newInvoice?.name || `INV-${invoiceId}`,
          saleOrder: saleOrder.name,
          amount: newInvoice?.amount_total,
          poNumber: pickingInfo.poNumber
        });

        console.log(`[VendorAPI] Invoice ${newInvoice?.name} created for ${saleOrder.name}`);

        // ========================================
        // STEP 4b: Post the invoice
        // ========================================
        try {
          await odoo.execute('account.move', 'action_post', [[invoiceId]]);

          // Verify it's posted
          const [postedInvoice] = await odoo.searchRead('account.move',
            [['id', '=', invoiceId]],
            ['id', 'name', 'state']
          );

          if (postedInvoice?.state === 'posted') {
            result.odoo.invoicesPosted.push({
              id: invoiceId,
              name: postedInvoice.name,
              poNumber: pickingInfo.poNumber
            });
            console.log(`[VendorAPI] Invoice ${postedInvoice.name} posted successfully`);
          } else {
            result.odoo.errors.push(`Invoice ${newInvoice?.name}: Failed to post (state: ${postedInvoice?.state})`);
          }
        } catch (postErr) {
          result.odoo.errors.push(`Invoice ${newInvoice?.name}: Post failed - ${postErr.message}`);
        }

      } catch (invoiceErr) {
        result.odoo.errors.push(`Invoice for picking ${pickingInfo.name}: ${invoiceErr.message}`);
      }
    }

    // ========================================
    // STEP 4c: Submit posted invoices to Amazon
    // ========================================
    // NOTE: Invoice submission to Amazon is not yet implemented
    // This step is skipped for now - invoices are created in Odoo but not sent to Amazon

    // ========================================
    // STEP 5: Update shipment status
    // ========================================
    // Determine final status based on what was accomplished
    let newStatus = 'asn_submitted';
    if (result.amazon.asnSubmitted) {
      newStatus = 'completed'; // ASN done, invoices created in Odoo
    }

    await db.collection('packing_shipments').updateOne(
      { shipmentId: req.params.shipmentId },
      {
        $set: {
          status: newStatus,
          asnSubmittedAt: new Date(),
          odooPickings: result.odoo.pickingsValidated,
          odooInvoices: result.odoo.invoicesCreated,
          amazonTransactions: result.amazon.transactionIds,
          amazonInvoices: result.amazon.invoicesSubmitted,
          updatedAt: new Date()
        }
      }
    );

    // Update POs shipment status
    for (const poNumber of poNumbers) {
      // Use unified_orders collection with sourceIds path
      await db.collection('unified_orders').updateOne(
        { 'sourceIds.amazonVendorPONumber': poNumber },
        { $set: {
          'amazonVendor.shipmentStatus': 'shipped',
          shipmentStatus: 'shipped',
          updatedAt: new Date()
        } }
      );
    }

    result.status = newStatus;

    // Build comprehensive message
    const parts = [];
    if (result.odoo.pickingsValidated.length > 0) {
      parts.push(`${result.odoo.pickingsValidated.length} delivery(ies) validated`);
    }
    if (result.amazon.asnSubmitted) {
      parts.push('ASN submitted to Amazon');
    }
    if (result.odoo.invoicesCreated.length > 0) {
      parts.push(`${result.odoo.invoicesCreated.length} invoice(s) created`);
    }
    if (result.odoo.invoicesPosted.length > 0) {
      parts.push(`${result.odoo.invoicesPosted.length} invoice(s) posted`);
    }
    result.message = parts.length > 0 ? parts.join(', ') : 'No operations completed';

    res.json(result);
  } catch (error) {
    console.error('[VendorAPI] POST /packing/:shipmentId/submit-asn error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/packing/estimate-weight
 * @desc Estimate total weight for parcel items
 * @body items - Array of { sku, quantity, weight? }
 * Items can include weight directly (from Odoo/orders), or falls back to defaults
 */
router.post('/packing/estimate-weight', (req, res) => {
  try {
    const { items = [] } = req.body;

    let totalWeight = 0;
    const breakdown = [];

    for (const item of items) {
      // Use provided weight (from order item) if available, otherwise fallback to defaults
      const unitWeight = item.weight || DEFAULT_PRODUCT_WEIGHTS[item.sku] || DEFAULT_PRODUCT_WEIGHTS.default;
      const itemWeight = unitWeight * (item.quantity || 1);
      totalWeight += itemWeight;

      breakdown.push({
        sku: item.sku,
        quantity: item.quantity,
        unitWeight,
        totalWeight: Math.round(itemWeight * 100) / 100
      });
    }

    // Add packaging weight (0.5 kg per carton box)
    const packagingWeight = 0.5;
    totalWeight += packagingWeight;

    res.json({
      success: true,
      estimatedWeight: Math.round(totalWeight * 100) / 100,
      packagingWeight,
      productWeight: Math.round((totalWeight - packagingWeight) * 100) / 100,
      breakdown
    });
  } catch (error) {
    console.error('[VendorAPI] POST /packing/estimate-weight error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/vendor/packing/suggest-cartons
 * @desc Suggest optimal carton breakdown based on packaging levels (master cartons, inner boxes)
 * @body groupId - Consolidation group ID
 * @returns Suggested cartons + remaining items for manual handling
 *
 * Algorithm:
 * For each SKU:
 *   1. Get packaging levels sorted by qty DESC (master carton first)
 *   2. For each level, calculate how many full cartons fit
 *   3. Remaining items go to "mix" for manual handling
 *
 * Example: SKU with Master=15, Inner=5, Ordered=22
 *   → 1 Master (15) + 1 Inner (5) + 2 remaining for mix
 */
router.post('/packing/suggest-cartons', async (req, res) => {
  try {
    const { groupId } = req.body;

    if (!groupId) {
      return res.status(400).json({ success: false, error: 'groupId is required' });
    }

    const db = getDb();

    // Parse the group ID to get the filter criteria
    const parsed = parseConsolidationGroupId(groupId);
    const { vendorGroup, fcPartyId, dateStr, isSeparate, poNumber } = parsed;

    // Build query (same logic as consolidate/:groupId endpoint)
    let query;
    if (isSeparate) {
      query = {
        channel: 'amazon-vendor',
        'sourceIds.amazonVendorPONumber': poNumber,
        'amazonVendor.consolidationOverride': true,
        'amazonVendor.purchaseOrderState': { $in: ['New', 'Acknowledged'] }
      };
    } else {
      query = {
        channel: 'amazon-vendor',
        'amazonVendor.shipToParty.partyId': fcPartyId,
        'amazonVendor.consolidationOverride': { $ne: true },
        'amazonVendor.purchaseOrderState': { $in: ['New', 'Acknowledged'] },
        'amazonVendor.shipmentStatus': 'not_shipped',
        'odoo.deliveryStatus': { $ne: 'full' }
      };

      if (vendorGroup && VENDOR_GROUPS[vendorGroup]) {
        query['marketplace.code'] = { $in: VENDOR_GROUPS[vendorGroup].marketplaces };
      }

      if (dateStr && dateStr !== 'nodate') {
        const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
        const endOfDay = new Date(dateStr + 'T00:00:00.000Z');
        endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
        query['amazonVendor.deliveryWindow.endDate'] = { $gte: startOfDay, $lt: endOfDay };
      }
    }

    // Test mode isolation
    if (isTestMode()) {
      query._testData = true;
    } else {
      query._testData = { $ne: true };
      if (!isSeparate) {
        query['sourceIds.amazonVendorPONumber'] = { $not: /^TST/ };
      }
    }

    const orders = await db.collection('unified_orders').find(query).toArray();

    if (orders.length === 0) {
      return res.status(404).json({ success: false, error: 'No orders found for this group' });
    }

    // Consolidate items by SKU
    const itemsBySku = {};
    for (const order of orders) {
      for (const item of (order.items || [])) {
        const sku = item.odooSku || item.vendorProductIdentifier;
        if (!sku) continue;

        const qty = item.acknowledgeQty ?? item.orderedQuantity?.amount ?? item.quantity ?? 0;

        if (!itemsBySku[sku]) {
          itemsBySku[sku] = {
            sku,
            ean: item.vendorProductIdentifier || item.odooBarcode,
            name: item.odooProductName || item.name || item.title || `Product ${sku}`,
            totalQty: 0,
            unitWeight: item.weight || 0.5, // Default 0.5kg if not specified
            odooProductId: item.odooProductId
          };
        }
        itemsBySku[sku].totalQty += qty;
      }
    }

    // Fetch weights from products collection
    const skuList = Object.keys(itemsBySku);
    const products = await db.collection('products').find(
      { sku: { $in: skuList } },
      { projection: { sku: 1, weight: 1, packaging: 1 } }
    ).toArray();

    const productData = {};
    for (const p of products) {
      productData[p.sku] = {
        weight: p.weight || 0.5,
        packaging: (p.packaging || []).sort((a, b) => b.qty - a.qty) // Sort by qty DESC
      };
    }

    // Generate suggested cartons
    const suggestedParcels = [];
    const remainingItems = [];
    let totalEstimatedWeight = 0;
    const PACKAGING_WEIGHT = 0.5; // kg per carton

    for (const [sku, item] of Object.entries(itemsBySku)) {
      let remaining = item.totalQty;
      const pData = productData[sku] || { weight: item.unitWeight, packaging: [] };
      const unitWeight = pData.weight || item.unitWeight || 0.5;
      const packaging = pData.packaging || [];

      // Process each packaging level (master carton first, then inner boxes)
      for (const pkg of packaging) {
        if (remaining <= 0) break;
        if (!pkg.qty || pkg.qty <= 0) continue;

        const fullCartons = Math.floor(remaining / pkg.qty);

        if (fullCartons > 0) {
          // Create individual parcels for each carton
          for (let i = 0; i < fullCartons; i++) {
            const parcelWeight = (unitWeight * pkg.qty) + PACKAGING_WEIGHT;
            suggestedParcels.push({
              type: 'packaging',
              packagingType: pkg.name || 'Carton',
              sku,
              ean: item.ean,
              name: item.name,
              qtyPerCarton: pkg.qty,
              unitWeight,
              estimatedWeight: Math.round(parcelWeight * 100) / 100,
              items: [{
                sku,
                ean: item.ean,
                name: item.name,
                quantity: pkg.qty,
                weight: unitWeight
              }]
            });
            totalEstimatedWeight += parcelWeight;
          }
          remaining -= fullCartons * pkg.qty;
        }
      }

      // Remaining items go to mix
      if (remaining > 0) {
        remainingItems.push({
          sku,
          ean: item.ean,
          name: item.name,
          qty: remaining,
          unitWeight,
          totalWeight: Math.round(remaining * unitWeight * 100) / 100
        });
      }
    }

    // Calculate total remaining weight (for mix parcels)
    const remainingWeight = remainingItems.reduce((sum, i) => sum + i.totalWeight, 0);

    res.json({
      success: true,
      suggestedParcels,
      remainingItems,
      summary: {
        totalSuggestedCartons: suggestedParcels.length,
        totalSuggestedUnits: suggestedParcels.reduce((sum, p) =>
          sum + p.items.reduce((s, i) => s + i.quantity, 0), 0),
        totalRemainingUnits: remainingItems.reduce((sum, i) => sum + i.qty, 0),
        estimatedCartonWeight: Math.round(totalEstimatedWeight * 100) / 100,
        estimatedRemainingWeight: Math.round(remainingWeight * 100) / 100,
        estimatedTotalWeight: Math.round((totalEstimatedWeight + remainingWeight) * 100) / 100
      }
    });

  } catch (error) {
    console.error('[VendorAPI] POST /packing/suggest-cartons error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/packing/gls-status
 * @desc Check if GLS integration is configured
 */
router.get('/packing/gls-status', async (req, res) => {
  try {
    let glsConfigured = false;
    let testResult = null;

    try {
      const glsClient = getGLSClient();
      glsConfigured = true;

      if (req.query.test === 'true') {
        testResult = await glsClient.testConnection();
      }
    } catch (err) {
      // GLS not configured
    }

    res.json({
      success: true,
      glsConfigured,
      message: glsConfigured
        ? 'GLS integration is configured'
        : 'GLS integration not configured - set GLS_USER_ID and GLS_PASSWORD in .env',
      testResult
    });
  } catch (error) {
    console.error('[VendorAPI] GET /packing/gls-status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/vendor/packing/carrier-status
 * @desc Check status of all configured shipping carriers
 */
router.get('/packing/carrier-status', async (req, res) => {
  try {
    const carriers = {
      gls: { configured: false, name: 'GLS', type: 'parcel' },
      dachser: { configured: false, name: 'Dachser', type: 'freight' }
    };

    // Check GLS
    try {
      const glsClient = getGLSClient();
      carriers.gls.configured = true;
      if (req.query.test === 'true') {
        carriers.gls.testResult = await glsClient.testConnection();
      }
    } catch (err) {
      carriers.gls.error = 'Not configured - set GLS_USER_ID and GLS_PASSWORD in .env';
    }

    // Check Dachser
    try {
      const { getDachserClient } = require('../../services/shipping/DachserClient');
      const dachserClient = getDachserClient();
      carriers.dachser.configured = dachserClient.isConfigured();
      if (req.query.test === 'true' && carriers.dachser.configured) {
        carriers.dachser.testResult = await dachserClient.testConnection();
      }
      if (!carriers.dachser.configured) {
        carriers.dachser.error = 'Not configured - set DACHSER_API_KEY and DACHSER_CUSTOMER_ID in .env';
      }
    } catch (err) {
      carriers.dachser.error = err.message;
    }

    // Determine available carriers
    const available = Object.entries(carriers)
      .filter(([, c]) => c.configured)
      .map(([code, c]) => ({ code, ...c }));

    res.json({
      success: true,
      carriers,
      available,
      defaultCarrier: available.length > 0 ? available[0].code : null
    });
  } catch (error) {
    console.error('[VendorAPI] GET /packing/carrier-status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
