/**
 * FBA Inventory Report Parser
 *
 * Parses Amazon FBA Inventory reports and syncs with Odoo warehouses.
 *
 * Report types supported:
 * - FBA Manage Inventory (from Inventory → Manage FBA Inventory → Download)
 * - FBA Inventory Age (from Reports → Fulfillment → Inventory Age)
 * - FBA Inventory Health (from Reports → Fulfillment → Inventory Health)
 */

const { parse } = require('csv-parse/sync');
const { getDb } = require('../../db');

// FBA Warehouse country mapping
const FBA_WAREHOUSES = {
  // Germany
  'BER1': 'DE', 'BER2': 'DE', 'BER3': 'DE',
  'CGN1': 'DE', 'CGN2': 'DE',
  'DUS2': 'DE', 'DUS4': 'DE',
  'DTM1': 'DE', 'DTM2': 'DE',
  'EDE4': 'DE', 'EDE5': 'DE',
  'FRA1': 'DE', 'FRA3': 'DE', 'FRA7': 'DE',
  'HAM2': 'DE',
  'LEJ1': 'DE', 'LEJ2': 'DE',
  'MUC3': 'DE',
  'STR1': 'DE',
  // France
  'LIL1': 'FR', 'ORY1': 'FR', 'ORY4': 'FR',
  'CDG5': 'FR', 'MRS1': 'FR', 'LYS1': 'FR',
  'ETZ1': 'FR', 'BVA1': 'FR', 'SXB1': 'FR',
  // Italy
  'MXP5': 'IT', 'FCO1': 'IT',
  // Spain
  'BCN1': 'ES', 'MAD4': 'ES', 'MAD6': 'ES',
  // Poland
  'WRO2': 'PL', 'WRO5': 'PL', 'KTW1': 'PL', 'POZ1': 'PL',
  // Czech Republic
  'PRG1': 'CZ', 'PRG2': 'CZ',
  // Netherlands
  'AMS1': 'NL',
  // UK
  'BHX1': 'GB', 'BHX2': 'GB', 'BHX3': 'GB', 'BHX4': 'GB',
  'EDI4': 'GB', 'EUK5': 'GB',
  'LBA1': 'GB', 'LBA2': 'GB',
  'LCY2': 'GB', 'LTN1': 'GB', 'LTN2': 'GB', 'LTN4': 'GB',
  'MAN1': 'GB', 'MAN2': 'GB', 'MAN3': 'GB',
  'MME1': 'GB', 'GLA1': 'GB',
  // Sweden
  'GOT1': 'SE',
};

