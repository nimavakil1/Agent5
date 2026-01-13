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
const { getMarketplaceIdByCountry } = require('./SellerMarketplaceConfig');
const { getItemQuantity } = require('./SellerOrderSchema');
const { getOperationTracker, OPERATION_TYPES } = require('../../../core/monitoring');

// Collection name - unified_orders is the single source of truth
const UNIFIED_ORDERS_COLLECTION = 'unified_orders';

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
    this.collection = db.collection(UNIFIED_ORDERS_COLLECTION);
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
          // Check if already pushed in MongoDB (unified_orders schema)
          const existingOrder = await this.collection.findOne({
            'sourceIds.amazonOrderId': amazonOrderId,
            'amazonSeller.trackingPushed': true
          });

          if (existingOrder) {
            result.alreadyPushed++;
            continue;
          }

          // Get order from MongoDB for marketplace and item details (unified_orders schema)
          let mongoOrder = await this.collection.findOne({ 'sourceIds.amazonOrderId': amazonOrderId });

          if (!mongoOrder) {
            // Order not in MongoDB - try to find by partial match or skip
            console.log(`[SellerTrackingPusher] Order ${amazonOrderId} not found in MongoDB, skipping`);
            result.skipped++;
            continue;
          }

          // Adapt unified_orders structure to expected format
          // unified_orders stores amazonOrderId in sourceIds, marketplaceId in amazonSeller
          // If marketplaceId is missing, derive from country code
          let marketplaceId = mongoOrder.amazonSeller?.marketplaceId || mongoOrder.marketplace?.id;
          if (!marketplaceId && mongoOrder.marketplace?.code) {
            marketplaceId = getMarketplaceIdByCountry(mongoOrder.marketplace.code);
            console.log(`[SellerTrackingPusher] Resolved marketplaceId from code ${mongoOrder.marketplace.code}: ${marketplaceId}`);
          }

          mongoOrder = {
            ...mongoOrder,
            amazonOrderId: mongoOrder.sourceIds?.amazonOrderId,
            marketplaceId
          };

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

    // Record sync run for tracking health monitoring
    try {
      const { recordSyncRun } = require('../../alerts/TrackingAlertService');
      recordSyncRun('amazonFbm', result.errors.length === 0, {
        pushed: result.pushed,
        skipped: result.skipped,
        alreadyPushed: result.alreadyPushed,
        errors: result.errors.length
      });
    } catch (_) {
      // TrackingAlertService may not be initialized yet
    }

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
    const tracker = getOperationTracker();
    const op = tracker.start(OPERATION_TYPES.TRACKING_PUSH, {
      amazonOrderId: order.amazonOrderId,
      pickingName: picking.name,
      marketplace: order.marketplace?.code || 'unknown'
    });

    const trackingNumber = picking.carrier_tracking_ref;
    if (!trackingNumber) {
      result.skipped = true;
      op.skip('No tracking number');
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
        // Update MongoDB (unified_orders schema)
        await this.collection.updateOne(
          { 'sourceIds.amazonOrderId': order.amazonOrderId },
          {
            $set: {
              'amazonSeller.trackingPushed': true,
              'amazonSeller.trackingNumber': trackingNumber,
              'amazonSeller.carrierName': carrierName,
              'amazonSeller.trackingPushedAt': new Date(),
              'amazonSeller.pickingId': picking.id,
              'amazonSeller.pickingName': picking.name,
              'status.unified': 'shipped'
            }
          }
        );

        result.pushed = true;
        op.complete({ trackingNumber, carrierName });
        console.log(`[SellerTrackingPusher] Successfully pushed tracking for ${order.amazonOrderId}`);
      } else {
        throw new Error(confirmResult.error || 'Unknown error');
      }

    } catch (error) {
      // Check if error indicates order is already shipped/fulfilled
      const errorMsg = error.message || '';
      const isAlreadyShipped = errorMsg.includes('PackageToUpdateNotFound') ||
                               errorMsg.includes('already fulfilled') ||
                               errorMsg.includes('already shipped') ||
                               errorMsg.includes('InvalidPackageVersion') ||
                               errorMsg.includes('maximum number of allowed updates');

      if (isAlreadyShipped) {
        // Mark as pushed since Amazon already has this as shipped (unified_orders schema)
        console.log(`[SellerTrackingPusher] Order ${order.amazonOrderId} already shipped on Amazon, marking as pushed`);
        await this.collection.updateOne(
          { 'sourceIds.amazonOrderId': order.amazonOrderId },
          {
            $set: {
              'amazonSeller.trackingPushed': true,
              'amazonSeller.trackingPushedAt': new Date(),
              'amazonSeller.trackingPushNote': 'Auto-marked - order already shipped on Amazon',
              'status.unified': 'shipped'
            }
          }
        );
        result.pushed = true;
        op.complete({ reason: 'already_shipped' });
        return result;
      }

      console.error(`[SellerTrackingPusher] Error confirming shipment for ${order.amazonOrderId}:`, error.message);
      op.fail(error);
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

    // Validate marketplaceId
    if (!marketplaceId) {
      return { success: false, error: 'Missing marketplaceId - cannot push tracking' };
    }

    // Get order items for the shipment
    let orderItemIds = order.items?.map(item => item.orderItemId).filter(id => id) || [];

    // If no orderItemIds, try to fetch from Amazon API
    if (orderItemIds.length === 0) {
      console.log(`[SellerTrackingPusher] No orderItemIds for ${order.amazonOrderId}, fetching from Amazon...`);
      try {
        const response = await this.client.getOrderItems(order.amazonOrderId);
        const fetchedItems = response?.OrderItems || [];
        if (fetchedItems.length > 0) {
          orderItemIds = fetchedItems.map(item => item.OrderItemId).filter(id => id);

          // Update MongoDB with fetched orderItemIds
          if (orderItemIds.length > 0) {
            const updateItems = order.items?.map((item, idx) => ({
              ...item,
              orderItemId: fetchedItems[idx]?.OrderItemId || item.orderItemId
            })) || fetchedItems.map(item => ({
              orderItemId: item.OrderItemId,
              sku: item.SellerSKU,
              quantity: item.QuantityOrdered
            }));

            await this.collection.updateOne(
              { 'sourceIds.amazonOrderId': order.amazonOrderId },
              { $set: { items: updateItems } }
            );
            console.log(`[SellerTrackingPusher] Updated ${orderItemIds.length} orderItemIds for ${order.amazonOrderId}`);

            // Update local order object
            order.items = updateItems;
          }
        }
      } catch (fetchError) {
        console.error(`[SellerTrackingPusher] Failed to fetch orderItemIds for ${order.amazonOrderId}:`, fetchError.message);
      }
    }

    if (orderItemIds.length === 0) {
      return { success: false, error: 'No order items found and could not fetch from Amazon' };
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
      // @see SellerOrderSchema.js for field definitions
      orderItems: orderItemIds.map(orderItemId => {
        const item = order.items.find(i => i.orderItemId === orderItemId);
        return {
          orderItemId,
          quantity: getItemQuantity(item)
        };
      })
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

    // Count from MongoDB (unified_orders schema)
    const pushed = await this.collection.countDocuments({
      'amazonSeller.trackingPushed': true
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
