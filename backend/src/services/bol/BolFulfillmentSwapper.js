/**
 * BolFulfillmentSwapper - Automatically swap between FBB and FBR fulfillment
 *
 * Logic (from Emipro bol_extended_ept):
 * - For FBB offers: if FBB stock <= 0 AND local warehouse has stock → swap to FBR
 * - For FBR offers: if FBB stock > 0 → swap to FBB
 *
 * This ensures customers always get fast delivery by:
 * - Using FBB (Bol warehouse) when stock is available there
 * - Falling back to FBR (merchant warehouse) when FBB is out of stock
 *
 * Rate Limiting:
 * - Bol.com: 25 requests/second max
 * - We use 100ms delay between calls for safety
 */

const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// Central Warehouse ID in Odoo
const CENTRAL_WAREHOUSE_ID = 1;

// Rate limiting configuration
const REQUEST_DELAY_MS = 100;   // 100ms between API calls
const MAX_RETRIES = 3;

// Token cache (shared with BolStockSync)
let accessToken = null;
let tokenExpiry = null;

class BolFulfillmentSwapper {
  constructor() {
    this.odoo = null;
    this.cwLocationId = null;
    this.isRunning = false;
    this.lastRun = null;
    this.lastResult = null;
  }

  /**
   * Initialize the service
   */
  async init() {
    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    // Find Central Warehouse stock location
    const warehouses = await this.odoo.searchRead('stock.warehouse',
      [['id', '=', CENTRAL_WAREHOUSE_ID]],
      ['id', 'name', 'lot_stock_id']
    );

    if (warehouses.length > 0 && warehouses[0].lot_stock_id) {
      this.cwLocationId = warehouses[0].lot_stock_id[0];
      console.log(`[BolFulfillmentSwapper] Central Warehouse location ID: ${this.cwLocationId}`);
    } else {
      throw new Error('Could not find Central Warehouse stock location');
    }

    return this;
  }

  /**
   * Get Bol.com access token
   */
  async getAccessToken() {
    const clientId = process.env.BOL_CLIENT_ID;
    const clientSecret = process.env.BOL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Bol.com credentials not configured');
    }

