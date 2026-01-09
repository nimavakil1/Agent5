/**
 * FulfillmentSync - Sync orders from Odoo to FulfillmentOrder collection
 *
 * Pulls sale orders from Odoo and creates/updates FulfillmentOrder records.
 * Detects the source channel based on order name/reference patterns.
 *
 * Scheduling:
 * - Regular sync: Every 15 minutes (incremental, last 24 hours)
 * - Historical sync: One-time at 2:00 AM for orders since 01/01/2024
 *
 * @module FulfillmentSync
 */

const cron = require('node-cron');
const FulfillmentOrder = require('../../models/FulfillmentOrder');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// Channel detection patterns
const CHANNEL_PATTERNS = {
  amazon_vendor: /^(AMZ|VDR)/i,
  amazon_seller: /^(FBM|FBA|AMZ-S)/i,
  bol: /^BOL/i,
  shopify: /^SHOP/i
};

// Historical sync start date
const HISTORICAL_START_DATE = new Date('2024-01-01T00:00:00Z');

class FulfillmentSync {
  constructor() {
    this.odoo = null;
    this.lastSyncTime = null;
    this.regularCronJob = null;
    this.historicalCronJob = null;
    this.isHistoricalSyncRunning = false;
    this.historicalSyncCompleted = false;
  }

  /**
   * Initialize the sync service
   */
  async init() {
    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();
    console.log('[FulfillmentSync] Initialized');
    return this;
  }

  /**
   * Detect channel from order name/reference
   */
  detectChannel(orderName, clientOrderRef) {
    const ref = clientOrderRef || orderName || '';

    for (const [channel, pattern] of Object.entries(CHANNEL_PATTERNS)) {
      if (pattern.test(ref) || pattern.test(orderName)) {
        return channel;
      }
    }

    return 'direct';
  }

  /**
   * Detect marketplace from order or partner
   */
  detectMarketplace(order, partner) {
    // Try to extract from order name (e.g., "BOL-NL-12345" or "AMZ-DE-12345")
    const nameMatch = (order.name || '').match(/-(DE|FR|IT|ES|NL|BE|PL|SE|UK|AT|CZ)-/i);
    if (nameMatch) {
      return nameMatch[1].toUpperCase();
    }

    // Try from client_order_ref
    const refMatch = (order.client_order_ref || '').match(/-(DE|FR|IT|ES|NL|BE|PL|SE|UK|AT|CZ)-/i);
    if (refMatch) {
      return refMatch[1].toUpperCase();
    }

    // Fallback to partner country
    if (partner?.country_id?.[1]) {
      const countryMap = {
        'Germany': 'DE', 'France': 'FR', 'Italy': 'IT', 'Spain': 'ES',
        'Netherlands': 'NL', 'Belgium': 'BE', 'Poland': 'PL', 'Sweden': 'SE',
        'United Kingdom': 'UK', 'Austria': 'AT', 'Czech Republic': 'CZ'
      };
      return countryMap[partner.country_id[1]] || null;
    }

    return null;
  }

  /**
   * Map Odoo order state to fulfillment status
   */
  mapStatus(odooState, pickingState) {
    // Check picking state first (more granular)
    if (pickingState === 'done') return 'shipped';
    if (pickingState === 'cancel') return 'cancelled';
    if (pickingState === 'assigned') return 'ready';
    if (pickingState === 'confirmed' || pickingState === 'waiting') return 'pending';

    // Fallback to order state
    const stateMap = {
      'draft': 'pending',
      'sent': 'pending',
      'sale': 'ready',
      'done': 'shipped',
      'cancel': 'cancelled'
    };

    return stateMap[odooState] || 'pending';
  }

