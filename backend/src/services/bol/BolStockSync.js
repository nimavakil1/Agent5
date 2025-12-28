/**
 * BolStockSync - Sync stock levels from Odoo to Bol.com
 *
 * Pushes stock levels from Central Warehouse (free_qty) to Bol.com offers.
 *
 * Flow:
 * 1. Get all offers from Bol.com with their EANs
 * 2. For each EAN, find product in Odoo and get stock.quant free_qty
 * 3. Update Bol.com offer stock via PUT /retailer/offers/{offerId}/stock
 *
 * Rate Limiting:
 * - Bol.com: 25 requests/second max
 * - We use 50ms delay between calls (20 req/s)
 */

const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// Central Warehouse ID in Odoo
const CENTRAL_WAREHOUSE_ID = 1;

// Rate limiting configuration
const REQUEST_DELAY_MS = 50;   // 50ms = 20 requests/second
const BATCH_SIZE = 100;        // Process in batches
const MAX_RETRIES = 3;

// Token cache (shared)
let accessToken = null;
let tokenExpiry = null;

class BolStockSync {
  constructor() {
    this.odoo = null;
    this.cwLocationId = null;    // Central Warehouse stock location ID
    this.isRunning = false;
    this.lastSync = null;
    this.lastResult = null;
  }

  /**
   * Initialize the sync service
   */
  async init() {
    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    // Find Central Warehouse stock location
    await this.findWarehouseLocation();

    return this;
  }

