/**
 * BolStockSync - Sync stock levels from Odoo to Bol.com
 *
 * Workflow (Emipro-style):
 * 1. Request offer export from Bol.com (async operation)
 * 2. Wait for export to complete
 * 3. Download and parse CSV to get all offers with offerId + EAN
 * 4. Get stock levels from Odoo Central Warehouse for all EANs
 * 5. Update each offer's stock via PUT /offers/{offerId}/stock
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

    if (response.status === 202 || response.status === 204) {
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
   * Request an offer export from Bol.com (Emipro workflow step 1)
   */
  async requestOfferExport() {
    console.log('[BolStockSync] Requesting offer export from Bol.com...');

    const token = await this.getAccessToken();
    const response = await fetch('https://api.bol.com/retailer/offers/export', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Content-Type': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ format: 'CSV' })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Failed to request offer export: ${response.status}`);
    }

    const result = await response.json();
    console.log(`[BolStockSync] Export requested, processStatusId: ${result.processStatusId}`);
    return result.processStatusId;
  }

  /**
   * Check process status (Emipro workflow step 2)
   */
  async getProcessStatus(processStatusId) {
    const token = await this.getAccessToken();
    const response = await fetch(`https://api.bol.com/shared/process-status/${processStatusId}`, {
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Failed to get process status: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Wait for offer export to complete (Emipro workflow step 2)
   */
  async waitForOfferExport(processStatusId, maxWaitMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 5000; // Check every 5 seconds

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getProcessStatus(processStatusId);
      console.log(`[BolStockSync] Export status: ${status.status}`);

      if (status.status === 'SUCCESS') {
        // Find the entityId (report ID) in the links
        const reportLink = status.links?.find(l => l.rel === 'self' || l.href?.includes('export'));
        if (reportLink) {
          const match = reportLink.href?.match(/export\/(\d+)/);
          if (match) return match[1];
        }
        return status.entityId;
      }

      if (status.status === 'FAILURE' || status.status === 'TIMEOUT') {
        throw new Error(`Offer export failed: ${status.errorMessage || status.status}`);
      }

      await this.sleep(pollInterval);
    }

    throw new Error('Offer export timed out');
  }

  /**
   * Download and parse the offer export CSV (Emipro workflow step 3)
   */
  async downloadOfferExport(reportId) {
    console.log(`[BolStockSync] Downloading offer export ${reportId}...`);

    const token = await this.getAccessToken();
    const response = await fetch(`https://api.bol.com/retailer/offers/export/${reportId}`, {
      headers: {
        'Accept': 'application/vnd.retailer.v10+csv',
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download offer export: ${response.status}`);
    }

    const csv = await response.text();
    return this.parseOfferCsv(csv);
  }

  /**
   * Parse offer export CSV
   * Columns: offerId, ean, stockAmount, fulfilmentType, etc.
   */
  parseOfferCsv(csv) {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const offers = [];
    let fbbSkipped = 0;

    // Find column indices
    const offerIdIdx = headers.indexOf('offerId');
    const eanIdx = headers.indexOf('ean');
    const stockIdx = headers.indexOf('stockAmount');
    const fulfillmentIdx = headers.indexOf('fulfilmentType');
    const refIdx = headers.indexOf('referenceCode');

    console.log(`[BolStockSync] CSV columns: offerId=${offerIdIdx}, ean=${eanIdx}, stock=${stockIdx}, fulfilment=${fulfillmentIdx}`);

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
      if (values.length < headers.length) continue;

      const offerId = values[offerIdIdx];
      const ean = values[eanIdx];
      const currentStock = parseInt(values[stockIdx]) || 0;
      const fulfillmentType = values[fulfillmentIdx] || '';
      const reference = values[refIdx] || '';

      // Skip invalid entries
      if (!offerId || !ean) continue;

      // Only include FBR offers (we manage stock for FBR, not FBB)
      // FBB stock is managed by Bol.com - updating FBB stock returns "Bad request"
      if (fulfillmentType && fulfillmentType.toUpperCase() === 'FBB') {
        fbbSkipped++;
        continue;
      }

      offers.push({
        offerId,
        ean,
        reference,
        currentStock,
        fulfillmentType
      });
    }

    console.log(`[BolStockSync] Parsed ${offers.length} FBR offers from CSV (${fbbSkipped} FBB skipped)`);
    return offers;
  }

  /**
   * Get stock levels from Odoo for multiple EANs (Emipro workflow step 4)
   */
  async getOdooStock(eans) {
    if (!eans || eans.length === 0) return {};

    // Find products by barcode (EAN) - no limit to get all matches
    const products = await this.odoo.searchRead('product.product',
      [['barcode', 'in', eans]],
      ['id', 'barcode'],
      { limit: 10000 }  // Override default limit of 100
    );

    console.log(`[BolStockSync] Found ${products.length} products in Odoo matching ${eans.length} EANs`);

    if (products.length === 0) return {};

    const productIds = products.map(p => p.id);
    const eanToProductId = {};
    products.forEach(p => {
      if (p.barcode) eanToProductId[p.barcode] = p.id;
    });

    // Get stock.quants for these products in Central Warehouse - no limit
    const quants = await this.odoo.searchRead('stock.quant',
      [
        ['product_id', 'in', productIds],
        ['location_id', '=', this.cwLocationId]
      ],
      ['product_id', 'quantity', 'reserved_quantity'],
      { limit: 10000 }  // Override default limit of 100
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
        stockByEan[ean] = 0; // Product exists but no stock
      }
    }

    return stockByEan;
  }

  /**
   * Update stock for a single offer on Bol.com (Emipro workflow step 5)
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
   * Main sync function - Emipro workflow
   */
  async syncFromOfferExport() {
    if (this.isRunning) {
      console.log('[BolStockSync] Sync already running, skipping');
      return { success: false, message: 'Sync already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      await this.init();

      // Step 1: Request offer export
      const processStatusId = await this.requestOfferExport();

      // Step 2: Wait for export to complete
      const reportId = await this.waitForOfferExport(processStatusId);
      console.log(`[BolStockSync] Export ready, report ID: ${reportId}`);

      // Step 3: Download and parse CSV
      const offers = await this.downloadOfferExport(reportId);

      if (offers.length === 0) {
        this.isRunning = false;
        return { success: true, updated: 0, message: 'No offers found in export' };
      }

      // Step 4: Get stock from Odoo for all EANs
      const allEans = [...new Set(offers.map(o => o.ean).filter(Boolean))];
      const odooStock = await this.getOdooStock(allEans);
      console.log(`[BolStockSync] Got Odoo stock for ${Object.keys(odooStock).length} of ${allEans.length} EANs`);

      // Log EANs not found in Odoo
      const notFoundEans = allEans.filter(ean => odooStock[ean] === undefined);
      if (notFoundEans.length > 0) {
        console.log(`[BolStockSync] EANs NOT FOUND in Odoo (${notFoundEans.length}): ${notFoundEans.join(', ')}`);
      }

      // Step 5: Update stock for each offer
      let updated = 0;
      let skipped = 0;
      let skippedNotInOdoo = 0;
      let skippedNoChange = 0;
      let failed = 0;
      const errors = [];

      for (const offer of offers) {
        const ean = offer.ean;
        const newStock = odooStock[ean];

        // Skip if no Odoo stock data (product doesn't exist in Odoo)
        if (newStock === undefined) {
          skipped++;
          skippedNotInOdoo++;
          continue;
        }

        // Only update if stock changed
        if (newStock === offer.currentStock) {
          skipped++;
          skippedNoChange++;
          continue;
        }

        // Update stock on Bol.com
        const result = await this.updateOfferStock(offer.offerId, newStock);

        if (result.success) {
          updated++;
          console.log(`[BolStockSync] Updated ${ean}: ${offer.currentStock} → ${newStock}`);
        } else {
          failed++;
          errors.push({ ean, offerId: offer.offerId, error: result.error });
          console.error(`[BolStockSync] Failed to update ${ean}:`, result.error);
        }

        // Rate limiting
        await this.sleep(REQUEST_DELAY_MS);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastSync = new Date();
      this.lastResult = {
        updated,
        skipped,
        skippedNotInOdoo,
        skippedNoChange,
        failed,
        duration,
        totalOffers: offers.length,
        notFoundEans,
        errors: errors.slice(0, 30)  // Keep all 30 errors
      };

      console.log(`[BolStockSync] Sync complete in ${duration}s: ${updated} updated, ${skipped} skipped (${skippedNotInOdoo} not in Odoo, ${skippedNoChange} no change), ${failed} failed`);

      // Log all failed updates
      if (errors.length > 0) {
        console.log(`[BolStockSync] Failed updates (${errors.length}):`);
        errors.forEach(e => console.log(`  - ${e.ean} (${e.offerId}): ${e.error}`));
      }

      return {
        success: true,
        updated,
        skipped,
        failed,
        totalOffers: offers.length,
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
   * Legacy method - redirects to new workflow
   */
  async syncFromOrders() {
    return this.syncFromOfferExport();
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
  return sync.syncFromOfferExport();
}

module.exports = {
  BolStockSync,
  getBolStockSync,
  runStockSync,
  CENTRAL_WAREHOUSE_ID
};
