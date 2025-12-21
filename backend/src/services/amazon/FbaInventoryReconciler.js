/**
 * FBA Inventory Reconciliation Service
 *
 * Syncs Amazon FBA inventory levels with Odoo warehouses.
 *
 * Features:
 * - Maps FBA fulfillment centers to Odoo warehouses
 * - Aggregates inventory by country (DE, FR, PL, etc.)
 * - Creates inventory adjustments in Odoo
 * - Tracks discrepancies and generates reports
 */

const { FBA_WAREHOUSE_COUNTRY } = require('./EuCountryConfig');
const { skuResolver } = require('./SkuResolver');

// Odoo warehouse names by FBA country
const ODOO_FBA_WAREHOUSES = {
  DE: 'Amazon FBA DE',
  FR: 'Amazon FBA FR',
  IT: 'Amazon FBA IT',
  ES: 'Amazon FBA ES',
  PL: 'Amazon FBA PL',
  CZ: 'Amazon FBA CZ',
  NL: 'Amazon FBA NL',
  BE: 'Amazon FBA BE',
  SE: 'Amazon FBA SE',
  GB: 'Amazon FBA UK',
};

class FbaInventoryReconciler {
  constructor(odooClient) {
    this.odoo = odooClient;
    this.warehouseCache = new Map();
    this.locationCache = new Map();
    this.productCache = new Map();
  }

  /**
   * Import FBA inventory report
   * @param {object} params
   * @param {string} params.reportType - GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA, etc.
   * @param {Array|string} params.content - Report content (CSV/TSV or parsed array)
   * @param {string} params.reportId - Amazon report ID
   * @returns {object} Import results
   */
  async importInventoryReport({ reportType, content, reportId }) {
    const startTime = Date.now();
    const results = {
      reportId,
      reportType,
      processed: 0,
      updated: 0,
      created: 0,
      skipped: 0,
      errors: [],
      byCountry: {},
      discrepancies: [],
    };

    try {
      // Parse content if string
      const items = typeof content === 'string'
        ? this.parseInventoryReport(content, reportType)
        : content;

      console.log(`[FbaInventoryReconciler] Processing ${items.length} inventory items`);

      // Aggregate by country and SKU
      const aggregated = this.aggregateByCountry(items);

      // Process each country
      for (const [country, skuItems] of Object.entries(aggregated)) {
        results.byCountry[country] = {
          total: Object.keys(skuItems).length,
          updated: 0,
          errors: 0,
        };

        // Get or create Odoo warehouse for this country
        const warehouse = await this.getOrCreateWarehouse(country);
        if (!warehouse) {
          results.errors.push(`Could not find/create warehouse for country ${country}`);
          continue;
        }

        // Process each SKU
        for (const [sku, item] of Object.entries(skuItems)) {
          results.processed++;

          try {
            const result = await this.reconcileSku(sku, item, warehouse, country);

            if (result.updated) {
              results.updated++;
              results.byCountry[country].updated++;
            }
            if (result.created) {
              results.created++;
            }
            if (result.skipped) {
              results.skipped++;
            }
            if (result.discrepancy) {
              results.discrepancies.push(result.discrepancy);
            }
          } catch (error) {
            results.errors.push({
              sku,
              country,
              error: error.message
            });
            results.byCountry[country].errors++;
          }
        }
      }

      results.duration = Date.now() - startTime;
      console.log(`[FbaInventoryReconciler] Import complete: ${results.updated} updated, ${results.errors.length} errors`);

      return results;

    } catch (error) {
      console.error('[FbaInventoryReconciler] Import failed:', error);
      results.errors.push({ general: error.message });
      return results;
    }
  }

  /**
   * Parse inventory report content
   * @param {string} content - TSV/CSV content
   * @param {string} reportType
   * @returns {Array} Parsed items
   */
  parseInventoryReport(content, reportType) {
    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length < 2) return [];

    // Parse header
    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'));
    const items = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      const item = {};

      headers.forEach((header, idx) => {
        item[header] = values[idx]?.trim() || '';
      });

