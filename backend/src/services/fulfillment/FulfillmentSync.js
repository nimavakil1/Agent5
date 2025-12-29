/**
 * FulfillmentSync - Sync orders from Odoo to FulfillmentOrder collection
 *
 * Pulls sale orders from Odoo and creates/updates FulfillmentOrder records.
 * Detects the source channel based on order name/reference patterns.
 *
 * @module FulfillmentSync
 */

const FulfillmentOrder = require('../../models/FulfillmentOrder');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// Channel detection patterns
const CHANNEL_PATTERNS = {
  amazon_vendor: /^(AMZ|FBM|FBA|VDR)/i,
  amazon_seller: /^(FBM|FBA|AMZ-S)/i,
  bol: /^BOL/i,
  shopify: /^SHOP/i
};

class FulfillmentSync {
  constructor() {
    this.odoo = null;
    this.lastSyncTime = null;
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
      const domain = [
        ['state', 'in', states]
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
        ['name', 'email', 'phone', 'street', 'street2', 'city', 'zip', 'state_id', 'country_id', 'is_company']
      );
      partner = partners[0];
    }

    if (order.partner_shipping_id?.[0] && order.partner_shipping_id[0] !== order.partner_id?.[0]) {
      const shippingPartners = await this.odoo.searchRead('res.partner',
        [['id', '=', order.partner_shipping_id[0]]],
        ['name', 'email', 'phone', 'street', 'street2', 'city', 'zip', 'state_id', 'country_id']
      );
      shippingPartner = shippingPartners[0];
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
        company: partner?.is_company ? partner.name : null
      },

      shippingAddress: {
        name: shippingPartner?.name,
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
      lastSyncTime: this.lastSyncTime
    };
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
