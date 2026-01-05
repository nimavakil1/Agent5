/**
 * SellerTrackingPusher - Push FBM Tracking from Odoo to Amazon
 *
 * When an FBM order is shipped in Odoo:
 * 1. Detect validated pickings for FBM orders
 * 2. Extract tracking number from Odoo
 * 3. Send shipment confirmation to Amazon
 *
 * @module SellerTrackingPusher
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { getMarketplaceConfig: _getMarketplaceConfig } = require('./SellerMarketplaceConfig');

// Collection name for seller orders - DO NOT import from SellerOrderImporter (it uses unified_orders)
const SELLER_ORDERS_COLLECTION = 'seller_orders';

/**
 * Amazon Seller Sales Team IDs in Odoo
 * Orders with these team_ids should have tracking pushed to Amazon
 */
const AMAZON_SELLER_TEAM_IDS = [
  11,  // Amazon Seller
  5,   // Amazon Marketplace
  16,  // Amazon BE (Marketplace)
  17,  // Amazon DE (Marketplace)
  18,  // Amazon ES (Marketplace)
  19,  // Amazon FR (Marketplace)
  20,  // Amazon IT (Marketplace)
  21,  // Amazon NL (Marketplace)
  22,  // Amazon PL (Marketplace)
  24,  // Amazon SE (Marketplace)
  25,  // Amazon UK (Marketplace)
];

/**
 * Carrier name mapping from Odoo to Amazon
 * Amazon requires specific carrier codes
 */
const CARRIER_MAPPING = {
  // Common carriers
  'dhl': 'DHL',
  'dhl express': 'DHL',
  'dhl parcel': 'DHL',
  'ups': 'UPS',
  'fedex': 'FedEx',
  'tnt': 'TNT',
  'dpd': 'DPD',
  'gls': 'GLS',
  'bpost': 'BPOST',
  'postnl': 'PostNL',
  'chronopost': 'Chronopost',
  'colissimo': 'Colissimo',
  'la poste': 'La Poste',
  'royal mail': 'Royal Mail',
  'deutsche post': 'Deutsche Post',
  'hermes': 'Hermes',
  // Default
  'other': 'Other'
};

/**
 * SellerTrackingPusher - Pushes tracking from Odoo to Amazon
 */
class SellerTrackingPusher {
  constructor() {
    this.odoo = null;
    this.client = null;
    this.collection = null;
  }

  /**
   * Initialize the pusher
   */
  async init() {
    if (this.odoo && this.collection) return;

    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    this.client = getSellerClient();
    await this.client.init();

    const db = getDb();
    this.collection = db.collection(SELLER_ORDERS_COLLECTION);
  }