      // Map common field names
      items.push(this.normalizeInventoryItem(item, reportType));
    }

    return items;
  }

  /**
   * Normalize inventory item fields
   * @param {object} item - Raw item
   * @param {string} reportType
   * @returns {object} Normalized item
   */
  normalizeInventoryItem(item, reportType) {
    // Handle different report formats
    // GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA format
    // GET_FBA_INVENTORY_PLANNING_DATA format
    // GET_AFN_INVENTORY_DATA format

    return {
      sku: item.seller_sku || item.sku || item.msku || '',
      asin: item.asin || '',
      fnsku: item.fnsku || '',
      fulfillmentCenterId: item.fulfillment_center_id || item.fc || item.warehouse || '',
      quantity: parseInt(item.quantity || item.afn_fulfillable_quantity || item.available || '0', 10),
      reserved: parseInt(item.afn_reserved_quantity || item.reserved || '0', 10),
      inbound: parseInt(item.afn_inbound_working_quantity || item.inbound_working || '0', 10),
      unfulfillable: parseInt(item.afn_unsellable_quantity || item.unfulfillable || '0', 10),
      totalQuantity: parseInt(item.afn_total_quantity || item.total || '0', 10),
      condition: item.condition || 'New',
      productName: item.product_name || item.title || '',
    };
  }

  /**
   * Aggregate inventory items by country
   * @param {Array} items
   * @returns {object} { country: { sku: aggregatedItem } }
   */
  aggregateByCountry(items) {
    const result = {};

    for (const item of items) {
      // Determine country from fulfillment center
      let country = this.getCountryFromFc(item.fulfillmentCenterId);

      // If no FC, try to infer from other data or default to DE
      if (!country) {
        country = 'DE';
      }

      if (!result[country]) {
        result[country] = {};
      }

      const sku = item.sku;
      if (!sku) continue;

      // Aggregate if same SKU appears multiple times in same country
      if (result[country][sku]) {
        result[country][sku].quantity += item.quantity;
        result[country][sku].reserved += item.reserved;
        result[country][sku].unfulfillable += item.unfulfillable;
        result[country][sku].totalQuantity += item.totalQuantity;
        result[country][sku].fcList.push(item.fulfillmentCenterId);
      } else {
        result[country][sku] = {
          ...item,
          fcList: [item.fulfillmentCenterId],
        };
      }
    }

    return result;
  }

  /**
   * Get country from fulfillment center code
   * @param {string} fcCode
   * @returns {string|null}
   */
  getCountryFromFc(fcCode) {
    if (!fcCode) return null;

    // Extract FC code (e.g., "WRO1" from "Amazon WRO1")
    const match = fcCode.match(/([A-Z]{3,4}\d)/i);
    if (match) {
      return FBA_WAREHOUSE_COUNTRY[match[1].toUpperCase()] || null;
    }
    return null;
  }

  /**
   * Get or create Odoo warehouse for FBA country
   * @param {string} country
   * @returns {object|null} Warehouse info { id, name, locationId }
   */
  async getOrCreateWarehouse(country) {
    // Check cache
    if (this.warehouseCache.has(country)) {
      return this.warehouseCache.get(country);
    }

    const warehouseName = ODOO_FBA_WAREHOUSES[country];
    if (!warehouseName) {
      console.warn(`[FbaInventoryReconciler] No warehouse config for country: ${country}`);
      return null;
    }

    try {
      // Search for warehouse
      const warehouses = await this.odoo.searchRead('stock.warehouse',
        [['name', 'ilike', warehouseName]],
        ['id', 'name', 'lot_stock_id']
      );

      if (warehouses.length > 0) {
        const wh = warehouses[0];
        const result = {
          id: wh.id,
          name: wh.name,
          locationId: wh.lot_stock_id?.[0] || null,
        };
        this.warehouseCache.set(country, result);
        return result;
      }

      // Warehouse not found - could create it, but for now just log
      console.warn(`[FbaInventoryReconciler] Warehouse not found: ${warehouseName}`);
      return null;

    } catch (error) {
      console.error(`[FbaInventoryReconciler] Error finding warehouse for ${country}:`, error);
      return null;
    }
  }

  /**
   * Reconcile a single SKU's inventory
   * @param {string} sku - Amazon SKU
   * @param {object} item - Aggregated inventory item
   * @param {object} warehouse - Odoo warehouse info
   * @param {string} country
   * @returns {object} { updated, created, skipped, discrepancy }
   */
  async reconcileSku(sku, item, warehouse, country) {
    const result = { updated: false, created: false, skipped: false, discrepancy: null };

    // Resolve SKU to Odoo product
    const mapping = await skuResolver.getOdooProduct(sku);
    if (!mapping) {
      result.skipped = true;
      return result;
    }

    const productId = mapping.odooProductId;

    // Get current stock in Odoo for this product/warehouse
    const currentStock = await this.getOdooStock(productId, warehouse.locationId);

    // Calculate expected quantity (sellable + reserved)
    const amazonQty = item.quantity + item.reserved;

    // Check for discrepancy
    if (currentStock !== amazonQty) {
      result.discrepancy = {
        sku,
        productId,
        country,
        warehouse: warehouse.name,
        odooQty: currentStock,
        amazonQty,
        difference: amazonQty - currentStock,
      };

      // Create inventory adjustment
      await this.createInventoryAdjustment(
        productId,
        warehouse.locationId,
        amazonQty,
        `FBA Sync: ${sku} (${country})`
      );

      result.updated = true;
    }

    return result;
  }

  /**
   * Get current Odoo stock for product at location
   * @param {number} productId
   * @param {number} locationId
   * @returns {number}
   */
  async getOdooStock(productId, locationId) {
    try {
      const quants = await this.odoo.searchRead('stock.quant',
        [
          ['product_id', '=', productId],
          ['location_id', '=', locationId],
        ],
        ['quantity']
      );

      return quants.reduce((sum, q) => sum + (q.quantity || 0), 0);

    } catch (error) {
      console.error(`[FbaInventoryReconciler] Error getting stock for product ${productId}:`, error);
      return 0;
    }
  }

  /**
   * Create inventory adjustment in Odoo
   * @param {number} productId
   * @param {number} locationId
   * @param {number} newQty
   * @param {string} reason
   */
  async createInventoryAdjustment(productId, locationId, newQty, reason) {
    try {
      // Use stock.quant model to set inventory
      // In Odoo 16+, use stock.quant with action_apply_inventory

      // Find existing quant
      const quants = await this.odoo.searchRead('stock.quant',
        [
          ['product_id', '=', productId],
          ['location_id', '=', locationId],
        ],
        ['id', 'quantity', 'inventory_quantity']
      );

      if (quants.length > 0) {
        // Update existing quant
        const quantId = quants[0].id;
        await this.odoo.write('stock.quant', [quantId], {
          inventory_quantity: newQty,
          inventory_quantity_set: true,
        });

        // Apply the inventory adjustment
        await this.odoo.execute('stock.quant', 'action_apply_inventory', [[quantId]]);
      } else {
        // Create new quant (this usually requires a stock move, but we'll try direct create)
        // In most cases, Odoo handles this through inventory adjustments
        const quantId = await this.odoo.create('stock.quant', {
          product_id: productId,
          location_id: locationId,
          inventory_quantity: newQty,
          inventory_quantity_set: true,
        });

        if (quantId) {
          await this.odoo.execute('stock.quant', 'action_apply_inventory', [[quantId]]);
        }
      }

      console.log(`[FbaInventoryReconciler] Adjusted inventory: product ${productId}, location ${locationId}, qty ${newQty}`);

    } catch (error) {
      console.error(`[FbaInventoryReconciler] Error adjusting inventory:`, error);
      throw error;
    }
  }

  /**
   * Get inventory snapshot from Odoo for all FBA warehouses
   * @returns {object} { country: { sku: quantity } }
   */
  async getOdooFbaSnapshot() {
    const snapshot = {};

    for (const [country, warehouseName] of Object.entries(ODOO_FBA_WAREHOUSES)) {
      const warehouse = await this.getOrCreateWarehouse(country);
      if (!warehouse?.locationId) continue;

      try {
        const quants = await this.odoo.searchRead('stock.quant',
          [
            ['location_id', 'child_of', warehouse.locationId],
            ['quantity', '>', 0],
          ],
          ['product_id', 'quantity']
        );

        snapshot[country] = {};
        for (const q of quants) {
          const productId = q.product_id?.[0];
          if (productId) {
            // Get SKU from product
            const product = await this.getProductInfo(productId);
            if (product?.sku) {
              snapshot[country][product.sku] = (snapshot[country][product.sku] || 0) + q.quantity;
            }
          }
        }

      } catch (error) {
        console.error(`[FbaInventoryReconciler] Error getting snapshot for ${country}:`, error);
      }
    }

    return snapshot;
  }

  /**
   * Get product info from cache or Odoo
   * @param {number} productId
   * @returns {object|null}
   */
  async getProductInfo(productId) {
    if (this.productCache.has(productId)) {
      return this.productCache.get(productId);
    }

    try {
      const products = await this.odoo.searchRead('product.product',
        [['id', '=', productId]],
        ['id', 'name', 'default_code']
      );

      if (products.length > 0) {
        const product = {
          id: products[0].id,
          name: products[0].name,
          sku: products[0].default_code,
        };
        this.productCache.set(productId, product);
        return product;
      }

    } catch (error) {
      console.error(`[FbaInventoryReconciler] Error getting product ${productId}:`, error);
    }

    return null;
  }

  /**
   * Generate discrepancy report
   * @param {Array} discrepancies
   * @returns {object}
   */
  generateDiscrepancyReport(discrepancies) {
    const report = {
      totalDiscrepancies: discrepancies.length,
      totalDifference: 0,
      byCountry: {},
      items: discrepancies,
    };

    for (const d of discrepancies) {
      report.totalDifference += d.difference;

      if (!report.byCountry[d.country]) {
        report.byCountry[d.country] = {
          count: 0,
          totalDifference: 0,
        };
      }
      report.byCountry[d.country].count++;
      report.byCountry[d.country].totalDifference += d.difference;
    }

    return report;
  }

  /**
   * Clear caches
   */
  clearCaches() {
    this.warehouseCache.clear();
    this.locationCache.clear();
    this.productCache.clear();
  }
}

module.exports = { FbaInventoryReconciler, ODOO_FBA_WAREHOUSES };