    // Check cached token
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 30000) {
      return accessToken;
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
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000);

    return accessToken;
  }

  /**
   * Make a Bol.com API request with retry logic
   */
  async bolRequest(endpoint, method = 'GET', body = null, retries = MAX_RETRIES) {
    const token = await this.getAccessToken();

    const options = {
      method,
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      }
    };

    if (body) {
      options.headers['Content-Type'] = 'application/vnd.retailer.v10+json';
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`https://api.bol.com/retailer${endpoint}`, options);

    // Handle rate limiting
    if (response.status === 429 && retries > 0) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
      console.log(`[BolFulfillmentSwapper] Rate limited, waiting ${retryAfter}s...`);
      await this.sleep(retryAfter * 1000);
      return this.bolRequest(endpoint, method, body, retries - 1);
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Bol.com API error: ${response.status}`);
    }

    if (response.status === 202 || response.status === 204) {
      // 202 Accepted for async operations, 204 No Content
      return { success: true, status: response.status };
    }

    return response.json();
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get FBB inventory from Bol.com (paginated)
   * Returns map of EAN -> stock info
   */
  async getFbbInventory() {
    console.log('[BolFulfillmentSwapper] Fetching FBB inventory...');

    const inventory = {};
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await this.bolRequest(`/inventory?page=${page}`);
        const items = response.inventory || [];

        for (const item of items) {
          inventory[item.ean] = {
            bsku: item.bsku,
            title: item.title,
            stock: item.stock || 0,
            regularStock: item.regularStock || 0,
            gradedStock: item.gradedStock || 0,
            nckStock: item.nckStock || 0
          };
        }

        console.log(`[BolFulfillmentSwapper] Page ${page}: ${items.length} items`);

        // Check if there are more pages
        if (items.length < 50) {
          hasMore = false;
        } else {
          page++;
          await this.sleep(REQUEST_DELAY_MS);
        }
      } catch (error) {
        if (error.message.includes('404')) {
          // No inventory endpoint or no FBB inventory
          hasMore = false;
        } else {
          throw error;
        }
      }
    }

    console.log(`[BolFulfillmentSwapper] Total FBB inventory: ${Object.keys(inventory).length} items`);
    return inventory;
  }

  /**
   * Get offers by EAN from Bol.com
   * Since Bol.com doesn't have a "list all offers" endpoint,
   * we query offers by EAN for each item in FBB inventory
   */
  async getOffersByEans(eans) {
    console.log(`[BolFulfillmentSwapper] Looking up offers for ${eans.length} EANs...`);

    const offers = [];
    let found = 0;
    let notFound = 0;

    for (const ean of eans) {
      try {
        const response = await this.bolRequest(`/offers?ean=${ean}`);
        const items = response.offers || [];

        for (const item of items) {
          offers.push({
            offerId: item.offerId,
            ean: item.ean,
            reference: item.reference,
            fulfillmentMethod: item.fulfilment?.method || 'FBR'
          });
          found++;
        }

        if (items.length === 0) {
          notFound++;
        }

        // Rate limiting
        await this.sleep(REQUEST_DELAY_MS);

      } catch (error) {
        // Offer not found for this EAN is expected
        if (!error.message.includes('404')) {
          console.error(`[BolFulfillmentSwapper] Error fetching offer for EAN ${ean}:`, error.message);
        }
        notFound++;
      }

      // Log progress every 100 EANs
      if ((found + notFound) % 100 === 0) {
        console.log(`[BolFulfillmentSwapper] Progress: ${found} found, ${notFound} not found`);
      }
    }

    console.log(`[BolFulfillmentSwapper] Total offers found: ${offers.length} (${notFound} EANs without offers)`);
    return offers;
  }

  /**
   * Get local warehouse stock for multiple EANs
   */
  async getLocalStock(eans) {
    if (!eans || eans.length === 0) return {};

    // Find products by barcode (EAN)
    const products = await this.odoo.searchRead('product.product',
      [['barcode', 'in', eans]],
      ['id', 'barcode']
    );

    if (products.length === 0) return {};

    const productIds = products.map(p => p.id);
    const eanToProductId = {};
    products.forEach(p => {
      if (p.barcode) eanToProductId[p.barcode] = p.id;
    });

    // Get stock.quants for these products
    const quants = await this.odoo.searchRead('stock.quant',
      [
        ['product_id', 'in', productIds],
        ['location_id', '=', this.cwLocationId]
      ],
      ['product_id', 'quantity', 'reserved_quantity']
    );

    // Calculate free stock per product
    const productStock = {};
    for (const q of quants) {
      const productId = q.product_id[0];
      if (!productStock[productId]) {
        productStock[productId] = { quantity: 0, reserved: 0 };
      }
      productStock[productId].quantity += q.quantity || 0;
      productStock[productId].reserved += q.reserved_quantity || 0;
    }

    // Map to EAN -> free_qty
    const stockByEan = {};
    for (const ean of eans) {
      const productId = eanToProductId[ean];
      if (productId && productStock[productId]) {
        const freeQty = productStock[productId].quantity - productStock[productId].reserved;
        stockByEan[ean] = Math.max(0, Math.floor(freeQty));
      } else if (productId) {
        stockByEan[ean] = 0;
      }
    }

    return stockByEan;
  }

  /**
   * Swap offer fulfillment method
   */
  async swapFulfillment(offerId, newMethod) {
    const payload = {
      fulfilment: {
        method: newMethod
      }
    };

    // FBR requires delivery code
    if (newMethod === 'FBR') {
      payload.fulfilment.deliveryCode = '3-5d';
    }

    try {
      const result = await this.bolRequest(`/offers/${offerId}`, 'PUT', payload);
      return {
        success: true,
        processStatusId: result.processStatusId,
        status: result.status
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Run the fulfillment swap check
   */
  async run() {
    if (this.isRunning) {
      console.log('[BolFulfillmentSwapper] Already running, skipping');
      return { success: false, message: 'Already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    const results = {
      checked: 0,
      swappedToFbr: 0,
      swappedToFbb: 0,
      failed: 0,
      swaps: []
    };

    try {
      await this.init();

      // Step 1: Get FBB inventory from Bol.com
      const fbbInventory = await this.getFbbInventory();
      const fbbEans = Object.keys(fbbInventory);

      if (fbbEans.length === 0) {
        console.log('[BolFulfillmentSwapper] No FBB inventory found');
        return { success: true, ...results, message: 'No FBB inventory' };
      }

      // Step 2: Get local warehouse stock for FBB EANs
      const localStock = await this.getLocalStock(fbbEans);
      console.log(`[BolFulfillmentSwapper] Got local stock for ${Object.keys(localStock).length} products`);

      // Step 3: Get offers for FBB EANs (this is the slow part due to API rate limits)
      const offers = await this.getOffersByEans(fbbEans);

      if (offers.length === 0) {
        console.log('[BolFulfillmentSwapper] No offers found for FBB EANs');
        return { success: true, ...results, message: 'No offers found' };
      }

      console.log(`[BolFulfillmentSwapper] Checking ${offers.length} offers...`);

      // Step 4: Check each offer and swap if needed
      for (const offer of offers) {
        results.checked++;

        const ean = offer.ean;
        if (!ean) continue;

        const fbbStock = fbbInventory[ean]?.regularStock || 0;
        const localQty = localStock[ean] || 0;
        const currentMethod = offer.fulfillmentMethod;

        let needsSwap = false;
        let newMethod = null;
        let reason = '';

        // Logic from Emipro:
        // - If currently FBB and FBB stock <= 0 and local stock > 0 → swap to FBR
        // - If currently FBR and FBB stock > 0 → swap to FBB
        if (currentMethod === 'FBB' && fbbStock <= 0 && localQty > 0) {
          needsSwap = true;
          newMethod = 'FBR';
          reason = `FBB out of stock (${fbbStock}), local has ${localQty}`;
        } else if (currentMethod === 'FBR' && fbbStock > 0) {
          needsSwap = true;
          newMethod = 'FBB';
          reason = `FBB has stock (${fbbStock})`;
        }

        if (needsSwap) {
          console.log(`[BolFulfillmentSwapper] Swapping ${ean}: ${currentMethod} → ${newMethod} (${reason})`);

          const swapResult = await this.swapFulfillment(offer.offerId, newMethod);

          if (swapResult.success) {
            if (newMethod === 'FBR') {
              results.swappedToFbr++;
            } else {
              results.swappedToFbb++;
            }
            results.swaps.push({
              ean,
              offerId: offer.offerId,
              from: currentMethod,
              to: newMethod,
              reason,
              processStatusId: swapResult.processStatusId
            });
          } else {
            results.failed++;
            console.error(`[BolFulfillmentSwapper] Failed to swap ${ean}:`, swapResult.error);
          }

          await this.sleep(REQUEST_DELAY_MS);
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastRun = new Date();
      this.lastResult = { ...results, duration };

      console.log(`[BolFulfillmentSwapper] Complete in ${duration}s:`, {
        checked: results.checked,
        swappedToFbr: results.swappedToFbr,
        swappedToFbb: results.swappedToFbb,
        failed: results.failed
      });

      return {
        success: true,
        ...results,
        duration: `${duration}s`
      };

    } catch (error) {
      console.error('[BolFulfillmentSwapper] Error:', error);
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      lastResult: this.lastResult
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the BolFulfillmentSwapper instance
 */
function getBolFulfillmentSwapper() {
  if (!instance) {
    instance = new BolFulfillmentSwapper();
  }
  return instance;
}

/**
 * Run fulfillment swap check (for scheduler)
 */
async function runFulfillmentSwap() {
  const swapper = getBolFulfillmentSwapper();
  return swapper.run();
}

module.exports = {
  BolFulfillmentSwapper,
  getBolFulfillmentSwapper,
  runFulfillmentSwap
};
