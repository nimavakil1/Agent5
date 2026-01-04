/**
 * SellerShipmentSync - Sync FBA Shipments from Amazon to Odoo
 *
 * When Amazon FBA ships an order:
 * 1. Detect shipped orders in MongoDB
 * 2. Find corresponding Odoo sale.order and stock.picking
 * 3. Mark picking as done
 * 4. Add tracking information
 *
 * @module SellerShipmentSync
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerOrderImporter, COLLECTION_NAME } = require('./SellerOrderImporter');

/**
 * SellerShipmentSync - Syncs FBA shipments to Odoo
 */
class SellerShipmentSync {
  constructor() {
    this.odoo = null;
    this.importer = null;
    this.collection = null;
  }

  /**
   * Initialize the sync service
   */
  async init() {
    if (this.odoo && this.collection) return;

    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    this.importer = await getSellerOrderImporter();

    const db = getDb();
    this.collection = db.collection(COLLECTION_NAME);
  }

  /**
   * Sync FBA shipments from Amazon to Odoo
   * Finds orders that are shipped in Amazon but not yet synced to Odoo
   */
  async syncFbaShipments() {
    await this.init();

    const result = {
      checked: 0,
      synced: 0,
      skipped: 0,
      errors: []
    };

    try {
      // Find FBA orders that are shipped but Odoo picking not yet done
      const shippedOrders = await this.collection.find({
        fulfillmentChannel: 'AFN', // FBA orders only
        orderStatus: 'Shipped',
        'odoo.saleOrderId': { $ne: null }, // Has Odoo order
        'odoo.pickingDone': { $ne: true }  // Picking not marked as done
      }).limit(100).toArray();

      console.log(`[SellerShipmentSync] Found ${shippedOrders.length} FBA orders to sync`);
      result.checked = shippedOrders.length;

      for (const order of shippedOrders) {
        try {
          const syncResult = await this.syncOrderShipment(order);

          if (syncResult.synced) {
            result.synced++;
          } else {
            result.skipped++;
          }
        } catch (error) {
          result.errors.push({
            amazonOrderId: order.amazonOrderId,
            error: error.message
          });
          console.error(`[SellerShipmentSync] Error syncing ${order.amazonOrderId}:`, error.message);
        }
      }

    } catch (error) {
      result.errors.push({ error: error.message });
      console.error('[SellerShipmentSync] Sync error:', error);
    }

    console.log(`[SellerShipmentSync] Sync complete: ${result.synced} synced, ${result.skipped} skipped, ${result.errors.length} errors`);
    return result;
  }

