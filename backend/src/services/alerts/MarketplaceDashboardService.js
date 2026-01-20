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

// Dashboard data cache (15 minutes)
let dashboardCache = null;
let dashboardCacheExpiry = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

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
   * Uses 2-minute cache to avoid hammering marketplace APIs
   */
  async getDashboardData() {
    // Return cached data if still valid
    if (dashboardCache && dashboardCacheExpiry && Date.now() < dashboardCacheExpiry) {
      console.log('[MarketplaceDashboard] Returning cached data');
      return dashboardCache;
    }

    await this.init();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [amazonData, bolData] = await Promise.all([
      this.getAmazonSellerDataLive(today, tomorrow),
      this.getBolDataLive(today, tomorrow)
    ]);

    const result = {
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

    // Cache the result
    dashboardCache = result;
    dashboardCacheExpiry = Date.now() + CACHE_TTL_MS;

    return result;
  }

  /**
   * Get Amazon Seller pending orders directly from SP-API
   */
  async getAmazonSellerDataLive(today, tomorrow) {
    const stats = { pending: 0, late: 0, dueToday: 0, dueTomorrow: 0, upcoming: 0, noDeadline: 0, orders: [] };
    const MAX_ORDERS = 500;

    try {
      // Amazon SP-API requires CreatedAfter or LastUpdatedAfter
      // Use 60 days back - should cover all pending orders
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

      // Call Amazon SP-API directly for Unshipped/PartiallyShipped MFN orders
      const response = await this.sellerClient.getAllOrders({
        orderStatuses: ['Unshipped', 'PartiallyShipped'],
        fulfillmentChannels: ['MFN'], // Only FBM (Merchant Fulfilled)
        createdAfter: sixtyDaysAgo.toISOString()
      });

      // Limit to most recent 500 orders (they come sorted by date desc)
      const pendingOrders = (response || []).slice(0, MAX_ORDERS);
      stats.pending = pendingOrders.length;

      console.log(`[MarketplaceDashboard] Amazon SP-API returned ${pendingOrders.length} pending MFN orders (max ${MAX_ORDERS})`);

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

        // Add to orders list if late, due today, or due tomorrow (for downloads)
        if (status === 'late' || status === 'dueToday' || status === 'dueTomorrow') {
          stats.orders.push({
            orderId: order.AmazonOrderId,
            status: order.OrderStatus,
            deadline: deadline,
            daysLate,
            marketplace: order.MarketplaceId
          });
        }
      }

      // Sort orders by deadline (earliest first)
      stats.orders.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

      console.log(`[MarketplaceDashboard] Amazon breakdown: late=${stats.late}, dueToday=${stats.dueToday}, dueTomorrow=${stats.dueTomorrow}, upcoming=${stats.upcoming}, noDeadline=${stats.noDeadline}`);

    } catch (error) {
      console.error('[MarketplaceDashboard] Amazon SP-API error:', error.message);
      stats.error = error.message;
    }

    return stats;
  }

  /**
   * Get Bol.com pending orders directly from Bol.com API
   * Fetches the most recent 500 open FBR orders and categorizes by deadline
   */
  async getBolDataLive(today, tomorrow) {
    const stats = { pending: 0, late: 0, dueToday: 0, dueTomorrow: 0, upcoming: 0, noDeadline: 0, orders: [] };
    const MAX_ORDERS = 500;

    try {
      // Fetch the most recent 500 OPEN FBR orders from Bol.com
      // Using status=OPEN ensures we only get orders that need fulfillment
      let openOrders = [];
      let page = 1;
      let hasMore = true;

      while (hasMore && openOrders.length < MAX_ORDERS) {
        // Bol.com orders endpoint with status=OPEN and fulfilment-method=FBR
        const data = await bolRequest(`/orders?page=${page}&status=OPEN&fulfilment-method=FBR`);
        const orders = data.orders || [];

        if (orders.length === 0) {
          hasMore = false;
          break;
        }

        openOrders = openOrders.concat(orders);
        page++;

        // Rate limit delay between pages
        await new Promise(r => setTimeout(r, 300));
      }

      // Trim to exactly MAX_ORDERS if we got more
      openOrders = openOrders.slice(0, MAX_ORDERS);
      stats.pending = openOrders.length;

      console.log(`[MarketplaceDashboard] Bol.com API returned ${openOrders.length} open FBR orders from ${page - 1} pages`);

      // Fetch details for ALL open orders to get latestDeliveryDate
      // This ensures we don't miss any orders
      for (const order of openOrders) {
        try {
          // Get order details
          const details = await bolRequest(`/orders/${order.orderId}`);
          await new Promise(r => setTimeout(r, 250)); // Rate limit delay

          // Get deadline from FBR items only
          // For mixed orders (FBB+FBR), we only care about FBR item deadlines
          let deadline = null;
          let earliestFbrDeadline = null;

          for (const item of (details.orderItems || [])) {
            // Check if this is an FBR item
            const itemFulfilment = item.fulfilmentMethod || item.fulfilment?.method || 'FBR';
            const isFbrItem = itemFulfilment === 'FBR';

            // Try different field names Bol.com might use
            const dateFields = [
              item.latestDeliveryDate,
              item.fulfilment?.latestDeliveryDate,
              item.fulfilment?.deliveryDateRange?.endDate,
              item.expectedDeliveryDate
            ];

            let itemDeadline = null;
            for (const dateField of dateFields) {
              if (dateField) {
                itemDeadline = new Date(dateField);
                break;
              }
            }

            // For FBR items, track the earliest deadline
            if (isFbrItem && itemDeadline) {
              if (!earliestFbrDeadline || itemDeadline < earliestFbrDeadline) {
                earliestFbrDeadline = itemDeadline;
              }
            }

            // Also track any deadline as fallback
            if (itemDeadline && !deadline) {
              deadline = itemDeadline;
            }
          }

          // Prefer FBR deadline, fallback to any deadline
          deadline = earliestFbrDeadline || deadline;

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

          // Add to orders list if late, due today, or due tomorrow (for downloads)
          if (status === 'late' || status === 'dueToday' || status === 'dueTomorrow') {
            stats.orders.push({
              orderId: order.orderId,
              status: 'OPEN',
              deadline: deadline,
              daysLate
            });
          }
        } catch (detailError) {
          console.error(`[MarketplaceDashboard] Error fetching Bol order ${order.orderId}:`, detailError.message);
        }
      }

      // Sort orders by deadline (earliest first)
      stats.orders.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

      console.log(`[MarketplaceDashboard] Bol.com breakdown: late=${stats.late}, dueToday=${stats.dueToday}, dueTomorrow=${stats.dueTomorrow}, upcoming=${stats.upcoming}, noDeadline=${stats.noDeadline}`);

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

/**
 * Warm the cache on startup and keep it fresh
 */
async function startCacheRefresh() {
  const service = getMarketplaceDashboardService();

  // Initial warm-up (with delay to let other services initialize)
  setTimeout(async () => {
    console.log('[MarketplaceDashboard] Warming cache on startup...');
    try {
      await service.getDashboardData();
      console.log('[MarketplaceDashboard] Cache warmed successfully');
    } catch (err) {
      console.error('[MarketplaceDashboard] Cache warm-up failed:', err.message);
    }
  }, 10000); // 10 second delay after startup

  // Refresh cache every 14 minutes (before 15min expiry)
  setInterval(async () => {
    console.log('[MarketplaceDashboard] Refreshing cache...');
    try {
      // Force refresh by clearing cache
      dashboardCache = null;
      dashboardCacheExpiry = null;
      await service.getDashboardData();
      console.log('[MarketplaceDashboard] Cache refreshed');
    } catch (err) {
      console.error('[MarketplaceDashboard] Cache refresh failed:', err.message);
    }
  }, 14 * 60 * 1000); // Every 14 minutes
}

module.exports = {
  MarketplaceDashboardService,
  getMarketplaceDashboardService,
  startCacheRefresh
};