  /**
   * Find the stock location ID for Central Warehouse
   */
  async findWarehouseLocation() {
    const warehouses = await this.odoo.searchRead('stock.warehouse',
      [['id', '=', CENTRAL_WAREHOUSE_ID]],
      ['id', 'name', 'lot_stock_id']
    );

    if (warehouses.length > 0 && warehouses[0].lot_stock_id) {
      this.cwLocationId = warehouses[0].lot_stock_id[0];
      console.log(`[BolStockSync] Central Warehouse location ID: ${this.cwLocationId}`);
    } else {
      // Fallback: try to find by name
      const locations = await this.odoo.searchRead('stock.location',
        [['name', 'ilike', 'Stock'], ['usage', '=', 'internal']],
        ['id', 'name'],
        { limit: 1 }
      );
      if (locations.length > 0) {
        this.cwLocationId = locations[0].id;
        console.log(`[BolStockSync] Using fallback location: ${locations[0].name} (${this.cwLocationId})`);
      }
    }

    if (!this.cwLocationId) {
      throw new Error('Could not find Central Warehouse stock location');
    }
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
      console.log(`[BolStockSync] Rate limited, waiting ${retryAfter}s...`);
      await this.sleep(retryAfter * 1000);
      return this.bolRequest(endpoint, method, body, retries - 1);
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Bol.com API error: ${response.status}`);
    }

    if (response.status === 204) {
      return { success: true };
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
   * Get all offers from Bol.com
   * Uses the offer export feature since there's no direct list endpoint
   */
  async getOffers() {
    console.log('[BolStockSync] Fetching offers from Bol.com...');

    // Bol.com doesn't have a simple "list all offers" endpoint
    // We need to use the offers export or query by EAN
    // For now, we'll use offers from our orders to build a list

    // Alternative: Use the catalog endpoint to search by EAN
    // For each product in Odoo, we search for the offer

    return [];
  }

  /**
   * Get stock level from Odoo for a product by EAN
   */
  async getStockByEan(ean) {
    if (!ean) return 0;

    // Find product by barcode (EAN)
    const products = await this.odoo.searchRead('product.product',
      [['barcode', '=', ean]],
      ['id', 'name', 'default_code'],
      { limit: 1 }
    );

    if (products.length === 0) {
      return null; // Product not found
    }

    const productId = products[0].id;

    // Get stock.quant for this product in Central Warehouse location
    const quants = await this.odoo.searchRead('stock.quant',
      [
        ['product_id', '=', productId],
        ['location_id', '=', this.cwLocationId]
      ],
      ['quantity', 'reserved_quantity']
    );

    if (quants.length === 0) {
      return 0;
    }

    // free_qty = quantity - reserved_quantity
    const totalQty = quants.reduce((sum, q) => sum + (q.quantity || 0), 0);
    const reservedQty = quants.reduce((sum, q) => sum + (q.reserved_quantity || 0), 0);
    const freeQty = totalQty - reservedQty;

    return Math.max(0, Math.floor(freeQty));
  }

  /**
   * Get stock levels for multiple products by EAN
   * More efficient batch query
   */
  async getStockByEans(eans) {
    if (!eans || eans.length === 0) return {};

    // Find all products by barcode (EAN)
    const products = await this.odoo.searchRead('product.product',
      [['barcode', 'in', eans]],
      ['id', 'name', 'default_code', 'barcode']
    );

    if (products.length === 0) {
      return {};
    }

    const productIds = products.map(p => p.id);
    const eanToProductId = {};
    products.forEach(p => {
      if (p.barcode) {
        eanToProductId[p.barcode] = p.id;
      }
    });

    // Get all stock.quants for these products in Central Warehouse
    const quants = await this.odoo.searchRead('stock.quant',
      [
        ['product_id', 'in', productIds],
        ['location_id', '=', this.cwLocationId]
      ],
      ['product_id', 'quantity', 'reserved_quantity']
    );

    // Build product stock map
    const productStock = {};
    for (const q of quants) {
      const productId = q.product_id[0];
      if (!productStock[productId]) {
        productStock[productId] = { quantity: 0, reserved: 0 };
      }
      productStock[productId].quantity += q.quantity || 0;
      productStock[productId].reserved += q.reserved_quantity || 0;
    }

    // Map back to EANs
    const stockByEan = {};
    for (const ean of eans) {
      const productId = eanToProductId[ean];
      if (productId && productStock[productId]) {
        const freeQty = productStock[productId].quantity - productStock[productId].reserved;
        stockByEan[ean] = Math.max(0, Math.floor(freeQty));
      } else if (productId) {
        stockByEan[ean] = 0; // Product exists but no stock
      }
      // If productId not found, EAN is not in result (product doesn't exist in Odoo)
    }

    return stockByEan;
  }

  /**
   * Update stock for a single offer on Bol.com
   */
  async updateOfferStock(offerId, amount) {
    try {
      await this.bolRequest(`/offers/${offerId}/stock`, 'PUT', {
        amount: Math.max(0, Math.floor(amount)),
        managedByRetailer: true
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Sync stock for offers based on order history
   * Gets EANs from Bol orders, looks up stock in Odoo, updates Bol.com
   */
  async syncFromOrders() {
    if (this.isRunning) {
      console.log('[BolStockSync] Sync already running, skipping');
      return { success: false, message: 'Sync already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      await this.init();

      // Get unique EANs from recent orders
      const BolOrder = require('../../models/BolOrder');
      const recentOrders = await BolOrder.find({
        orderPlacedDateTime: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }
      })
        .select('orderItems.ean orderItems.sku')
        .lean();

      const uniqueEans = new Set();
      for (const order of recentOrders) {
        for (const item of (order.orderItems || [])) {
          if (item.ean) {
            uniqueEans.add(item.ean);
          }
        }
      }

      const eans = Array.from(uniqueEans);
      console.log(`[BolStockSync] Found ${eans.length} unique EANs from orders`);

      if (eans.length === 0) {
        this.isRunning = false;
        return { success: true, updated: 0, message: 'No EANs found in orders' };
      }

      // Get stock levels from Odoo
      const stockByEan = await this.getStockByEans(eans);
      console.log(`[BolStockSync] Got stock for ${Object.keys(stockByEan).length} products`);

      // For each EAN, find the offer ID from Bol.com and update stock
      let updated = 0;
      let failed = 0;
      const errors = [];

      for (const ean of Object.keys(stockByEan)) {
        try {
          // Get offer by EAN (search in catalog)
          // Note: This is not the most efficient method - ideally we'd cache offer IDs
          const offerData = await this.bolRequest(`/offers?ean=${ean}`);
          const offers = offerData.offers || [];

          if (offers.length === 0) {
            continue; // No offer for this EAN
          }

          const offerId = offers[0].offerId;
          const stock = stockByEan[ean];

          // Update stock on Bol.com
          const result = await this.updateOfferStock(offerId, stock);

          if (result.success) {
            updated++;
          } else {
            failed++;
            errors.push({ ean, offerId, error: result.error });
          }

          // Rate limiting
          await this.sleep(REQUEST_DELAY_MS);

        } catch (error) {
          // Offer lookup might fail if EAN doesn't exist on Bol.com
          // This is expected for products not listed
          continue;
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastSync = new Date();
      this.lastResult = { updated, failed, duration, errors: errors.slice(0, 10) };

      console.log(`[BolStockSync] Sync complete in ${duration}s: ${updated} updated, ${failed} failed`);

      return {
        success: true,
        updated,
        failed,
        duration: `${duration}s`,
        errors: errors.slice(0, 10)
      };

    } catch (error) {
      console.error('[BolStockSync] Sync error:', error);
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Sync stock using a provided offer map (offerId -> ean)
   * More efficient if we already have the mapping
   */
  async syncWithOfferMap(offerMap) {
    if (this.isRunning) {
      console.log('[BolStockSync] Sync already running, skipping');
      return { success: false, message: 'Sync already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      await this.init();

      const eans = Object.values(offerMap).filter(Boolean);
      if (eans.length === 0) {
        return { success: true, updated: 0, message: 'No EANs in offer map' };
      }

      // Get stock levels from Odoo
      const stockByEan = await this.getStockByEans(eans);
      console.log(`[BolStockSync] Got stock for ${Object.keys(stockByEan).length} products`);

      // Update each offer
      let updated = 0;
      let failed = 0;
      const errors = [];

      for (const [offerId, ean] of Object.entries(offerMap)) {
        const stock = stockByEan[ean];
        if (stock === undefined) continue; // Product not in Odoo

        const result = await this.updateOfferStock(offerId, stock);

        if (result.success) {
          updated++;
        } else {
          failed++;
          errors.push({ offerId, ean, error: result.error });
        }

        await this.sleep(REQUEST_DELAY_MS);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastSync = new Date();
      this.lastResult = { updated, failed, duration, errors: errors.slice(0, 10) };

      return {
        success: true,
        updated,
        failed,
        duration: `${duration}s`,
        errors: errors.slice(0, 10)
      };

    } catch (error) {
      console.error('[BolStockSync] Sync error:', error);
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get sync status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastSync: this.lastSync,
      lastResult: this.lastResult
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the BolStockSync instance
 */
async function getBolStockSync() {
  if (!instance) {
    instance = new BolStockSync();
  }
  return instance;
}

/**
 * Run stock sync (for scheduler)
 */
async function runStockSync() {
  const sync = await getBolStockSync();
  return sync.syncFromOrders();
}

module.exports = {
  BolStockSync,
  getBolStockSync,
  runStockSync,
  CENTRAL_WAREHOUSE_ID
};