class FbaInventoryReportParser {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Parse FBA Inventory report CSV
   * @param {string|Buffer} csvContent
   * @returns {Array} Parsed inventory items
   */
  parseCSV(csvContent) {
    // Try to detect delimiter (tab or comma)
    const firstLine = csvContent.toString().split('\n')[0];
    const delimiter = firstLine.includes('\t') ? '\t' : ',';

    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter,
      relaxColumnCount: true,
    });

    return records.map(row => this.mapRow(row));
  }

  /**
   * Map CSV row to normalized inventory item
   * Handles different report formats
   */
  mapRow(row) {
    // Standard Manage Inventory columns
    const sku = row['sku'] || row['SKU'] || row['seller-sku'] || row['Seller SKU'] || '';
    const asin = row['asin'] || row['ASIN'] || '';
    const fnsku = row['fnsku'] || row['FNSKU'] || row['fn-sku'] || '';
    const productName = row['product-name'] || row['Product Name'] || row['product_name'] || '';

    // Quantity fields - different reports use different names
    const fulfillable = parseInt(
      row['afn-fulfillable-quantity'] ||
      row['Fulfillable Quantity'] ||
      row['fulfillable-quantity'] ||
      row['Available'] ||
      0, 10
    );

    const inbound = parseInt(
      row['afn-inbound-working-quantity'] ||
      row['Inbound Working'] ||
      row['inbound-quantity'] ||
      0, 10
    );

    const inboundShipped = parseInt(
      row['afn-inbound-shipped-quantity'] ||
      row['Inbound Shipped'] ||
      0, 10
    );

    const inboundReceiving = parseInt(
      row['afn-inbound-receiving-quantity'] ||
      row['Inbound Receiving'] ||
      0, 10
    );

    const reserved = parseInt(
      row['afn-reserved-quantity'] ||
      row['Reserved Quantity'] ||
      row['reserved-quantity'] ||
      row['Reserved'] ||
      0, 10
    );

    const unfulfillable = parseInt(
      row['afn-unsellable-quantity'] ||
      row['Unfulfillable Quantity'] ||
      row['unfulfillable-quantity'] ||
      0, 10
    );

    const totalQuantity = parseInt(
      row['afn-total-quantity'] ||
      row['Total Quantity'] ||
      row['total-quantity'] ||
      (fulfillable + reserved + unfulfillable), 10
    );

    // Warehouse/FC info (if available)
    const warehouseCode = row['fulfillment-center-id'] || row['FC'] || row['Warehouse'] || '';
    const country = FBA_WAREHOUSES[warehouseCode] || row['country'] || '';

    // Price info (if available)
    const price = parseFloat(row['your-price'] || row['Price'] || 0);
    const currency = row['currency'] || 'EUR';

    return {
      sku,
      asin,
      fnsku,
      productName,
      fulfillable,
      inbound: inbound + inboundShipped + inboundReceiving,
      inboundWorking: inbound,
      inboundShipped,
      inboundReceiving,
      reserved,
      unfulfillable,
      totalQuantity,
      warehouseCode,
      country,
      price,
      currency,
    };
  }

  /**
   * Aggregate inventory by SKU (sum across all warehouses)
   * @param {Array} items
   * @returns {Map} SKU -> aggregated inventory
   */
  aggregateBySku(items) {
    const skuMap = new Map();

    for (const item of items) {
      if (!item.sku) continue;

      if (!skuMap.has(item.sku)) {
        skuMap.set(item.sku, {
          sku: item.sku,
          asin: item.asin,
          fnsku: item.fnsku,
          productName: item.productName,
          fulfillable: 0,
          inbound: 0,
          reserved: 0,
          unfulfillable: 0,
          totalQuantity: 0,
          warehouses: [],
        });
      }

      const agg = skuMap.get(item.sku);
      agg.fulfillable += item.fulfillable;
      agg.inbound += item.inbound;
      agg.reserved += item.reserved;
      agg.unfulfillable += item.unfulfillable;
      agg.totalQuantity += item.totalQuantity;

      if (item.warehouseCode) {
        agg.warehouses.push({
          code: item.warehouseCode,
          country: item.country,
          quantity: item.fulfillable,
        });
      }
    }

    return skuMap;
  }

  /**
   * Aggregate inventory by country
   * @param {Array} items
   * @returns {Map} Country -> SKU -> quantity
   */
  aggregateByCountry(items) {
    const countryMap = new Map();

    for (const item of items) {
      if (!item.sku || !item.country) continue;

      if (!countryMap.has(item.country)) {
        countryMap.set(item.country, new Map());
      }

      const skuMap = countryMap.get(item.country);
      if (!skuMap.has(item.sku)) {
        skuMap.set(item.sku, {
          sku: item.sku,
          asin: item.asin,
          fulfillable: 0,
          reserved: 0,
        });
      }

      const entry = skuMap.get(item.sku);
      entry.fulfillable += item.fulfillable;
      entry.reserved += item.reserved;
    }

    return countryMap;
  }

  /**
   * Process and store inventory report
   * @param {string|Buffer} content
   * @param {string} filename
   * @returns {object} Processing result
   */
  async processReport(content, filename) {
    const db = getDb();

    // Parse CSV
    const items = this.parseCSV(content);

    // Aggregate by SKU
    const bySkuMap = this.aggregateBySku(items);
    const bySku = Array.from(bySkuMap.values());

    // Aggregate by country
    const byCountryMap = this.aggregateByCountry(items);
    const byCountry = {};
    for (const [country, skuMap] of byCountryMap) {
      byCountry[country] = Array.from(skuMap.values());
    }

    // Calculate summary
    const summary = {
      totalSkus: bySku.length,
      totalFulfillable: bySku.reduce((sum, s) => sum + s.fulfillable, 0),
      totalInbound: bySku.reduce((sum, s) => sum + s.inbound, 0),
      totalReserved: bySku.reduce((sum, s) => sum + s.reserved, 0),
      totalUnfulfillable: bySku.reduce((sum, s) => sum + s.unfulfillable, 0),
      countries: Object.keys(byCountry),
    };

    // Store report
    const doc = {
      filename,
      uploadedAt: new Date(),
      itemCount: items.length,
      skuCount: bySku.length,
      summary,
      status: 'processed',
    };

    const reportResult = await db.collection('amazon_fba_inventory_reports').insertOne(doc);

    // Store inventory snapshot
    await db.collection('amazon_fba_inventory').deleteMany({}); // Clear old data
    if (bySku.length > 0) {
      const inventoryDocs = bySku.map(item => ({
        ...item,
        reportId: reportResult.insertedId,
        snapshotDate: new Date(),
      }));
      await db.collection('amazon_fba_inventory').insertMany(inventoryDocs);
    }

    return {
      reportId: reportResult.insertedId.toString(),
      itemCount: items.length,
      skuCount: bySku.length,
      summary,
      byCountry,
    };
  }

  /**
   * Get current FBA inventory
   * @returns {Array}
   */
  async getCurrentInventory() {
    const db = getDb();
    return db.collection('amazon_fba_inventory')
      .find({})
      .sort({ sku: 1 })
      .toArray();
  }

  /**
   * Get inventory by country
   * @param {string} country
   * @returns {Array}
   */
  async getInventoryByCountry(country) {
    const db = getDb();
    return db.collection('amazon_fba_inventory')
      .find({ 'warehouses.country': country })
      .toArray();
  }

  /**
   * Compare FBA inventory with Odoo stock
   * @param {object} odooClient
   * @returns {Array} Discrepancies
   */
  async compareWithOdoo(odooClient) {
    const fbaInventory = await this.getCurrentInventory();
    const discrepancies = [];

    for (const item of fbaInventory) {
      // Find product in Odoo by SKU
      const products = await odooClient.searchRead('product.product',
        [['default_code', '=', item.sku]],
        ['id', 'name', 'qty_available']
      );

      if (products.length === 0) {
        discrepancies.push({
          sku: item.sku,
          type: 'missing_in_odoo',
          fbaQuantity: item.fulfillable,
          odooQuantity: null,
        });
        continue;
      }

      // For FBA, we'd check against specific FBA warehouse locations
      // This is simplified - real implementation would check by warehouse
      const odooQty = products[0].qty_available || 0;
      if (Math.abs(odooQty - item.fulfillable) > 0) {
        discrepancies.push({
          sku: item.sku,
          productId: products[0].id,
          productName: products[0].name,
          type: 'quantity_mismatch',
          fbaQuantity: item.fulfillable,
          odooQuantity: odooQty,
          difference: item.fulfillable - odooQty,
        });
      }
    }

    return discrepancies;
  }
}

module.exports = { FbaInventoryReportParser, FBA_WAREHOUSES };