  /**
   * Push tracking for all FBM orders that have been shipped in Odoo
   * Uses Sales Team field to identify Amazon Seller orders (not order prefix)
   */
  async pushPendingTracking() {
    await this.init();

    const result = {
      checked: 0,
      pushed: 0,
      skipped: 0,
      alreadyPushed: 0,
      errors: []
    };

    try {
      // Step 1: Find done pickings with tracking for Amazon Seller orders (by Sales Team)
      // Query Odoo for sale orders with Amazon Seller team IDs
      const saleOrders = await this.odoo.searchRead('sale.order',
        [
          ['team_id', 'in', AMAZON_SELLER_TEAM_IDS],
          ['state', 'in', ['sale', 'done']]
        ],
        ['id', 'name', 'client_order_ref', 'team_id'],
        { limit: 500 }
      );

      if (saleOrders.length === 0) {
        console.log('[SellerTrackingPusher] No Amazon Seller orders found in Odoo');
        return result;
      }

      const saleOrderIds = saleOrders.map(so => so.id);
      const saleOrderMap = {};
      for (const so of saleOrders) {
        saleOrderMap[so.id] = so;
      }

      // Step 2: Find done pickings with tracking for these orders
      const pickings = await this.odoo.searchRead('stock.picking',
        [
          ['sale_id', 'in', saleOrderIds],
          ['picking_type_code', '=', 'outgoing'],
          ['state', '=', 'done'],
          ['carrier_tracking_ref', '!=', false]
        ],
        ['id', 'name', 'sale_id', 'carrier_tracking_ref', 'carrier_id', 'date_done'],
        { limit: 200 }
      );

      console.log(`[SellerTrackingPusher] Found ${pickings.length} done pickings with tracking for Amazon Seller orders`);
      result.checked = pickings.length;

      // Step 3: For each picking, check if tracking already pushed and push if not
      for (const picking of pickings) {
        const saleOrder = saleOrderMap[picking.sale_id[0]];
        if (!saleOrder) continue;

        // Extract Amazon Order ID from client_order_ref or sale order name
        const amazonOrderId = this.extractAmazonOrderId(saleOrder);
        if (!amazonOrderId) {
          console.log(`[SellerTrackingPusher] Could not extract Amazon Order ID from ${saleOrder.name}`);
          result.skipped++;
          continue;
        }

        try {
          // Check if already pushed in MongoDB
          const existingOrder = await this.collection.findOne({
            amazonOrderId: amazonOrderId,
            'odoo.trackingPushed': true
          });

          if (existingOrder) {
            result.alreadyPushed++;
            continue;
          }

          // Get order from MongoDB for marketplace and item details
          let mongoOrder = await this.collection.findOne({ amazonOrderId: amazonOrderId });

          if (!mongoOrder) {
            // Order not in MongoDB - try to find by partial match or skip
            console.log(`[SellerTrackingPusher] Order ${amazonOrderId} not found in MongoDB, skipping`);
            result.skipped++;
            continue;
          }

          // Push tracking
          const pushResult = await this.pushPickingTracking(mongoOrder, picking);

          if (pushResult.pushed) {
            result.pushed++;
          } else if (pushResult.skipped) {
            result.skipped++;
          }
        } catch (error) {
          result.errors.push({
            amazonOrderId: amazonOrderId,
            picking: picking.name,
            error: error.message
          });
          console.error(`[SellerTrackingPusher] Error pushing ${amazonOrderId}:`, error.message);
        }
      }

    } catch (error) {
      result.errors.push({ error: error.message });
      console.error('[SellerTrackingPusher] Push error:', error);
    }

    console.log(`[SellerTrackingPusher] Push complete: ${result.pushed} pushed, ${result.skipped} skipped, ${result.alreadyPushed} already pushed, ${result.errors.length} errors`);
    return result;
  }

  /**
   * Extract Amazon Order ID from Odoo sale order
   * Looks in client_order_ref first, then tries to parse from order name
   */
  extractAmazonOrderId(saleOrder) {
    // Try client_order_ref first (e.g., "303-1234567-1234567")
    if (saleOrder.client_order_ref) {
      const ref = saleOrder.client_order_ref.trim();
      // Amazon order ID pattern: XXX-XXXXXXX-XXXXXXX
      const match = ref.match(/\d{3}-\d{7}-\d{7}/);
      if (match) return match[0];
    }

    // Try to extract from order name (e.g., "FBM303-1234567-1234567" or "S12345")
    const name = saleOrder.name || '';

    // Check for FBM/FBA prefix pattern
    const fbmMatch = name.match(/FB[MA](\d{3}-\d{7}-\d{7})/);
    if (fbmMatch) return fbmMatch[1];

    // Check for plain Amazon order ID in name
    const plainMatch = name.match(/\d{3}-\d{7}-\d{7}/);
    if (plainMatch) return plainMatch[0];

    return null;
  }

  /**
   * Push tracking for a specific picking
   */
  async pushPickingTracking(order, picking) {
    const result = { pushed: false, skipped: false };

    const trackingNumber = picking.carrier_tracking_ref;
    if (!trackingNumber) {
      result.skipped = true;
      return result;
    }

    // Get carrier name
    let carrierName = 'Other';
    if (picking.carrier_id) {
      const carriers = await this.odoo.searchRead('delivery.carrier',
        [['id', '=', picking.carrier_id[0]]],
        ['name']
      );
      if (carriers.length > 0) {
        carrierName = this.mapCarrier(carriers[0].name);
      }
    }

    // Get ship date
    const shipDate = picking.date_done
      ? new Date(picking.date_done).toISOString()
      : new Date().toISOString();

    console.log(`[SellerTrackingPusher] Pushing tracking for ${order.amazonOrderId}: ${trackingNumber} via ${carrierName}`);

    try {
      // Send to Amazon
      const confirmResult = await this.confirmShipment(order, {
        trackingNumber,
        carrierName,
        shipDate,
        pickingId: picking.id
      });

      if (confirmResult.success) {
        // Update MongoDB
        await this.collection.updateOne(
          { amazonOrderId: order.amazonOrderId },
          {
            $set: {
              'odoo.trackingPushed': true,
              'odoo.trackingNumber': trackingNumber,
              'odoo.carrierName': carrierName,
              'odoo.trackingPushedAt': new Date(),
              'odoo.pickingId': picking.id,
              'odoo.pickingName': picking.name
            }
          }
        );

        result.pushed = true;
        console.log(`[SellerTrackingPusher] Successfully pushed tracking for ${order.amazonOrderId}`);
      } else {
        throw new Error(confirmResult.error || 'Unknown error');
      }

    } catch (error) {
      console.error(`[SellerTrackingPusher] Error confirming shipment for ${order.amazonOrderId}:`, error.message);
      throw error;
    }

    return result;
  }

