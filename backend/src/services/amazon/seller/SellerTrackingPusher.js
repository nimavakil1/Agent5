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
const { COLLECTION_NAME } = require('./SellerOrderImporter');
const { getMarketplaceConfig } = require('./SellerMarketplaceConfig');

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
    this.collection = db.collection(COLLECTION_NAME);
  }

  /**
   * Push tracking for all FBM orders that have been shipped in Odoo
   */
  async pushPendingTracking() {
    await this.init();

    const result = {
      checked: 0,
      pushed: 0,
      skipped: 0,
      errors: []
    };

    try {
      // Find FBM orders that have Odoo orders but tracking not pushed
      const fbmOrders = await this.collection.find({
        fulfillmentChannel: 'MFN', // FBM orders only
        'odoo.saleOrderId': { $ne: null },
        'odoo.trackingPushed': { $ne: true }
      }).limit(100).toArray();

      console.log(`[SellerTrackingPusher] Found ${fbmOrders.length} FBM orders to check`);
      result.checked = fbmOrders.length;

      for (const order of fbmOrders) {
        try {
          const pushResult = await this.pushOrderTracking(order);

          if (pushResult.pushed) {
            result.pushed++;
          } else if (pushResult.skipped) {
            result.skipped++;
          }
        } catch (error) {
          result.errors.push({
            amazonOrderId: order.amazonOrderId,
            error: error.message
          });
          console.error(`[SellerTrackingPusher] Error pushing ${order.amazonOrderId}:`, error.message);
        }
      }

    } catch (error) {
      result.errors.push({ error: error.message });
      console.error('[SellerTrackingPusher] Push error:', error);
    }

    console.log(`[SellerTrackingPusher] Push complete: ${result.pushed} pushed, ${result.skipped} skipped, ${result.errors.length} errors`);
    return result;
  }

  /**
   * Push tracking for a single order
   */
  async pushOrderTracking(order) {
    const result = { pushed: false, skipped: false };

    const saleOrderId = order.odoo.saleOrderId;

    // Find the delivery picking for this order
    const pickings = await this.odoo.searchRead('stock.picking',
      [
        ['sale_id', '=', saleOrderId],
        ['picking_type_code', '=', 'outgoing'],
        ['state', '=', 'done'] // Only done pickings
      ],
      ['id', 'name', 'carrier_tracking_ref', 'carrier_id', 'date_done']
    );

    if (pickings.length === 0) {
      // Not shipped yet in Odoo
      result.skipped = true;
      return result;
    }

    const picking = pickings[0];
    const trackingNumber = picking.carrier_tracking_ref;

    if (!trackingNumber) {
      // No tracking number available
      console.log(`[SellerTrackingPusher] No tracking number for order ${order.amazonOrderId}`);
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
      ? new Date(picking.date_done).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    console.log(`[SellerTrackingPusher] Pushing tracking for ${order.amazonOrderId}: ${trackingNumber} via ${carrierName}`);

    try {
      // Send to Amazon
      const confirmResult = await this.confirmShipment(order, {
        trackingNumber,
        carrierName,
        shipDate
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
              'odoo.pickingId': picking.id
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
    const { trackingNumber, carrierName, shipDate } = shipmentData;

    const marketplaceId = order.marketplaceId;

    // Get order items for the shipment
    const orderItemIds = order.items?.map(item => item.orderItemId) || [];

    if (orderItemIds.length === 0) {
      return { success: false, error: 'No order items found' };
    }

    // Build package details per Amazon API spec
    const packageDetail = {
      packageReferenceId: `PKG-${order.amazonOrderId}`,
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
   */
  async getStats() {
    await this.init();

    const [
      totalFbmWithOdoo,
      pendingPush,
      pushed
    ] = await Promise.all([
      this.collection.countDocuments({
        fulfillmentChannel: 'MFN',
        'odoo.saleOrderId': { $ne: null }
      }),
      this.collection.countDocuments({
        fulfillmentChannel: 'MFN',
        'odoo.saleOrderId': { $ne: null },
        'odoo.trackingPushed': { $ne: true }
      }),
      this.collection.countDocuments({
        fulfillmentChannel: 'MFN',
        'odoo.trackingPushed': true
      })
    ]);

    return {
      totalFbmWithOdoo,
      pendingPush,
      pushed
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
  CARRIER_MAPPING
};
