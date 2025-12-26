/**
 * SellerCanceledOrderSync - Sync canceled orders from Amazon to Odoo
 *
 * When Amazon cancels an order:
 * 1. Detect canceled orders in MongoDB
 * 2. Find corresponding Odoo sale.order
 * 3. Cancel the Odoo order
 *
 * @module SellerCanceledOrderSync
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { COLLECTION_NAME } = require('./SellerOrderImporter');

/**
 * SellerCanceledOrderSync - Syncs canceled orders to Odoo
 */
class SellerCanceledOrderSync {
  constructor() {
    this.odoo = null;
    this.client = null;
    this.collection = null;
  }

  /**
   * Initialize the sync service
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
   * Check for canceled orders and update Odoo
   */
  async syncCanceledOrders() {
    await this.init();

    const result = {
      checked: 0,
      canceled: 0,
      skipped: 0,
      errors: []
    };

    try {
      // Find orders in MongoDB that have Odoo orders but might be canceled
      const ordersToCheck = await this.collection.find({
        'odoo.saleOrderId': { $ne: null },
        'odoo.canceled': { $ne: true },
        orderStatus: { $in: ['Canceled', 'Cancelled'] }
      }).limit(100).toArray();

      console.log(`[SellerCanceledOrderSync] Found ${ordersToCheck.length} potentially canceled orders`);
      result.checked = ordersToCheck.length;

      for (const order of ordersToCheck) {
        try {
          const syncResult = await this.cancelOdooOrder(order);

          if (syncResult.canceled) {
            result.canceled++;
          } else {
            result.skipped++;
          }
        } catch (error) {
          result.errors.push({
            amazonOrderId: order.amazonOrderId,
            error: error.message
          });
          console.error(`[SellerCanceledOrderSync] Error canceling ${order.amazonOrderId}:`, error.message);
        }
      }

      // Also poll Amazon for recently canceled orders we might have missed
      await this.checkRecentCancellations(result);

    } catch (error) {
      result.errors.push({ error: error.message });
      console.error('[SellerCanceledOrderSync] Sync error:', error);
    }

    console.log(`[SellerCanceledOrderSync] Complete: ${result.canceled} canceled, ${result.skipped} skipped, ${result.errors.length} errors`);
    return result;
  }

  /**
   * Check Amazon for recently canceled orders
   */
  async checkRecentCancellations(result) {
    try {
      // Look back 7 days for canceled orders
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const response = await this.client.getOrders({
        lastUpdatedAfter: sevenDaysAgo.toISOString(),
        orderStatuses: ['Canceled']
      });

      const canceledOrders = response.Orders || [];
      console.log(`[SellerCanceledOrderSync] Found ${canceledOrders.length} canceled orders from Amazon API`);

      for (const amazonOrder of canceledOrders) {
        // Update MongoDB
        const updateResult = await this.collection.updateOne(
          { amazonOrderId: amazonOrder.AmazonOrderId },
          {
            $set: {
              orderStatus: 'Canceled',
              lastUpdateDate: amazonOrder.LastUpdateDate,
              updatedAt: new Date()
            }
          }
        );

        // If order exists in MongoDB and has Odoo order, cancel it
        if (updateResult.matchedCount > 0) {
          const order = await this.collection.findOne({ amazonOrderId: amazonOrder.AmazonOrderId });

          if (order?.odoo?.saleOrderId && !order.odoo?.canceled) {
            try {
              const cancelResult = await this.cancelOdooOrder(order);
              if (cancelResult.canceled) {
                result.canceled++;
              }
            } catch (error) {
              result.errors.push({
                amazonOrderId: amazonOrder.AmazonOrderId,
                error: error.message
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('[SellerCanceledOrderSync] Error checking recent cancellations:', error.message);
    }
  }

  /**
   * Cancel an order in Odoo
   */
  async cancelOdooOrder(order) {
    const result = { canceled: false };
    const saleOrderId = order.odoo.saleOrderId;

    // Check current state of sale order
    const saleOrders = await this.odoo.searchRead('sale.order',
      [['id', '=', saleOrderId]],
      ['id', 'name', 'state']
    );

    if (saleOrders.length === 0) {
      console.log(`[SellerCanceledOrderSync] Sale order ${saleOrderId} not found`);
      return result;
    }

    const saleOrder = saleOrders[0];

    // Already canceled
    if (saleOrder.state === 'cancel') {
      await this.collection.updateOne(
        { amazonOrderId: order.amazonOrderId },
        { $set: { 'odoo.canceled': true, 'odoo.canceledAt': new Date() } }
      );
      return { canceled: false, alreadyCanceled: true };
    }

    // Can only cancel draft or sent orders, not done orders
    if (!['draft', 'sent', 'sale'].includes(saleOrder.state)) {
      console.log(`[SellerCanceledOrderSync] Cannot cancel order ${saleOrder.name} in state ${saleOrder.state}`);
      return result;
    }

    console.log(`[SellerCanceledOrderSync] Canceling Odoo order ${saleOrder.name} for ${order.amazonOrderId}`);

    try {
      // Cancel any pickings first
      const pickings = await this.odoo.searchRead('stock.picking',
        [
          ['sale_id', '=', saleOrderId],
          ['state', 'not in', ['done', 'cancel']]
        ],
        ['id', 'name', 'state']
      );

      for (const picking of pickings) {
        try {
          await this.odoo.execute('stock.picking', 'action_cancel', [[picking.id]]);
          console.log(`[SellerCanceledOrderSync] Canceled picking ${picking.name}`);
        } catch (pickingError) {
          console.warn(`[SellerCanceledOrderSync] Could not cancel picking ${picking.name}:`, pickingError.message);
        }
      }

      // Cancel the sale order
      await this.odoo.execute('sale.order', 'action_cancel', [[saleOrderId]]);

      // Update MongoDB
      await this.collection.updateOne(
        { amazonOrderId: order.amazonOrderId },
        {
          $set: {
            'odoo.canceled': true,
            'odoo.canceledAt': new Date()
          }
        }
      );

      result.canceled = true;
      console.log(`[SellerCanceledOrderSync] Successfully canceled ${saleOrder.name}`);

    } catch (error) {
      console.error(`[SellerCanceledOrderSync] Error canceling order ${saleOrder.name}:`, error.message);
      throw error;
    }

    return result;
  }

  /**
   * Get sync statistics
   */
  async getStats() {
    await this.init();

    const [
      totalWithOdoo,
      canceledInAmazon,
      canceledInOdoo
    ] = await Promise.all([
      this.collection.countDocuments({
        'odoo.saleOrderId': { $ne: null }
      }),
      this.collection.countDocuments({
        orderStatus: { $in: ['Canceled', 'Cancelled'] }
      }),
      this.collection.countDocuments({
        'odoo.canceled': true
      })
    ]);

    return {
      totalWithOdoo,
      canceledInAmazon,
      canceledInOdoo,
      pendingCancellation: canceledInAmazon - canceledInOdoo
    };
  }
}

// Singleton instance
let canceledOrderSyncInstance = null;

/**
 * Get the singleton SellerCanceledOrderSync instance
 */
async function getSellerCanceledOrderSync() {
  if (!canceledOrderSyncInstance) {
    canceledOrderSyncInstance = new SellerCanceledOrderSync();
    await canceledOrderSyncInstance.init();
  }
  return canceledOrderSyncInstance;
}

module.exports = {
  SellerCanceledOrderSync,
  getSellerCanceledOrderSync
};
