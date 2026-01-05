/**
 * Marketplace Dashboard Service
 *
 * Shows order status directly from MARKETPLACE APIs - not MongoDB snapshots.
 * Calls Amazon SP-API and Bol.com API to get real-time pending orders.
 *
 * @module MarketplaceDashboardService
 */

const { getSellerClient } = require('../amazon/seller/SellerClient');

// Bol.com token cache
let bolAccessToken = null;
let bolTokenExpiry = null;

/**
 * Get Bol.com access token
 */
async function getBolAccessToken() {
  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Bol.com credentials not configured');
  }

  // Check cached token
  if (bolAccessToken && bolTokenExpiry && Date.now() < bolTokenExpiry - 30000) {
    return bolAccessToken;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://login.bol.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    throw new Error(`Failed to get Bol.com access token: ${await response.text()}`);
  }

  const data = await response.json();
  bolAccessToken = data.access_token;
  bolTokenExpiry = Date.now() + (data.expires_in * 1000);

  return bolAccessToken;
}

/**
 * Make request to Bol.com API
 */
async function bolRequest(endpoint) {
  const token = await getBolAccessToken();

  const response = await fetch(`https://api.bol.com/retailer${endpoint}`, {
    headers: {
      'Accept': 'application/vnd.retailer.v10+json',
      'Authorization': `Bearer ${token}`
    }
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
    console.log(`[MarketplaceDashboard] Bol.com rate limited, waiting ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return bolRequest(endpoint);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Bol.com API error: ${response.status}`);
  }

  return response.json();
}

class MarketplaceDashboardService {
  constructor() {
    this.sellerClient = null;
  }

  async init() {
    if (this.sellerClient) return;
    this.sellerClient = getSellerClient();
    await this.sellerClient.init();
  }

  /**
   * Get dashboard data directly from marketplace APIs
   */
  async getDashboardData() {
    await this.init();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [amazonData, bolData] = await Promise.all([
      this.getAmazonSellerDataLive(today, tomorrow),
      this.getBolDataLive(today, tomorrow)
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
   * Get Amazon Seller pending orders directly from SP-API
   */
  async getAmazonSellerDataLive(today, tomorrow) {
    const stats = { pending: 0, late: 0, dueToday: 0, dueTomorrow: 0, upcoming: 0, noDeadline: 0, orders: [] };

    try {
      // Call Amazon SP-API directly for Unshipped/PartiallyShipped MFN orders
      const response = await this.sellerClient.getAllOrders({
        orderStatuses: ['Unshipped', 'PartiallyShipped'],
        fulfillmentChannels: ['MFN'] // Only FBM (Merchant Fulfilled)
      });

      const pendingOrders = response || [];
      stats.pending = pendingOrders.length;

      console.log(`[MarketplaceDashboard] Amazon SP-API returned ${pendingOrders.length} pending MFN orders`);

      // Categorize by deadline
      for (const order of pendingOrders) {
        // Amazon provides LatestShipDate
        const deadlineStr = order.LatestShipDate;

        if (!deadlineStr) {
          stats.noDeadline++;
          continue;
        }

        const deadline = new Date(deadlineStr);
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
            orderId: order.AmazonOrderId,
            status: order.OrderStatus,
            deadline: deadline,
            daysLate,
            marketplace: order.MarketplaceId
          });
        }
      }

      // Sort orders by days late (most late first)
      stats.orders.sort((a, b) => b.daysLate - a.daysLate);

    } catch (error) {
      console.error('[MarketplaceDashboard] Amazon SP-API error:', error.message);
      stats.error = error.message;
    }

    return stats;
  }

  /**
   * Get Bol.com pending orders directly from Bol.com API
   */
  async getBolDataLive(today, tomorrow) {
    const stats = { pending: 0, late: 0, dueToday: 0, dueTomorrow: 0, upcoming: 0, noDeadline: 0, orders: [] };

    try {
      // Call Bol.com API directly - fetch first page of orders
      // Orders endpoint returns orders sorted by date, most recent first
      // We only care about OPEN orders (not yet fully shipped)
      let allOrders = [];
      let page = 1;
      let hasMore = true;

      // Fetch up to 5 pages (enough for dashboard)
      while (hasMore && page <= 5) {
        const data = await bolRequest(`/orders?page=${page}&fulfilment-method=FBR`); // FBR = Fulfilled by Retailer
        const orders = data.orders || [];

        if (orders.length === 0) {
          hasMore = false;
          break;
        }

        allOrders = allOrders.concat(orders);
        page++;

        // Small delay between pages
        await new Promise(r => setTimeout(r, 200));
      }

      console.log(`[MarketplaceDashboard] Bol.com API returned ${allOrders.length} FBR orders`);

      // Filter orders with pending items (not fully shipped)
      for (const order of allOrders) {
        // Check if any items still need shipping
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
            status: 'OPEN',
            deadline: deadline,
            daysLate
          });
        }
      }

      // Sort orders by days late
      stats.orders.sort((a, b) => b.daysLate - a.daysLate);

    } catch (error) {
      console.error('[MarketplaceDashboard] Bol.com API error:', error.message);
      stats.error = error.message;
    }

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