  /**
   * Sync orders from Odoo
   *
   * @param {Object} options - Sync options
   * @param {Date} options.since - Only sync orders modified since this date
   * @param {Array} options.states - Order states to sync (default: sale, done)
   * @param {number} options.limit - Max orders to sync
   * @param {boolean} options.fullSync - Force full sync (ignore since date)
   */
  async syncOrders(options = {}) {
    const {
      since = this.lastSyncTime || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days default
      states = ['sale', 'done'],
      limit = 500,
      fullSync = false
    } = options;

    console.log(`[FulfillmentSync] Starting sync (since: ${fullSync ? 'full' : since.toISOString()})`);

    const results = {
      synced: 0,
      created: 0,
      updated: 0,
      errors: 0,
      errorDetails: []
    };

    try {
      // Build domain for Odoo query
      // IMPORTANT: Only sync orders from CW warehouse (ID 1)
      // FBA orders use FBA warehouses and are fulfilled by Amazon, not CW
      const CW_WAREHOUSE_ID = 1;
      const domain = [
        ['state', 'in', states],
        ['warehouse_id', '=', CW_WAREHOUSE_ID]
      ];

      if (!fullSync && since) {
        domain.push(['write_date', '>=', since.toISOString().replace('T', ' ').split('.')[0]]);
      }

      // Fetch orders from Odoo
      const orders = await this.odoo.searchRead('sale.order', domain, [
        'id', 'name', 'client_order_ref', 'partner_id', 'partner_shipping_id',
        'date_order', 'commitment_date', 'amount_total', 'currency_id',
        'state', 'warehouse_id', 'carrier_id', 'picking_ids',
        'order_line', 'note', 'team_id'
      ], { limit, order: 'date_order desc' });

      console.log(`[FulfillmentSync] Found ${orders.length} orders to sync`);

      // Process each order
      for (const order of orders) {
        try {
          await this.syncSingleOrder(order);
          results.synced++;
        } catch (error) {
          results.errors++;
          results.errorDetails.push({
            orderId: order.id,
            orderName: order.name,
            error: error.message
          });
          console.error(`[FulfillmentSync] Error syncing order ${order.name}:`, error.message);
        }
      }

      // Count created vs updated
      results.created = results.synced - results.updated;

      this.lastSyncTime = new Date();
      console.log(`[FulfillmentSync] Sync complete: ${results.synced} synced, ${results.errors} errors`);

    } catch (error) {
      console.error('[FulfillmentSync] Sync failed:', error);
      throw error;
    }

    return results;
  }

