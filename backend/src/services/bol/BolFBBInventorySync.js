/**
 * BolFBBInventorySync - Import FBB (Fulfillment by Bol) inventory from Bol.com
 *
 * Fetches inventory levels for products stored in Bol.com's fulfillment centers.
 * Stores inventory data in MongoDB for visibility in the dashboard.
 *
 * Flow:
 * 1. Fetch paginated inventory from GET /retailer/inventory
 * 2. Upsert each item to MongoDB collection bol_fbb_inventory
 * 3. Optionally update Odoo with FBB stock levels
 */

const mongoose = require('mongoose');

// FBB Inventory Schema
const fbbInventorySchema = new mongoose.Schema({
  ean: { type: String, required: true, unique: true, index: true },
  bsku: { type: String },              // Bol SKU
  title: { type: String },
  stock: { type: Number, default: 0 }, // Total FBB stock
  regularStock: { type: Number, default: 0 },
  gradedStock: { type: Number, default: 0 },
  nckStock: { type: Number, default: 0 }, // Non-compliant stock
  syncedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  collection: 'bol_fbb_inventory'
});

// Create model if not exists
let BolFBBInventory;
try {
  BolFBBInventory = mongoose.model('BolFBBInventory');
} catch {
  BolFBBInventory = mongoose.model('BolFBBInventory', fbbInventorySchema);
}

// Rate limiting
const PAGE_DELAY_MS = 500;
const MAX_RETRIES = 3;

// Token cache
let accessToken = null;
let tokenExpiry = null;

class BolFBBInventorySync {
  constructor() {
    this.isRunning = false;
    this.lastSync = null;
    this.lastResult = null;
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
  async bolRequest(endpoint, retries = MAX_RETRIES) {
    const token = await this.getAccessToken();

    const response = await fetch(`https://api.bol.com/retailer${endpoint}`, {
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 429 && retries > 0) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
      console.log(`[BolFBBInventory] Rate limited, waiting ${retryAfter}s...`);
      await this.sleep(retryAfter * 1000);
      return this.bolRequest(endpoint, retries - 1);
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Bol.com API error: ${response.status}`);
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
   * Fetch all FBB inventory from Bol.com (paginated)
   */
  async fetchAllInventory() {
    const allInventory = [];
    let page = 1;
    let hasMore = true;

    console.log('[BolFBBInventory] Fetching FBB inventory from Bol.com...');

    while (hasMore) {
      await this.sleep(PAGE_DELAY_MS);

      try {
        const data = await this.bolRequest(`/inventory?page=${page}`);
        const inventory = data.inventory || [];

        if (inventory.length === 0) {
          hasMore = false;
          break;
        }

        allInventory.push(...inventory);
        console.log(`[BolFBBInventory] Page ${page}: ${inventory.length} items (total: ${allInventory.length})`);

        // Bol.com returns max 50 items per page
        if (inventory.length < 50) {
          hasMore = false;
        } else {
          page++;
        }
      } catch (error) {
        console.error(`[BolFBBInventory] Error fetching page ${page}:`, error.message);
        break;
      }
    }

    return allInventory;
  }

  /**
   * Sync FBB inventory to MongoDB
   */
  async sync() {
    if (this.isRunning) {
      console.log('[BolFBBInventory] Sync already running, skipping');
      return { success: false, message: 'Sync already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      // Fetch all inventory from Bol.com
      const inventory = await this.fetchAllInventory();

      if (inventory.length === 0) {
        this.isRunning = false;
        return { success: true, synced: 0, message: 'No FBB inventory found' };
      }

      console.log(`[BolFBBInventory] Storing ${inventory.length} items to MongoDB...`);

      // Upsert each item
      let synced = 0;
      for (const item of inventory) {
        try {
          await BolFBBInventory.findOneAndUpdate(
            { ean: item.ean },
            {
              ean: item.ean,
              bsku: item.bsku || '',
              title: item.title || '',
              stock: item.stock?.stock || 0,
              regularStock: item.stock?.regularStock || 0,
              gradedStock: item.stock?.gradedStock || 0,
              nckStock: item.stock?.nckStock || 0,
              syncedAt: new Date()
            },
            { upsert: true, new: true }
          );
          synced++;
        } catch (dbError) {
          console.error(`[BolFBBInventory] DB error for EAN ${item.ean}:`, dbError.message);
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastSync = new Date();
      this.lastResult = { synced, duration };

      console.log(`[BolFBBInventory] Sync complete in ${duration}s: ${synced} items`);

      return {
        success: true,
        synced,
        duration: `${duration}s`
      };

    } catch (error) {
      console.error('[BolFBBInventory] Sync error:', error);
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get all FBB inventory from MongoDB
   */
  async getInventory(options = {}) {
    const { limit = 1000, minStock = null } = options;

    const query = {};
    if (minStock !== null) {
      query.stock = { $gte: minStock };
    }

    return BolFBBInventory.find(query)
      .sort({ stock: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Get FBB stock for specific EANs
   */
  async getStockByEans(eans) {
    if (!eans || eans.length === 0) return {};

    const items = await BolFBBInventory.find({ ean: { $in: eans } })
      .select('ean stock')
      .lean();

    const stockMap = {};
    for (const item of items) {
      stockMap[item.ean] = item.stock;
    }

    return stockMap;
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

  /**
   * Get inventory statistics
   */
  async getStats() {
    const [totalItems, totalStock, lastSync] = await Promise.all([
      BolFBBInventory.countDocuments(),
      BolFBBInventory.aggregate([
        { $group: { _id: null, total: { $sum: '$stock' } } }
      ]),
      BolFBBInventory.findOne().sort({ syncedAt: -1 }).select('syncedAt')
    ]);

    return {
      totalItems,
      totalStock: totalStock[0]?.total || 0,
      lastSyncedAt: lastSync?.syncedAt
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the BolFBBInventorySync instance
 */
async function getBolFBBInventorySync() {
  if (!instance) {
    instance = new BolFBBInventorySync();
  }
  return instance;
}

/**
 * Run FBB inventory sync (for scheduler)
 */
async function runFBBInventorySync() {
  const sync = await getBolFBBInventorySync();
  return sync.sync();
}

module.exports = {
  BolFBBInventorySync,
  getBolFBBInventorySync,
  runFBBInventorySync,
  BolFBBInventory
};
