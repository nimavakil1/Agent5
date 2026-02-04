/**
 * ProductSyncService - Syncs products and stock from Odoo to MongoDB
 *
 * Features:
 * - Full sync: Imports all products from Odoo
 * - Incremental sync: Only updates products modified since last sync
 * - Stock sync: Updates stock levels per warehouse from stock.quant
 */

const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');
const Product = require('../models/Product');

const CW_WAREHOUSE_ID = 1;  // Central Warehouse
const BATCH_SIZE = 500;

class ProductSyncService {
  constructor() {
    this.odoo = null;
    this.warehouses = [];
    this.locationToWarehouse = {};
    this.isRunning = false;
    this.lastSync = null;
    this.packagingCache = {};  // Cache packaging details by ID
  }

  async init() {
    if (!this.odoo) {
      this.odoo = new OdooDirectClient();
      await this.odoo.authenticate();
    }
    return this;
  }

  async loadWarehouses() {
    const warehouses = await this.odoo.searchRead('stock.warehouse', [], [
      'id', 'name', 'code', 'lot_stock_id'
    ], { order: 'id asc' });

    this.warehouses = [];
    this.locationToWarehouse = {};

    for (const w of warehouses) {
      if (w.lot_stock_id) {
        this.warehouses.push({
          id: w.id,
          name: w.name,
          code: w.code,
          locationId: w.lot_stock_id[0]
        });
        this.locationToWarehouse[w.lot_stock_id[0]] = w.id;
      }
    }

    console.log('[ProductSync] Loaded ' + this.warehouses.length + ' warehouses');
    return this.warehouses;
  }

  async getStockByProduct(productIds = null) {
    await this.loadWarehouses();

    const locationIds = Object.keys(this.locationToWarehouse).map(Number);
    if (locationIds.length === 0) return {};

    const domain = [
      ['location_id', 'in', locationIds],
      ['quantity', '!=', 0]
    ];

    if (productIds && productIds.length > 0) {
      domain.push(['product_id', 'in', productIds]);
    }

    const quants = await this.odoo.searchRead('stock.quant', domain, [
      'product_id', 'location_id', 'quantity'
    ], { limit: 100000 });

    const stockByProduct = {};
    for (const q of quants) {
      const productId = q.product_id[0];
      const locationId = q.location_id[0];
      const warehouseId = this.locationToWarehouse[locationId];

      if (!warehouseId) continue;

      if (!stockByProduct[productId]) {
        stockByProduct[productId] = {};
      }
      stockByProduct[productId][warehouseId] = 
        (stockByProduct[productId][warehouseId] || 0) + q.quantity;
    }

    return stockByProduct;
  }

  /**
   * Fetch packaging details from Odoo
   * @param {number[]} packagingIds - Array of product.packaging IDs
   * @returns {Object} Map of packaging ID to {name, qty}
   */
  async fetchPackagingDetails(packagingIds) {
    if (!packagingIds || packagingIds.length === 0) return {};

    // Filter out IDs we already have cached
    const uncachedIds = packagingIds.filter(id => !this.packagingCache[id]);

    if (uncachedIds.length > 0) {
      try {
        const packagings = await this.odoo.read('product.packaging', uncachedIds, ['id', 'name', 'qty']);
        for (const pkg of packagings) {
          this.packagingCache[pkg.id] = { name: pkg.name, qty: pkg.qty };
        }
      } catch (err) {
        console.error('[ProductSync] Error fetching packaging details:', err.message);
      }
    }

    // Build result from cache
    const result = {};
    for (const id of packagingIds) {
      if (this.packagingCache[id]) {
        result[id] = this.packagingCache[id];
      }
    }
    return result;
  }

  /**
   * Get packaging array for a product
   * @param {number[]} packagingIds - Array of product.packaging IDs
   * @param {Object} packagingMap - Map from fetchPackagingDetails
   * @returns {Array} Array of {name, qty} sorted by qty desc
   */
  getPackagingArray(packagingIds, packagingMap) {
    if (!packagingIds || packagingIds.length === 0) return [];

    const packaging = packagingIds
      .map(id => packagingMap[id])
      .filter(Boolean)
      .sort((a, b) => b.qty - a.qty);  // Sort by qty descending

    return packaging;
  }

  transformProduct(p, stockMap = {}, packagingMap = {}) {
    const stockByWarehouse = stockMap[p.id] || {};
    const totalStock = Object.values(stockByWarehouse).reduce((sum, qty) => sum + qty, 0);
    const cwStock = stockByWarehouse[CW_WAREHOUSE_ID] || 0;

    return {
      odooId: p.id,
      name: p.name,
      sku: p.default_code || '',
      barcode: p.barcode || '',
      active: p.active !== false,
      type: p.type,
      category: p.categ_id ? p.categ_id[1] : '',
      categoryId: p.categ_id ? p.categ_id[0] : null,
      salePrice: p.list_price || 0,
      cost: p.standard_price || 0,
      uom: p.uom_id ? p.uom_id[1] : '',
      uomId: p.uom_id ? p.uom_id[0] : null,
      weight: p.weight || 0,
      volume: p.volume || 0,
      canSell: p.sale_ok !== false,
      canPurchase: p.purchase_ok === true,
      image: p.image_128 ? 'data:image/png;base64,' + p.image_128 : null,
      stockByWarehouse: stockByWarehouse,
      totalStock,
      cwStock,
      safetyStock: p.x_safety_stock ?? 10,  // Default to 10 if not set in Odoo
      odooWriteDate: p.write_date ? new Date(p.write_date) : new Date(),
      syncedAt: new Date()
    };
  }

