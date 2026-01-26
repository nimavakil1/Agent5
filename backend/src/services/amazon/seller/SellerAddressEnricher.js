/**
 * SellerAddressEnricher - Enriches order addresses with SP-API data
 *
 * The Amazon TSV order report is missing the shipping company name (CompanyName).
 * This service fetches the full shipping address from SP-API and merges it
 * with the TSV data.
 *
 * Key insight:
 * - TSV has `buyer-company-name` = billing intermediary (e.g., "Amazon Business EU SARL")
 * - SP-API `getOrderAddress()` has `ShippingAddress.CompanyName` = actual destination company
 *
 * @module SellerAddressEnricher
 */

const { getSellerClient } = require('./SellerClient');

// Rate limit: Amazon allows ~1 request/second for getOrderAddress
const RATE_LIMIT_MS = 1100; // 1.1 seconds between requests

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * SellerAddressEnricher class
 */
class SellerAddressEnricher {
  constructor() {
    this.client = null;
    this.lastRequestTime = 0;
  }

  /**
   * Initialize the enricher
   */
  async init() {
    if (this.client) return;
    this.client = getSellerClient();
    await this.client.init();
  }

  /**
   * Rate-limited request wrapper
   */
  async rateLimitedRequest(fn) {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < RATE_LIMIT_MS) {
      await sleep(RATE_LIMIT_MS - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();
    return fn();
  }

  /**
   * Fetch shipping address from SP-API for a single order
   *
   * @param {string} amazonOrderId - Amazon order ID (e.g., "028-3167661-3509940")
   * @returns {Object|null} Enriched address data or null if not available
   */
  async fetchOrderAddress(amazonOrderId) {
    await this.init();

    try {
      const response = await this.rateLimitedRequest(() =>
        this.client.getOrderAddress(amazonOrderId)
      );

      if (!response) {
        console.log(`[SellerAddressEnricher] No response for ${amazonOrderId}`);
        return null;
      }

      // Extract shipping address - may be nested or direct
      const shippingAddress = response.ShippingAddress || response;

      // Build enriched address object
      const enrichedAddress = {
        companyName: shippingAddress.CompanyName || null,
        name: shippingAddress.Name || null,
        addressLine1: shippingAddress.AddressLine1 || null,
        addressLine2: shippingAddress.AddressLine2 || null,
        addressLine3: shippingAddress.AddressLine3 || null,
        city: shippingAddress.City || null,
        stateOrRegion: shippingAddress.StateOrRegion || null,
        postalCode: shippingAddress.PostalCode || null,
        countryCode: shippingAddress.CountryCode || null,
        phone: shippingAddress.Phone || null,
        addressType: shippingAddress.AddressType || null,
      };

      // Also capture buyer company name if available (separate from shipping company)
      if (response.BuyerCompanyName) {
        enrichedAddress.buyerCompanyName = response.BuyerCompanyName;
      }

      // Capture delivery preferences if available
      if (response.DeliveryPreferences) {
        enrichedAddress.deliveryPreferences = response.DeliveryPreferences;
      }

      console.log(`[SellerAddressEnricher] Fetched address for ${amazonOrderId}: CompanyName="${enrichedAddress.companyName}"`);

      return enrichedAddress;

    } catch (error) {
      // Handle specific error cases
      if (error.message?.includes('Order not found') || error.code === 'NotFound') {
        console.log(`[SellerAddressEnricher] Order ${amazonOrderId} not found in SP-API (may be old/cancelled)`);
        return null;
      }

      if (error.message?.includes('rate') || error.code === 'QuotaExceeded') {
        console.warn(`[SellerAddressEnricher] Rate limit hit for ${amazonOrderId}, waiting...`);
        await sleep(5000); // Wait 5 seconds on rate limit
        return this.fetchOrderAddress(amazonOrderId); // Retry
      }

      console.error(`[SellerAddressEnricher] Error fetching address for ${amazonOrderId}:`, error.message);
      return null;
    }
  }

  /**
   * Enrich a single order with SP-API address data
   *
   * @param {Object} order - Order object (from unified_orders or TSV parsing)
   * @returns {Object} Order with enriched address data
   */
  async enrichOrder(order) {
    const amazonOrderId = order.sourceIds?.amazonOrderId ||
                          order.amazonOrderId ||
                          order.orderId;

    if (!amazonOrderId) {
      console.warn('[SellerAddressEnricher] No Amazon order ID found in order');
      return order;
    }

    const spApiAddress = await this.fetchOrderAddress(amazonOrderId);

    if (!spApiAddress) {
      // Mark that we tried but couldn't get data
      return {
        ...order,
        spApiEnrichment: {
          attempted: true,
          success: false,
          attemptedAt: new Date()
        }
      };
    }

    // Merge SP-API data into order
    const enrichedOrder = { ...order };

    // Add SP-API enrichment data
    enrichedOrder.spApiEnrichment = {
      attempted: true,
      success: true,
      enrichedAt: new Date(),
      companyName: spApiAddress.companyName,
      buyerCompanyName: spApiAddress.buyerCompanyName,
      hasDeliveryPreferences: !!spApiAddress.deliveryPreferences
    };

    // Update shipping address with SP-API data
    if (!enrichedOrder.shippingAddress) {
      enrichedOrder.shippingAddress = {};
    }

    // Add company name from SP-API (this is the key missing data!)
    if (spApiAddress.companyName) {
      enrichedOrder.shippingAddress.companyName = spApiAddress.companyName;
    }

    // Fill in any missing address fields from SP-API
    // But prefer TSV data if it exists (TSV is more recent/accurate for basic fields)
    if (!enrichedOrder.shippingAddress.name && spApiAddress.name) {
      enrichedOrder.shippingAddress.name = spApiAddress.name;
    }
    if (!enrichedOrder.shippingAddress.street && spApiAddress.addressLine1) {
      enrichedOrder.shippingAddress.street = spApiAddress.addressLine1;
    }
    if (!enrichedOrder.shippingAddress.street2 && spApiAddress.addressLine2) {
      enrichedOrder.shippingAddress.street2 = spApiAddress.addressLine2;
    }
    if (!enrichedOrder.shippingAddress.city && spApiAddress.city) {
      enrichedOrder.shippingAddress.city = spApiAddress.city;
    }
    if (!enrichedOrder.shippingAddress.postalCode && spApiAddress.postalCode) {
      enrichedOrder.shippingAddress.postalCode = spApiAddress.postalCode;
    }
    if (!enrichedOrder.shippingAddress.countryCode && spApiAddress.countryCode) {
      enrichedOrder.shippingAddress.countryCode = spApiAddress.countryCode;
    }
    if (!enrichedOrder.shippingAddress.phone && spApiAddress.phone) {
      enrichedOrder.shippingAddress.phone = spApiAddress.phone;
    }

    // Store delivery preferences if available
    if (spApiAddress.deliveryPreferences) {
      enrichedOrder.shippingAddress.deliveryPreferences = spApiAddress.deliveryPreferences;
    }

    return enrichedOrder;
  }

  /**
   * Enrich multiple orders with SP-API address data
   *
   * @param {Array} orders - Array of orders to enrich
   * @param {Object} options - Options
   * @param {Function} options.onProgress - Progress callback (current, total, order)
   * @param {boolean} options.skipExisting - Skip orders already enriched (default: true)
   * @returns {Object} Results summary
   */
  async enrichOrders(orders, options = {}) {
    await this.init();

    const { onProgress, skipExisting = true } = options;

    const results = {
      total: orders.length,
      enriched: 0,
      skipped: 0,
      failed: 0,
      orders: []
    };

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const amazonOrderId = order.sourceIds?.amazonOrderId ||
                            order.amazonOrderId ||
                            order.orderId;

      // Skip if already enriched
      if (skipExisting && order.spApiEnrichment?.success) {
        console.log(`[SellerAddressEnricher] Skipping ${amazonOrderId} - already enriched`);
        results.skipped++;
        results.orders.push(order);
        continue;
      }

      // Progress callback
      if (onProgress) {
        onProgress(i + 1, orders.length, order);
      }

      try {
        const enrichedOrder = await this.enrichOrder(order);
        results.orders.push(enrichedOrder);

        if (enrichedOrder.spApiEnrichment?.success) {
          results.enriched++;
        } else {
          results.failed++;
        }

      } catch (error) {
        console.error(`[SellerAddressEnricher] Error enriching order ${amazonOrderId}:`, error.message);
        results.failed++;
        results.orders.push({
          ...order,
          spApiEnrichment: {
            attempted: true,
            success: false,
            error: error.message,
            attemptedAt: new Date()
          }
        });
      }
    }

    console.log(`[SellerAddressEnricher] Enrichment complete: ${results.enriched} enriched, ${results.skipped} skipped, ${results.failed} failed`);

    return results;
  }
}

// Singleton instance
let enricherInstance = null;

/**
 * Get the singleton SellerAddressEnricher instance
 */
function getSellerAddressEnricher() {
  if (!enricherInstance) {
    enricherInstance = new SellerAddressEnricher();
  }
  return enricherInstance;
}

module.exports = {
  SellerAddressEnricher,
  getSellerAddressEnricher
};
