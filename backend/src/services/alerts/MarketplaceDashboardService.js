/**
 * Marketplace Dashboard Service
 *
 * Shows order status from the MARKETPLACE perspective - not Odoo.
 * An order is "pending" if the marketplace hasn't received shipment confirmation,
 * regardless of whether it was shipped in Odoo.
 *
 * @module MarketplaceDashboardService
 */

const { getDb } = require('../../db');

class MarketplaceDashboardService {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return;
    this.db = getDb();
  }

  /**
   * Get dashboard data from marketplace perspective
   */
  async getDashboardData() {
    await this.init();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [amazonData, bolData] = await Promise.all([
      this.getAmazonSellerData(today, tomorrow),
      this.getBolData(today, tomorrow)
    ]);

    return {
      timestamp: new Date().toISOString(),
      channels: {
        'Amazon Seller': amazonData,
        'Bol.com': bolData
      },
      totals: {
        pending: amazonData.pending + bolData.pending,
        late: amazonData.late + bolData.late,
        dueToday: amazonData.dueToday + bolData.dueToday,
        dueTomorrow: amazonData.dueTomorrow + bolData.dueTomorrow
      }
    };
  }

  /**
   * Get Amazon Seller orders that marketplace considers "pending shipment"
   */
  async getAmazonSellerData(today, tomorrow) {
    const stats = { pending: 0, late: 0, dueToday: 0, dueTomorrow: 0, upcoming: 0, noDeadline: 0, orders: [] };

    // Get orders that Amazon considers not shipped
    const pendingOrders = await this.db.collection('seller_orders').find({
      orderStatus: { $in: ['Unshipped', 'PartiallyShipped'] },
      fulfillmentChannel: 'MFN' // Only FBM orders (Merchant Fulfilled)
    }).toArray();

    stats.pending = pendingOrders.length;

    // Get deadlines from unified_orders
    const amazonOrderIds = pendingOrders.map(o => o.amazonOrderId);
    const unifiedOrders = await this.db.collection('unified_orders').find({
      'sourceIds.amazonOrderId': { $in: amazonOrderIds }
    }).toArray();

    const deadlineMap = {};
    for (const u of unifiedOrders) {
      if (u.sourceIds?.amazonOrderId && u.shippingDeadline) {
        deadlineMap[u.sourceIds.amazonOrderId] = new Date(u.shippingDeadline);
      }
    }

    // Categorize by deadline
    for (const order of pendingOrders) {
      const deadline = deadlineMap[order.amazonOrderId];

      if (!deadline) {
        stats.noDeadline++;
        continue;
      }

      const dlDate = new Date(deadline);
      dlDate.setHours(0, 0, 0, 0);

      let status = 'upcoming';
      let daysLate = 0;

      if (dlDate < today) {
        status = 'late';
        daysLate = Math.floor((today - dlDate) / (1000 * 60 * 60 * 24));
        stats.late++;
      } else if (dlDate.getTime() === today.getTime()) {
        status = 'dueToday';
        stats.dueToday++;
      } else if (dlDate.getTime() === tomorrow.getTime()) {
        status = 'dueTomorrow';
        stats.dueTomorrow++;
      } else {
        stats.upcoming++;
      }

      // Add to orders list if late or due today (for details)
      if (status === 'late' || status === 'dueToday') {
        stats.orders.push({
          orderId: order.amazonOrderId,
          status: order.orderStatus,
          deadline: deadline,
          daysLate,
          odooStatus: order.odoo?.saleOrderName ? 'In Odoo' : 'Not in Odoo',
          trackingPushed: order.odoo?.trackingPushed || false
        });
      }
    }

    // Sort orders by days late (most late first)
    stats.orders.sort((a, b) => b.daysLate - a.daysLate);

    return stats;
  }

  /**
   * Get Bol.com orders that marketplace considers "pending shipment"
   */
  async getBolData(today, tomorrow) {
    const stats = { pending: 0, late: 0, dueToday: 0, dueTomorrow: 0, upcoming: 0, noDeadline: 0, orders: [] };

    // Get all Bol orders
    const allOrders = await this.db.collection('bol_orders').find({}).toArray();

    // Filter orders with pending items (not fully shipped to Bol.com)
    for (const order of allOrders) {
      // Check if any items still need shipping confirmation
      const hasPendingItems = order.orderItems?.some(item => {
        const shipped = item.quantityShipped || 0;
        const ordered = item.quantity || 1;
        return shipped < ordered;
      });

      if (!hasPendingItems) continue;

      stats.pending++;

      // Get deadline from first item with latestDeliveryDate
      let deadline = null;
      for (const item of (order.orderItems || [])) {
        if (item.latestDeliveryDate) {
          deadline = new Date(item.latestDeliveryDate);
          break;
        }
      }

      if (!deadline) {
        stats.noDeadline++;
        continue;
      }

      const dlDate = new Date(deadline);
      dlDate.setHours(0, 0, 0, 0);

      let status = 'upcoming';
      let daysLate = 0;

      if (dlDate < today) {
        status = 'late';
        daysLate = Math.floor((today - dlDate) / (1000 * 60 * 60 * 24));
        stats.late++;
      } else if (dlDate.getTime() === today.getTime()) {
        status = 'dueToday';
        stats.dueToday++;
      } else if (dlDate.getTime() === tomorrow.getTime()) {
        status = 'dueTomorrow';
        stats.dueTomorrow++;
      } else {
        stats.upcoming++;
      }

      // Add to orders list if late or due today
      if (status === 'late' || status === 'dueToday') {
        stats.orders.push({
          orderId: order.orderId,
          status: order.status,
          deadline: deadline,
          daysLate,
          odooStatus: order.odoo?.saleOrderName ? 'In Odoo' : 'Not in Odoo',
          trackingPushed: !!order.shipmentConfirmedAt
        });
      }
    }

    // Sort orders by days late
    stats.orders.sort((a, b) => b.daysLate - a.daysLate);

    return stats;
  }
}

// Singleton
let instance = null;

function getMarketplaceDashboardService() {
  if (!instance) {
    instance = new MarketplaceDashboardService();
  }
  return instance;
}

module.exports = {
  MarketplaceDashboardService,
  getMarketplaceDashboardService
};