  async fullSync() {
    if (this.isRunning) {
      console.log('[ProductSync] Sync already running, skipping');
      return { synced: 0, skipped: true };
    }

    this.isRunning = true;
    try {
      await this.init();
      console.log('[ProductSync] Starting full sync...');

      const fields = [
        'id', 'name', 'default_code', 'barcode', 'active', 'type',
        'categ_id', 'list_price', 'standard_price', 'uom_id',
        'weight', 'volume', 'sale_ok', 'purchase_ok', 'image_128',
        'write_date', 'x_safety_stock'
      ];

      const domain = [['sale_ok', '=', true]];
      const totalCount = await this.odoo.searchCount('product.product', domain);
      console.log('[ProductSync] Total products to sync: ' + totalCount);

      console.log('[ProductSync] Fetching stock levels...');
      const stockByProduct = await this.getStockByProduct();
      console.log('[ProductSync] Got stock for ' + Object.keys(stockByProduct).length + ' products');

      let offset = 0;
      let synced = 0;

      while (offset < totalCount) {
        const products = await this.odoo.searchRead('product.product', domain, fields, {
          limit: BATCH_SIZE,
          offset,
          order: 'id asc'
        });

        if (products.length === 0) break;

        const transformed = products.map(p => this.transformProduct(p, stockByProduct));
        await Product.bulkUpsertFromOdoo(transformed);

        synced += products.length;
        offset += BATCH_SIZE;

        console.log('[ProductSync] Progress: ' + synced + '/' + totalCount);
      }

      this.lastSync = new Date();
      console.log('[ProductSync] Full sync complete: ' + synced + ' products');
      return { synced, total: totalCount };
    } finally {
      this.isRunning = false;
    }
  }

  async incrementalSync() {
    if (this.isRunning) {
      console.log('[ProductSync] Sync already running, skipping');
      return { synced: 0, skipped: true };
    }

    this.isRunning = true;
    try {
      await this.init();

      const lastSynced = await Product.findOne({}, { syncedAt: 1 })
        .sort({ syncedAt: -1 })
        .lean();

      const sinceDate = lastSynced && lastSynced.syncedAt 
        ? new Date(lastSynced.syncedAt.getTime() - 60000)
        : new Date(Date.now() - 3600000);

      const sinceStr = sinceDate.toISOString().replace('T', ' ').slice(0, 19);
      console.log('[ProductSync] Incremental sync since: ' + sinceStr);

      const fields = [
        'id', 'name', 'default_code', 'barcode', 'active', 'type',
        'categ_id', 'list_price', 'standard_price', 'uom_id',
        'weight', 'volume', 'sale_ok', 'purchase_ok', 'image_128',
        'write_date', 'x_safety_stock'
      ];

      const domain = [
        ['sale_ok', '=', true],
        ['write_date', '>=', sinceStr]
      ];

      const products = await this.odoo.searchRead('product.product', domain, fields, {
        order: 'write_date asc',
        limit: 5000
      });

      if (products.length === 0) {
        console.log('[ProductSync] No products modified since last sync');
        return { synced: 0, total: 0 };
      }

      console.log('[ProductSync] Found ' + products.length + ' modified products');

      const productIds = products.map(p => p.id);
      const stockByProduct = await this.getStockByProduct(productIds);

      const transformed = products.map(p => this.transformProduct(p, stockByProduct));
      await Product.bulkUpsertFromOdoo(transformed);

      this.lastSync = new Date();
      console.log('[ProductSync] Incremental sync complete: ' + products.length + ' products');
      return { synced: products.length, total: products.length };
    } finally {
      this.isRunning = false;
    }
  }

  async syncStock() {
    if (this.isRunning) return { updated: 0, skipped: true };

    this.isRunning = true;
    try {
      await this.init();
      console.log('[ProductSync] Syncing stock levels...');

      const stockByProduct = await this.getStockByProduct();
      const productIds = Object.keys(stockByProduct);

      if (productIds.length === 0) {
        console.log('[ProductSync] No stock data found');
        return { updated: 0 };
      }

      const bulkOps = [];
      for (const productIdStr of productIds) {
        const productId = Number(productIdStr);
        const warehouseStock = stockByProduct[productId];
        const totalStock = Object.values(warehouseStock).reduce((sum, qty) => sum + qty, 0);
        const cwStock = warehouseStock[CW_WAREHOUSE_ID] || 0;

        bulkOps.push({
          updateOne: {
            filter: { odooId: productId },
            update: {
              $set: {
                stockByWarehouse: warehouseStock,
                totalStock,
                cwStock,
                syncedAt: new Date()
              }
            }
          }
        });
      }

      let updated = 0;
      if (bulkOps.length > 0) {
        const result = await Product.bulkWrite(bulkOps, { ordered: false });
        updated = result.modifiedCount;
      }

      this.lastSync = new Date();
      console.log('[ProductSync] Stock sync complete: ' + updated + ' products');
      return { updated };
    } finally {
      this.isRunning = false;
    }
  }

  async getStatus() {
    const total = await Product.countDocuments();
    const lastSync = await Product.findOne({}, { syncedAt: 1 }).sort({ syncedAt: -1 }).lean();
    
    if (this.warehouses.length === 0) {
      try {
        await this.init();
        await this.loadWarehouses();
      } catch (e) {
        console.error('[ProductSync] Failed to load warehouses:', e.message);
      }
    }

    return {
      totalProducts: total,
      lastSyncedAt: lastSync ? lastSync.syncedAt : null,
      isRunning: this.isRunning,
      warehouses: this.warehouses
    };
  }
}

let instance = null;

function getProductSyncService() {
  if (!instance) {
    instance = new ProductSyncService();
  }
  return instance;
}

module.exports = { ProductSyncService, getProductSyncService };