  /**
   * Sync a single order's shipment to Odoo
   */
  async syncOrderShipment(order) {
    const result = { synced: false, pickingId: null };

    // Get the Odoo sale order
    const saleOrderId = order.odoo.saleOrderId;

    // Find the delivery picking for this order
    const pickings = await this.odoo.searchRead('stock.picking',
      [
        ['sale_id', '=', saleOrderId],
        ['picking_type_code', '=', 'outgoing'],
        ['state', 'not in', ['done', 'cancel']]
      ],
      ['id', 'name', 'state', 'move_ids']
    );

    if (pickings.length === 0) {
      // Check if already done
      const donePicking = await this.odoo.searchRead('stock.picking',
        [
          ['sale_id', '=', saleOrderId],
          ['picking_type_code', '=', 'outgoing'],
          ['state', '=', 'done']
        ],
        ['id', 'name']
      );

      if (donePicking.length > 0) {
        // Already done, just mark in MongoDB
        await this.collection.updateOne(
          { amazonOrderId: order.amazonOrderId },
          { $set: { 'odoo.pickingDone': true, 'odoo.pickingId': donePicking[0].id } }
        );
        return { synced: false, alreadyDone: true };
      }

      console.log(`[SellerShipmentSync] No pending picking found for order ${order.amazonOrderId}`);
      return result;
    }

    const picking = pickings[0];
    result.pickingId = picking.id;

    console.log(`[SellerShipmentSync] Processing picking ${picking.name} for order ${order.amazonOrderId}`);

    // Get tracking info from order items (if available)
    let _trackingNumber = null;
    if (order.items && order.items.length > 0) {
      // Amazon doesn't always provide tracking in the order, but we mark it as shipped
      // The tracking comes from Amazon's fulfillment
    }

    try {
      // For FBA orders, we need to validate the picking
      // First, check if picking is in 'assigned' state
      if (picking.state === 'assigned') {
        // Validate the picking (mark as done)
        await this.validatePicking(picking.id);
        result.synced = true;
      } else if (picking.state === 'waiting' || picking.state === 'confirmed') {
        // Need to check availability first
        await this.odoo.execute('stock.picking', 'action_assign', [[picking.id]]);

        // Check state again
        const updatedPicking = await this.odoo.searchRead('stock.picking',
          [['id', '=', picking.id]],
          ['state']
        );

        if (updatedPicking[0]?.state === 'assigned') {
          await this.validatePicking(picking.id);
          result.synced = true;
        } else {
          console.log(`[SellerShipmentSync] Picking ${picking.name} could not be assigned, state: ${updatedPicking[0]?.state}`);
        }
      }

      // Update MongoDB
      await this.collection.updateOne(
        { amazonOrderId: order.amazonOrderId },
        {
          $set: {
            'odoo.pickingDone': result.synced,
            'odoo.pickingId': picking.id,
            'odoo.pickingSyncedAt': new Date()
          }
        }
      );

    } catch (error) {
      console.error(`[SellerShipmentSync] Error validating picking ${picking.name}:`, error.message);
      throw error;
    }

    return result;
  }

  /**
   * Validate a picking (mark as done)
   * Uses immediate transfer for simplicity
   */
  async validatePicking(pickingId) {
    try {
      // Try button_validate first (standard flow)
      await this.odoo.execute('stock.picking', 'button_validate', [[pickingId]]);
      console.log(`[SellerShipmentSync] Validated picking ${pickingId}`);
    } catch (error) {
      // If it fails (e.g., needs wizard), try force_assign + action_done
      if (error.message.includes('wizard') || error.message.includes('UserError')) {
        console.log(`[SellerShipmentSync] Standard validation failed, trying immediate transfer`);

        // Set all move quantities to done
        const moves = await this.odoo.searchRead('stock.move',
          [['picking_id', '=', pickingId], ['state', 'not in', ['done', 'cancel']]],
          ['id', 'product_uom_qty']
        );

        for (const move of moves) {
          await this.odoo.write('stock.move', [move.id], {
            quantity_done: move.product_uom_qty
          });
        }

        // Try validate again
        await this.odoo.execute('stock.picking', 'button_validate', [[pickingId]]);
      } else {
        throw error;
      }
    }
  }

  /**
   * Get sync statistics
   */
  async getStats() {
    await this.init();

    const [
      totalFbaShipped,
      pendingSync,
      synced
    ] = await Promise.all([
      this.collection.countDocuments({
        fulfillmentChannel: 'AFN',
        orderStatus: 'Shipped',
        'odoo.saleOrderId': { $ne: null }
      }),
      this.collection.countDocuments({
        fulfillmentChannel: 'AFN',
        orderStatus: 'Shipped',
        'odoo.saleOrderId': { $ne: null },
        'odoo.pickingDone': { $ne: true }
      }),
      this.collection.countDocuments({
        fulfillmentChannel: 'AFN',
        'odoo.pickingDone': true
      })
    ]);

    return {
      totalFbaShipped,
      pendingSync,
      synced
    };
  }
}

// Singleton instance
let shipmentSyncInstance = null;

/**
 * Get the singleton SellerShipmentSync instance
 */
async function getSellerShipmentSync() {
  if (!shipmentSyncInstance) {
    shipmentSyncInstance = new SellerShipmentSync();
    await shipmentSyncInstance.init();
  }
  return shipmentSyncInstance;
}

module.exports = {
  SellerShipmentSync,
  getSellerShipmentSync
};