  /**
   * Map Odoo carrier name to Amazon carrier code
   */
  mapCarrier(odooCarrierName) {
    if (!odooCarrierName) return 'Other';

    const lowerName = odooCarrierName.toLowerCase();

    for (const [key, value] of Object.entries(CARRIER_MAPPING)) {
      if (lowerName.includes(key)) {
        return value;
      }
    }

    return 'Other';
  }

  /**
   * Confirm shipment with Amazon
   */
  async confirmShipment(order, shipmentData) {
    const { trackingNumber, carrierName, shipDate, pickingId } = shipmentData;

    const marketplaceId = order.marketplaceId;

    // Get order items for the shipment
    const orderItemIds = order.items?.map(item => item.orderItemId) || [];

    if (orderItemIds.length === 0) {
      return { success: false, error: 'No order items found' };
    }

    // Build package details per Amazon API spec
    // packageReferenceId MUST be a positive numeric value (Amazon requirement)
    // We use Odoo picking ID as a unique numeric identifier
    const packageReferenceId = pickingId.toString();

    const packageDetail = {
      packageReferenceId: packageReferenceId,
      carrierCode: carrierName,
      trackingNumber: trackingNumber,
      shipDate: shipDate,
      orderItems: orderItemIds.map(orderItemId => ({
        orderItemId,
        quantity: order.items.find(i => i.orderItemId === orderItemId)?.quantityOrdered || 1
      }))
    };

    // Use SellerClient's confirmShipment method
    return await this.client.confirmShipment(
      order.amazonOrderId,
      marketplaceId,
      packageDetail
    );
  }

  /**
   * Get push statistics
   * Now uses Odoo Sales Team to identify Amazon Seller orders
   */
  async getStats() {
    await this.init();

    // Get stats from Odoo (source of truth for orders)
    const saleOrders = await this.odoo.searchRead('sale.order',
      [
        ['team_id', 'in', AMAZON_SELLER_TEAM_IDS],
        ['state', 'in', ['sale', 'done']]
      ],
      ['id'],
      { limit: 10000 }
    );

    const saleOrderIds = saleOrders.map(so => so.id);

    // Count pickings with tracking
    const pickingsWithTracking = await this.odoo.searchRead('stock.picking',
      [
        ['sale_id', 'in', saleOrderIds],
        ['picking_type_code', '=', 'outgoing'],
        ['state', '=', 'done'],
        ['carrier_tracking_ref', '!=', false]
      ],
      ['id'],
      { limit: 10000 }
    );

    // Count from MongoDB
    const pushed = await this.collection.countDocuments({
      'odoo.trackingPushed': true
    });

    return {
      totalAmazonSellerOrders: saleOrders.length,
      pickingsWithTracking: pickingsWithTracking.length,
      pushedToAmazon: pushed,
      pendingPush: Math.max(0, pickingsWithTracking.length - pushed)
    };
  }
}

// Singleton instance
let trackingPusherInstance = null;

/**
 * Get the singleton SellerTrackingPusher instance
 */
async function getSellerTrackingPusher() {
  if (!trackingPusherInstance) {
    trackingPusherInstance = new SellerTrackingPusher();
    await trackingPusherInstance.init();
  }
  return trackingPusherInstance;
}

module.exports = {
  SellerTrackingPusher,
  getSellerTrackingPusher,
  CARRIER_MAPPING,
  AMAZON_SELLER_TEAM_IDS
};