  /**
   * Sync a single order from Odoo
   */
  async syncSingleOrder(order) {
    // Get partner details
    let partner = null;
    let shippingPartner = null;

    if (order.partner_id?.[0]) {
      const partners = await this.odoo.searchRead('res.partner',
        [['id', '=', order.partner_id[0]]],
        ['name', 'email', 'phone', 'street', 'street2', 'city', 'zip', 'state_id', 'country_id', 'is_company', 'parent_id']
      );
      partner = partners[0];

      // If partner has a parent company, fetch the company name
      if (partner?.parent_id?.[0]) {
        const parentCompanies = await this.odoo.searchRead('res.partner',
          [['id', '=', partner.parent_id[0]]],
          ['name']
        );
        if (parentCompanies[0]) {
          partner.companyName = parentCompanies[0].name;
        }
      }
    }

    if (order.partner_shipping_id?.[0] && order.partner_shipping_id[0] !== order.partner_id?.[0]) {
      const shippingPartners = await this.odoo.searchRead('res.partner',
        [['id', '=', order.partner_shipping_id[0]]],
        ['name', 'email', 'phone', 'street', 'street2', 'city', 'zip', 'state_id', 'country_id', 'is_company', 'parent_id']
      );
      shippingPartner = shippingPartners[0];

      // If shipping partner has a parent company, fetch the company name
      if (shippingPartner?.parent_id?.[0]) {
        const parentCompanies = await this.odoo.searchRead('res.partner',
          [['id', '=', shippingPartner.parent_id[0]]],
          ['name']
        );
        if (parentCompanies[0]) {
          shippingPartner.companyName = parentCompanies[0].name;
        }
      }
    } else {
      shippingPartner = partner;
    }

    // Get order lines
    let orderLines = [];
    if (order.order_line?.length > 0) {
      orderLines = await this.odoo.searchRead('sale.order.line',
        [['id', 'in', order.order_line]],
        ['product_id', 'name', 'product_uom_qty', 'qty_delivered', 'price_unit', 'price_subtotal']
      );
    }

    // Get picking (delivery) info
    let picking = null;
    if (order.picking_ids?.length > 0) {
      const pickings = await this.odoo.searchRead('stock.picking',
        [['id', 'in', order.picking_ids], ['picking_type_code', '=', 'outgoing']],
        ['name', 'state', 'scheduled_date', 'carrier_id', 'carrier_tracking_ref']
      );
      // Get the first outgoing picking
      picking = pickings[0];
    }

    // Detect channel and marketplace
    const channel = this.detectChannel(order.name, order.client_order_ref);
    const marketplace = this.detectMarketplace(order, partner);

    // Map order lines to items
    const items = orderLines.map(line => ({
      productId: line.product_id?.[0],
      name: line.name || line.product_id?.[1] || 'Unknown',
      quantity: line.product_uom_qty || 1,
      quantityDelivered: line.qty_delivered || 0,
      unitPrice: line.price_unit,
      totalPrice: line.price_subtotal
    }));

    // Build fulfillment order data
    const fulfillmentData = {
      channel,
      channelOrderId: order.client_order_ref || order.name,
      channelOrderRef: order.client_order_ref,
      marketplace,

      odoo: {
        saleOrderId: order.id,
        saleOrderName: order.name,
        pickingId: picking?.id,
        pickingName: picking?.name,
        partnerId: partner?.id,
        partnerName: partner?.name,
        warehouseId: order.warehouse_id?.[0],
        warehouseName: order.warehouse_id?.[1],
        syncedAt: new Date()
      },

      orderDate: new Date(order.date_order),
      promisedDeliveryDate: order.commitment_date ? new Date(order.commitment_date) : null,

      customer: {
        name: partner?.name,
        email: partner?.email,
        phone: partner?.phone,
        // Company: use parent company name if available, otherwise use own name if it's a company
        company: partner?.companyName ||
          (partner?.is_company ? partner.name : null)
      },

      shippingAddress: {
        name: shippingPartner?.name,
        // Company: use parent company name if available, otherwise use own name if it's a company
        company: shippingPartner?.companyName ||
          (shippingPartner?.is_company ? shippingPartner.name : null),
        street: shippingPartner?.street,
        street2: shippingPartner?.street2,
        city: shippingPartner?.city,
        zip: shippingPartner?.zip,
        state: shippingPartner?.state_id?.[1],
        country: shippingPartner?.country_id?.[1]?.substring(0, 2)?.toUpperCase(),
        countryName: shippingPartner?.country_id?.[1]
      },

      items,
      itemCount: items.length,
      totalAmount: order.amount_total,
      currency: order.currency_id?.[1] || 'EUR',

      carrier: {
        code: order.carrier_id?.[1]?.toUpperCase()?.replace(/\s+/g, '_'),
        name: order.carrier_id?.[1]
      },

      status: this.mapStatus(order.state, picking?.state),

      shipment: {
        trackingNumber: picking?.carrier_tracking_ref,
        carrier: picking?.carrier_id?.[1],
        shippedAt: picking?.state === 'done' ? new Date() : null
      },

      notes: order.note,
      lastSyncedAt: new Date()
    };

    // Upsert the fulfillment order
    const result = await FulfillmentOrder.findOneAndUpdate(
      { 'odoo.saleOrderId': order.id },
      { $set: fulfillmentData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return result;
  }

  /**
   * Sync a specific order by Odoo sale order ID
   */
  async syncOrderById(saleOrderId) {
    const orders = await this.odoo.searchRead('sale.order',
      [['id', '=', saleOrderId]],
      [
        'id', 'name', 'client_order_ref', 'partner_id', 'partner_shipping_id',
        'date_order', 'commitment_date', 'amount_total', 'currency_id',
        'state', 'warehouse_id', 'carrier_id', 'picking_ids',
        'order_line', 'note', 'team_id'
      ]
    );

    if (orders.length === 0) {
      throw new Error(`Sale order ${saleOrderId} not found in Odoo`);
    }

    return this.syncSingleOrder(orders[0]);
  }

  /**
   * Get sync statistics
   */
  async getStats() {
    const stats = await FulfillmentOrder.aggregate([
      {
        $group: {
          _id: { channel: '$channel', status: '$status' },
          count: { $sum: 1 }
        }
      }
    ]);

    const snoozedCount = await FulfillmentOrder.countDocuments({ 'snooze.isSnoozed': true });
    const readyCount = await FulfillmentOrder.countDocuments({
      status: 'ready',
      'snooze.isSnoozed': { $ne: true }
    });

    return {
      byChannelAndStatus: stats,
      snoozed: snoozedCount,
      readyToShip: readyCount,
      lastSyncTime: this.lastSyncTime,
      historicalSyncCompleted: this.historicalSyncCompleted,
      isHistoricalSyncRunning: this.isHistoricalSyncRunning
    };
  }

  /**
   * Cleanup: Remove FBA orders from fulfillment collection
   * FBA orders are fulfilled by Amazon, not CW, so they shouldn't be in this queue
   */
  async cleanupFbaOrders() {
    await this.init();

    const CW_WAREHOUSE_ID = 1;
    const results = {
      checked: 0,
      removed: 0,
      errors: []
    };

    try {
      // Find all orders in our collection
      const orders = await FulfillmentOrder.find({}, { 'odoo.saleOrderId': 1, 'odoo.saleOrderName': 1 }).lean();
      results.checked = orders.length;

      console.log(`[FulfillmentSync] Checking ${orders.length} orders for FBA cleanup...`);

      for (const order of orders) {
        if (!order.odoo?.saleOrderId) continue;

        try {
          // Check warehouse in Odoo
          const odooOrders = await this.odoo.searchRead('sale.order',
            [['id', '=', order.odoo.saleOrderId]],
            ['warehouse_id']
          );

          if (odooOrders.length === 0) {
            // Order doesn't exist in Odoo anymore, remove it
            await FulfillmentOrder.deleteOne({ _id: order._id });
            results.removed++;
            continue;
          }

          const warehouseId = odooOrders[0].warehouse_id?.[0];
          if (warehouseId && warehouseId !== CW_WAREHOUSE_ID) {
            // Not CW warehouse (likely FBA), remove from fulfillment queue
            await FulfillmentOrder.deleteOne({ _id: order._id });
            results.removed++;
            console.log(`[FulfillmentSync] Removed FBA order ${order.odoo.saleOrderName} (warehouse: ${warehouseId})`);
          }
        } catch (error) {
          results.errors.push({ orderId: order.odoo?.saleOrderId, error: error.message });
        }
      }

      console.log(`[FulfillmentSync] Cleanup complete: ${results.removed} FBA orders removed`);
    } catch (error) {
      console.error('[FulfillmentSync] Cleanup failed:', error);
      results.error = error.message;
    }

    return results;
  }

  /**
   * Start the regular scheduled sync (every 15 minutes)
   */
  startScheduledSync() {
    if (this.regularCronJob) {
      this.regularCronJob.stop();
    }

    // Run every 15 minutes
    this.regularCronJob = cron.schedule('*/15 * * * *', async () => {
      console.log('[FulfillmentSync] Running scheduled sync...');
      try {
        await this.init();
        // Sync orders from last 24 hours
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await this.syncOrders({ since, limit: 200 });

        // Also auto-unsnooze expired orders
        const unsnoozed = await FulfillmentOrder.unsnoozeExpired();
        if (unsnoozed > 0) {
          console.log(`[FulfillmentSync] Auto-unsnoozed ${unsnoozed} orders`);
        }
      } catch (error) {
        console.error('[FulfillmentSync] Scheduled sync failed:', error.message);
      }
    });

    console.log('[FulfillmentSync] Regular sync scheduled (every 15 minutes)');
  }

  /**
   * Schedule historical sync at 2:00 AM (one-time)
   * Syncs all orders from 01/01/2024 to now
   */
  scheduleHistoricalSync() {
    if (this.historicalCronJob) {
      this.historicalCronJob.stop();
    }

    // Schedule for 2:00 AM
    this.historicalCronJob = cron.schedule('0 2 * * *', async () => {
      // Only run once
      if (this.historicalSyncCompleted) {
        console.log('[FulfillmentSync] Historical sync already completed, skipping');
        this.historicalCronJob.stop();
        return;
      }

      console.log('[FulfillmentSync] Starting historical sync (orders since 01/01/2024)...');
      await this.runHistoricalSync();

      // Stop the cron job after running once
      this.historicalCronJob.stop();
    }, {
      scheduled: true,
      timezone: 'Europe/Brussels'
    });

    console.log('[FulfillmentSync] Historical sync scheduled for 2:00 AM (Europe/Brussels)');
  }

  /**
   * Run the historical sync (all orders since 01/01/2024)
   * This can be called manually or via scheduled job
   */
  async runHistoricalSync() {
    if (this.isHistoricalSyncRunning) {
      console.log('[FulfillmentSync] Historical sync already in progress');
      return { success: false, error: 'Already running' };
    }

    this.isHistoricalSyncRunning = true;
    const startTime = Date.now();
    const results = {
      totalSynced: 0,
      totalErrors: 0,
      batches: 0,
      startDate: HISTORICAL_START_DATE.toISOString(),
      endDate: new Date().toISOString()
    };

    try {
      await this.init();

      // Process in batches to avoid memory issues
      const BATCH_SIZE = 100;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        console.log(`[FulfillmentSync] Historical sync batch ${results.batches + 1} (offset: ${offset})...`);

        // Fetch orders from Odoo (CW warehouse only)
        const CW_WAREHOUSE_ID = 1;
        const orders = await this.odoo.searchRead('sale.order',
          [
            ['state', 'in', ['sale', 'done']],
            ['warehouse_id', '=', CW_WAREHOUSE_ID],
            ['date_order', '>=', HISTORICAL_START_DATE.toISOString().replace('T', ' ').split('.')[0]]
          ],
          [
            'id', 'name', 'client_order_ref', 'partner_id', 'partner_shipping_id',
            'date_order', 'commitment_date', 'amount_total', 'currency_id',
            'state', 'warehouse_id', 'carrier_id', 'picking_ids',
            'order_line', 'note', 'team_id'
          ],
          { limit: BATCH_SIZE, offset, order: 'date_order asc' }
        );

        if (orders.length === 0) {
          hasMore = false;
          break;
        }

        // Process each order
        for (const order of orders) {
          try {
            await this.syncSingleOrder(order);
            results.totalSynced++;
          } catch (error) {
            results.totalErrors++;
            console.error(`[FulfillmentSync] Error syncing ${order.name}:`, error.message);
          }
        }

        results.batches++;
        offset += BATCH_SIZE;

        // Small delay between batches to avoid overloading Odoo
        await new Promise(resolve => setTimeout(resolve, 500));

        console.log(`[FulfillmentSync] Batch complete. Synced: ${results.totalSynced}, Errors: ${results.totalErrors}`);
      }

      this.historicalSyncCompleted = true;
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`[FulfillmentSync] Historical sync complete in ${duration}s. Total: ${results.totalSynced} orders, ${results.totalErrors} errors`);

    } catch (error) {
      console.error('[FulfillmentSync] Historical sync failed:', error);
      results.error = error.message;
    } finally {
      this.isHistoricalSyncRunning = false;
    }

    return results;
  }

  /**
   * Stop all scheduled jobs
   */
  stopScheduledSync() {
    if (this.regularCronJob) {
      this.regularCronJob.stop();
      this.regularCronJob = null;
    }
    if (this.historicalCronJob) {
      this.historicalCronJob.stop();
      this.historicalCronJob = null;
    }
    console.log('[FulfillmentSync] All scheduled syncs stopped');
  }
}

// Singleton instance
let instance = null;

function getFulfillmentSync() {
  if (!instance) {
    instance = new FulfillmentSync();
  }
  return instance;
}

module.exports = {
  FulfillmentSync,
  getFulfillmentSync
};
