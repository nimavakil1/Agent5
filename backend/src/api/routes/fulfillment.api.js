/**
 * Fulfillment API Routes
 *
 * CW Fulfillment module for unified order management:
 * - View orders ready to ship
 * - Snooze/unsnooze orders
 * - Sync with Odoo
 * - Print shipping labels
 */

const express = require('express');
const router = express.Router();
const FulfillmentOrder = require('../../models/FulfillmentOrder');
const { getFulfillmentSync } = require('../../services/fulfillment/FulfillmentSync');

// ============================================
// ORDER LISTING ENDPOINTS
// ============================================

/**
 * Get orders ready to fulfill
 * GET /api/fulfillment/orders
 *
 * Query params:
 * - status: pending|ready|processing|shipped|delivered|cancelled|on_hold
 * - channel: bol|amazon_vendor|amazon_seller|shopify|direct
 * - marketplace: DE|FR|NL|BE|etc
 * - priority: low|normal|high|urgent
 * - includeSnoozed: true to include snoozed orders
 * - snoozedOnly: true to show only snoozed orders
 * - limit: number (default 50)
 * - offset: number (default 0)
 */
router.get('/orders', async (req, res) => {
  try {
    const {
      status,
      channel,
      marketplace,
      priority,
      includeSnoozed,
      snoozedOnly,
      search,
      limit = 50,
      offset = 0
    } = req.query;

    // Build query
    const query = {};

    // Status filter
    if (status) {
      query.status = status;
    } else if (!snoozedOnly) {
      // Default: show ready and processing orders
      query.status = { $in: ['ready', 'processing', 'pending'] };
    }

    // Channel filter
    if (channel) {
      query.channel = channel;
    }

    // Marketplace filter
    if (marketplace) {
      query.marketplace = marketplace;
    }

    // Priority filter
    if (priority) {
      query.priority = priority;
    }

    // Snooze filter
    if (snoozedOnly === 'true') {
      query['snooze.isSnoozed'] = true;
    } else if (includeSnoozed !== 'true') {
      // Exclude snoozed by default (unless expired)
      query.$or = [
        { 'snooze.isSnoozed': false },
        { 'snooze.isSnoozed': { $exists: false } },
        { 'snooze.isSnoozed': true, 'snooze.snoozedUntil': { $lt: new Date() }, 'snooze.autoUnsnooze': true }
      ];
    }

    // Search filter
    if (search) {
      query.$or = [
        { 'odoo.saleOrderName': { $regex: search, $options: 'i' } },
        { channelOrderId: { $regex: search, $options: 'i' } },
        { channelOrderRef: { $regex: search, $options: 'i' } },
        { 'customer.name': { $regex: search, $options: 'i' } },
        { 'shipment.trackingNumber': { $regex: search, $options: 'i' } }
      ];
    }

    // Execute query
    const [orders, total] = await Promise.all([
      FulfillmentOrder.find(query)
        .sort({ priority: -1, latestShipDate: 1, orderDate: -1 })
        .skip(parseInt(offset))
        .limit(parseInt(limit))
        .lean(),
      FulfillmentOrder.countDocuments(query)
    ]);

    // Add computed fields
    const enrichedOrders = orders.map(order => ({
      ...order,
      isLate: order.latestShipDate && new Date() > new Date(order.latestShipDate) && !['shipped', 'delivered'].includes(order.status),
      snoozeExpired: order.snooze?.isSnoozed && order.snooze.snoozedUntil && new Date() > new Date(order.snooze.snoozedUntil)
    }));

    res.json({
      success: true,
      orders: enrichedOrders,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
      hasMore: parseInt(offset) + orders.length < total
    });

  } catch (error) {
    console.error('[Fulfillment API] Error fetching orders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single order by ID
 * GET /api/fulfillment/orders/:id
 */
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await FulfillmentOrder.findById(req.params.id).lean();

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get dashboard stats
 * GET /api/fulfillment/stats
 */
router.get('/stats', async (req, res) => {
  try {
    // Auto-unsnooze expired orders first
    const unsnoozed = await FulfillmentOrder.unsnoozeExpired();

    const [
      readyCount,
      processingCount,
      snoozedCount,
      lateCount,
      byChannel,
      byMarketplace
    ] = await Promise.all([
      FulfillmentOrder.countDocuments({
        status: 'ready',
        $or: [
          { 'snooze.isSnoozed': false },
          { 'snooze.isSnoozed': { $exists: false } }
        ]
      }),
      FulfillmentOrder.countDocuments({ status: 'processing' }),
      FulfillmentOrder.countDocuments({ 'snooze.isSnoozed': true }),
      FulfillmentOrder.countDocuments({
        latestShipDate: { $lt: new Date() },
        status: { $in: ['ready', 'processing', 'pending'] },
        'snooze.isSnoozed': { $ne: true }
      }),
      FulfillmentOrder.aggregate([
        { $match: { status: { $in: ['ready', 'processing'] }, 'snooze.isSnoozed': { $ne: true } } },
        { $group: { _id: '$channel', count: { $sum: 1 } } }
      ]),
      FulfillmentOrder.aggregate([
        { $match: { status: { $in: ['ready', 'processing'] }, 'snooze.isSnoozed': { $ne: true } } },
        { $group: { _id: '$marketplace', count: { $sum: 1 } } }
      ])
    ]);

    res.json({
      success: true,
      stats: {
        ready: readyCount,
        processing: processingCount,
        snoozed: snoozedCount,
        late: lateCount,
        total: readyCount + processingCount,
        byChannel: byChannel.reduce((acc, item) => {
          acc[item._id || 'unknown'] = item.count;
          return acc;
        }, {}),
        byMarketplace: byMarketplace.reduce((acc, item) => {
          acc[item._id || 'unknown'] = item.count;
          return acc;
        }, {}),
        autoUnsnoozed: unsnoozed
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// SNOOZE ENDPOINTS
// ============================================

/**
 * Snooze an order
 * POST /api/fulfillment/orders/:id/snooze
 *
 * Body: {
 *   until: ISO date string (optional, null = indefinite)
 *   reason: string (optional)
 * }
 */
router.post('/orders/:id/snooze', async (req, res) => {
  try {
    const { until, reason } = req.body;

    const order = await FulfillmentOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    await order.snoozeOrder({
      until: until ? new Date(until) : null,
      reason,
      userId: req.user?.email || 'unknown'
    });

    res.json({
      success: true,
      message: `Order ${order.odoo.saleOrderName} snoozed${until ? ' until ' + new Date(until).toLocaleDateString() : ' indefinitely'}`,
      order
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Unsnooze an order
 * POST /api/fulfillment/orders/:id/unsnooze
 */
router.post('/orders/:id/unsnooze', async (req, res) => {
  try {
    const order = await FulfillmentOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    await order.unsnoozeOrder();

    res.json({
      success: true,
      message: `Order ${order.odoo.saleOrderName} unsnoozed`,
      order
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Bulk snooze orders
 * POST /api/fulfillment/orders/bulk-snooze
 *
 * Body: {
 *   orderIds: string[]
 *   until: ISO date string (optional)
 *   reason: string (optional)
 * }
 */
router.post('/orders/bulk-snooze', async (req, res) => {
  try {
    const { orderIds, until, reason } = req.body;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ success: false, error: 'orderIds array required' });
    }

    const result = await FulfillmentOrder.updateMany(
      { _id: { $in: orderIds } },
      {
        $set: {
          'snooze.isSnoozed': true,
          'snooze.snoozedAt': new Date(),
          'snooze.snoozedBy': req.user?.email || 'unknown',
          'snooze.snoozedUntil': until ? new Date(until) : null,
          'snooze.reason': reason || '',
          'snooze.autoUnsnooze': true,
          updatedAt: new Date()
        }
      }
    );

    res.json({
      success: true,
      message: `Snoozed ${result.modifiedCount} orders`,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Bulk unsnooze orders
 * POST /api/fulfillment/orders/bulk-unsnooze
 */
router.post('/orders/bulk-unsnooze', async (req, res) => {
  try {
    const { orderIds } = req.body;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ success: false, error: 'orderIds array required' });
    }

    const result = await FulfillmentOrder.updateMany(
      { _id: { $in: orderIds } },
      {
        $set: {
          'snooze.isSnoozed': false,
          updatedAt: new Date()
        }
      }
    );

    res.json({
      success: true,
      message: `Unsnoozed ${result.modifiedCount} orders`,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// SYNC ENDPOINTS
// ============================================

/**
 * Trigger sync from Odoo
 * POST /api/fulfillment/sync
 *
 * Body: {
 *   fullSync: boolean (optional, default false)
 *   limit: number (optional, default 500)
 * }
 */
router.post('/sync', async (req, res) => {
  try {
    const { fullSync = false, limit = 500 } = req.body;

    const sync = getFulfillmentSync();
    await sync.init();

    const result = await sync.syncOrders({ fullSync, limit });

    res.json({
      success: true,
      message: `Synced ${result.synced} orders (${result.errors} errors)`,
      ...result
    });
  } catch (error) {
    console.error('[Fulfillment API] Sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Sync a specific order
 * POST /api/fulfillment/sync/:saleOrderId
 */
router.post('/sync/:saleOrderId', async (req, res) => {
  try {
    const sync = getFulfillmentSync();
    await sync.init();

    const order = await sync.syncOrderById(parseInt(req.params.saleOrderId));

    res.json({
      success: true,
      message: `Synced order ${order.odoo.saleOrderName}`,
      order
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Run historical sync (all orders since 01/01/2024)
 * POST /api/fulfillment/sync-historical
 *
 * This is a long-running operation. The response returns immediately
 * with status, and the sync continues in the background.
 */
router.post('/sync-historical', async (req, res) => {
  try {
    const sync = getFulfillmentSync();

    // Check if already running
    if (sync.isHistoricalSyncRunning) {
      return res.json({
        success: false,
        message: 'Historical sync already in progress',
        isRunning: true
      });
    }

    // Check if already completed
    if (sync.historicalSyncCompleted) {
      return res.json({
        success: false,
        message: 'Historical sync already completed. Use regular sync for updates.',
        isCompleted: true
      });
    }

    // Start the sync in background (don't await)
    sync.runHistoricalSync().then(result => {
      console.log('[Fulfillment API] Historical sync completed:', result);
    }).catch(err => {
      console.error('[Fulfillment API] Historical sync error:', err);
    });

    res.json({
      success: true,
      message: 'Historical sync started. This will sync all orders since 01/01/2024.',
      isRunning: true
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get historical sync status
 * GET /api/fulfillment/sync-historical/status
 */
router.get('/sync-historical/status', async (req, res) => {
  try {
    const sync = getFulfillmentSync();

    res.json({
      success: true,
      isRunning: sync.isHistoricalSyncRunning,
      isCompleted: sync.historicalSyncCompleted
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Cleanup FBA orders from fulfillment queue
 * POST /api/fulfillment/cleanup-fba
 *
 * Removes orders that are not from CW warehouse (FBA orders are fulfilled by Amazon)
 */
router.post('/cleanup-fba', async (req, res) => {
  try {
    const sync = getFulfillmentSync();
    const result = await sync.cleanupFbaOrders();

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ORDER ACTIONS
// ============================================

/**
 * Update order status
 * PUT /api/fulfillment/orders/:id/status
 *
 * Body: { status: 'ready'|'processing'|'on_hold'|etc }
 */
router.put('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;

    const validStatuses = ['pending', 'ready', 'processing', 'shipped', 'delivered', 'cancelled', 'on_hold'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const order = await FulfillmentOrder.findByIdAndUpdate(
      req.params.id,
      { status, updatedAt: new Date() },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({
      success: true,
      message: `Order ${order.odoo.saleOrderName} status updated to ${status}`,
      order
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update order priority
 * PUT /api/fulfillment/orders/:id/priority
 *
 * Body: { priority: 'low'|'normal'|'high'|'urgent' }
 */
router.put('/orders/:id/priority', async (req, res) => {
  try {
    const { priority } = req.body;

    const validPriorities = ['low', 'normal', 'high', 'urgent'];
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({ success: false, error: `Invalid priority. Must be one of: ${validPriorities.join(', ')}` });
    }

    const order = await FulfillmentOrder.findByIdAndUpdate(
      req.params.id,
      { priority, updatedAt: new Date() },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({
      success: true,
      message: `Order ${order.odoo.saleOrderName} priority updated to ${priority}`,
      order
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Add note to order
 * POST /api/fulfillment/orders/:id/notes
 *
 * Body: { note: string, internal: boolean }
 */
router.post('/orders/:id/notes', async (req, res) => {
  try {
    const { note, internal = false } = req.body;

    const update = internal
      ? { internalNotes: note }
      : { notes: note };

    const order = await FulfillmentOrder.findByIdAndUpdate(
      req.params.id,
      { ...update, updatedAt: new Date() },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
