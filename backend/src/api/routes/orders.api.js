/**
 * Unified Orders API
 *
 * Single API for all order types:
 * - Amazon Seller (FBA/FBM)
 * - Amazon Vendor
 * - Bol.com (FBB/FBR)
 * - Odoo Direct
 *
 * @module orders.api
 */

const express = require('express');
const router = express.Router();
const {
  getUnifiedOrderService,
  CHANNELS,
  SUB_CHANNELS,
  UNIFIED_STATUS
} = require('../../services/orders/UnifiedOrderService');

/**
 * GET /api/orders
 * List orders with filters
 *
 * Query params:
 * - channel: 'amazon-seller' | 'amazon-vendor' | 'bol' | 'odoo-direct'
 * - subChannel: 'FBA' | 'FBM' | 'FBB' | 'FBR' | 'VENDOR'
 * - status: unified status
 * - dateFrom, dateTo: date range
 * - search: search by order ID or customer name
 * - hasOdooOrder: true/false - filter by Odoo link
 * - limit, skip: pagination
 */
router.get('/', async (req, res) => {
  try {
    const service = getUnifiedOrderService();

    const filters = {};
    if (req.query.channel) filters.channel = req.query.channel;
    if (req.query.subChannel) filters.subChannel = req.query.subChannel;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.marketplace) filters.marketplace = req.query.marketplace;
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;
    if (req.query.search) filters.search = req.query.search;
    if (req.query.hasOdooOrder !== undefined) {
      filters.hasOdooOrder = req.query.hasOdooOrder === 'true';
    }

    const options = {
      limit: parseInt(req.query.limit) || 50,
      skip: parseInt(req.query.skip) || 0,
      sort: { orderDate: -1 }
    };

    const [orders, total] = await Promise.all([
      service.query(filters, options),
      service.count(filters)
    ]);

    res.json({
      success: true,
      orders,
      pagination: {
        total,
        limit: options.limit,
        skip: options.skip,
        hasMore: options.skip + orders.length < total
      }
    });
  } catch (error) {
    console.error('[OrdersAPI] Error listing orders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/stats
 * Get order statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const service = getUnifiedOrderService();

    const filters = {};
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;

    const stats = await service.getStats(filters);

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[OrdersAPI] Error getting stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/daily-stats
 * Get daily order counts
 */
router.get('/daily-stats', async (req, res) => {
  try {
    const service = getUnifiedOrderService();

    const days = parseInt(req.query.days) || 30;
    const channel = req.query.channel || null;

    const stats = await service.getDailyStats(days, channel);

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[OrdersAPI] Error getting daily stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/pending-odoo
 * Get orders that haven't been imported to Odoo yet
 */
router.get('/pending-odoo', async (req, res) => {
  try {
    const service = getUnifiedOrderService();
    const channel = req.query.channel || null;

    const orders = await service.getPendingOdooImport(channel);

    res.json({
      success: true,
      count: orders.length,
      orders
    });
  } catch (error) {
    console.error('[OrdersAPI] Error getting pending Odoo orders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/by-source/:type/:id
 * Find order by source ID
 *
 * Types:
 * - amazon: Amazon order ID
 * - vendor: Amazon Vendor PO number
 * - bol: Bol.com order ID
 * - odoo: Odoo sale order ID
 * - odoo-name: Odoo sale order name
 */
router.get('/by-source/:type/:id', async (req, res) => {
  try {
    const service = getUnifiedOrderService();
    const { type, id } = req.params;

    let order = null;

    switch (type) {
      case 'amazon':
        order = await service.getByAmazonOrderId(id);
        break;
      case 'vendor':
        order = await service.getByVendorPONumber(id);
        break;
      case 'bol':
        order = await service.getByBolOrderId(id);
        break;
      case 'odoo':
        order = await service.getByOdooSaleOrderId(parseInt(id));
        break;
      case 'odoo-name':
        order = await service.getByOdooSaleOrderName(id);
        break;
      default:
        return res.status(400).json({
          success: false,
          error: `Unknown source type: ${type}`
        });
    }

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
  } catch (error) {
    console.error('[OrdersAPI] Error finding order by source:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/:unifiedOrderId
 * Get a single order by unified ID
 */
router.get('/:unifiedOrderId', async (req, res) => {
  try {
    const service = getUnifiedOrderService();
    const order = await service.getByUnifiedId(req.params.unifiedOrderId);

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
  } catch (error) {
    console.error('[OrdersAPI] Error getting order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/orders/:unifiedOrderId/sync-odoo
 * Force sync Odoo data for an order
 */
router.post('/:unifiedOrderId/sync-odoo', async (req, res) => {
  try {
    const service = getUnifiedOrderService();
    const order = await service.getByUnifiedId(req.params.unifiedOrderId);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    if (!order.sourceIds.odooSaleOrderId) {
      return res.status(400).json({
        success: false,
        error: 'Order has no linked Odoo sale order'
      });
    }

    // Import OdooDirectClient and sync
    const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    // Fetch fresh Odoo data
    const saleOrders = await odoo.searchRead('sale.order',
      [['id', '=', order.sourceIds.odooSaleOrderId]],
      ['id', 'name', 'state', 'partner_id', 'warehouse_id', 'invoice_status', 'invoice_ids', 'picking_ids']
    );

    if (saleOrders.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Odoo sale order not found'
      });
    }

    const so = saleOrders[0];

    // Fetch invoices if any
    let invoices = [];
    if (so.invoice_ids && so.invoice_ids.length > 0) {
      const invoiceData = await odoo.searchRead('account.move',
        [['id', 'in', so.invoice_ids]],
        ['id', 'name', 'invoice_date', 'amount_total', 'state']
      );
      invoices = invoiceData.map(inv => ({
        id: inv.id,
        name: inv.name,
        date: inv.invoice_date,
        amount: inv.amount_total,
        state: inv.state
      }));
    }

    // Fetch pickings if any
    let pickings = [];
    if (so.picking_ids && so.picking_ids.length > 0) {
      const pickingData = await odoo.searchRead('stock.picking',
        [['id', 'in', so.picking_ids]],
        ['id', 'name', 'state', 'carrier_tracking_ref']
      );
      pickings = pickingData.map(p => ({
        id: p.id,
        name: p.name,
        state: p.state,
        trackingRef: p.carrier_tracking_ref
      }));
    }

    // Update unified order with fresh Odoo data
    const odooData = {
      saleOrderId: so.id,
      saleOrderName: so.name,
      state: so.state,
      partnerId: so.partner_id ? so.partner_id[0] : null,
      partnerName: so.partner_id ? so.partner_id[1] : null,
      warehouseId: so.warehouse_id ? so.warehouse_id[0] : null,
      invoiceStatus: so.invoice_status,
      invoices,
      pickings
    };

    await service.updateOdooData(order.unifiedOrderId, odooData);

    res.json({
      success: true,
      message: 'Odoo data synced',
      odoo: odooData
    });
  } catch (error) {
    console.error('[OrdersAPI] Error syncing Odoo data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/channels/list
 * Get list of available channels
 */
router.get('/channels/list', async (_req, res) => {
  res.json({
    success: true,
    channels: Object.values(CHANNELS),
    subChannels: Object.values(SUB_CHANNELS),
    statuses: Object.values(UNIFIED_STATUS)
  });
});

module.exports = router;
