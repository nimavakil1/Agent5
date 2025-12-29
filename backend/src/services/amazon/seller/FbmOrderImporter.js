/**
 * FBM Order Importer - Import FBM orders from Amazon TSV file
 *
 * Handles:
 * - Parsing Amazon "Unshipped Orders" TSV report
 * - Creating customers with real names and addresses
 * - SKU matching using SkuResolver
 * - Creating confirmed sale orders in Odoo
 *
 * @module FbmOrderImporter
 */

const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { skuResolver } = require('../SkuResolver');
const { getDb } = require('../../../db');

// Odoo constants
const PAYMENT_TERM_21_DAYS = 2;
const AMAZON_SELLER_TEAM_ID = 11;
const FBM_WAREHOUSE_ID = 1; // Belgium warehouse (CW)

/**
 * Journal configuration for FBM orders
 * FBM always ships from Belgium (CW warehouse)
 */
const FBM_JOURNALS = {
  'BE': { code: 'VBE', id: 1 },   // Domestic Belgium
  'OSS': { code: 'VOS', id: 12 }, // EU cross-border (OSS)
  'EXPORT': { code: 'VEX', id: 52 }, // Non-EU export
};

/**
 * EU countries for determining OSS vs Export
 */
const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'
];

class FbmOrderImporter {
  constructor() {
    this.odoo = null;
    this.countryCache = {};
    this.productCache = {};
    this.partnerCache = {};
  }

  async init() {
    if (this.odoo) return;

    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    // Load countries cache
    const countries = await this.odoo.searchRead('res.country', [], ['id', 'code', 'name']);
    for (const c of countries) {
      this.countryCache[c.code] = c.id;
    }

    // Load SKU resolver
    if (!skuResolver.loaded) {
      await skuResolver.load();
    }
  }

  /**
   * Parse TSV file content
   * @param {string} content - TSV file content
   * @returns {Object} Parsed orders grouped by order ID
   */
  parseTsv(content) {
    const lines = content.trim().split('\n');
    if (lines.length < 2) {
      throw new Error('TSV file is empty or has no data rows');
    }

    const headers = lines[0].split('\t');
    const headerIndex = {};
    headers.forEach((h, i) => headerIndex[h.trim()] = i);

    // Determine which report type based on columns
    const hasRecipientName = 'recipient-name' in headerIndex;
    const hasShipAddress = 'ship-address-1' in headerIndex;

    if (!hasRecipientName || !hasShipAddress) {
      throw new Error('TSV file must be an "Unshipped Orders" report with recipient-name and ship-address columns');
    }

    const orderGroups = {};

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      if (cols.length < 10) continue;

      const orderId = cols[headerIndex['order-id']]?.trim();
      if (!orderId) continue;

      const sku = cols[headerIndex['sku']]?.trim();
      const resolved = this.resolveSku(sku);

      if (!orderGroups[orderId]) {
        orderGroups[orderId] = {
          orderId,
          recipientName: cols[headerIndex['recipient-name']]?.trim() || '',
          address1: cols[headerIndex['ship-address-1']]?.trim() || '',
          address2: cols[headerIndex['ship-address-2']]?.trim() || '',
          address3: cols[headerIndex['ship-address-3']]?.trim() || '',
          city: cols[headerIndex['ship-city']]?.trim() || '',
          state: cols[headerIndex['ship-state']]?.trim() || '',
          postalCode: cols[headerIndex['ship-postal-code']]?.trim() || '',
          country: cols[headerIndex['ship-country']]?.trim() || '',
          purchaseDate: cols[headerIndex['purchase-date']]?.split('T')[0] || new Date().toISOString().split('T')[0],
          isBusinessOrder: cols[headerIndex['is-business-order']]?.trim() === 'true',
          buyerCompanyName: cols[headerIndex['buyer-company-name']]?.trim() || '',
          addressType: cols[headerIndex['address-type']]?.trim() || 'Residential',
          items: []
        };
      }

      orderGroups[orderId].items.push({
        sku: sku,
        resolvedSku: resolved.odooSku,
        quantity: parseInt(cols[headerIndex['quantity-to-ship']]?.trim() || '1'),
        productName: cols[headerIndex['product-name']]?.trim() || sku
      });
    }

    return orderGroups;
  }

  /**
   * Resolve Amazon SKU to Odoo SKU
   */
  resolveSku(amazonSku) {
    if (!amazonSku) return { odooSku: null };

    const original = amazonSku.trim();
    const upper = original.toUpperCase();
    let sku = original;

    // Strip FBM suffixes
    if (upper.endsWith('-FBMA')) sku = original.slice(0, -5);
    else if (upper.endsWith('-FBM')) sku = original.slice(0, -4);

    // Strip other suffixes
    const suffixes = ['-stickerless', '-stickered', '-bundle', '-new', '-refurb'];
    for (const suffix of suffixes) {
      if (sku.toLowerCase().endsWith(suffix)) {
        sku = sku.slice(0, -suffix.length);
        break;
      }
    }

    // Strip trailing "A" for 5-digit SKUs
    if (/^[0-9]{5}A$/i.test(sku)) sku = sku.slice(0, -1);

    // Pad numeric SKUs to 5 digits
    if (/^[0-9]{1,4}$/.test(sku)) sku = sku.padStart(5, '0');

    return { odooSku: sku, originalSku: original };
  }

  /**
   * Find product by SKU in Odoo
   */
  async findProduct(resolvedSku, originalSku) {
    const cacheKey = `${resolvedSku}|${originalSku}`;
    if (this.productCache[cacheKey]) return this.productCache[cacheKey];

    // Try resolved SKU first
    let products = await this.odoo.searchRead('product.product',
      [['default_code', '=', resolvedSku]],
      ['id', 'name', 'default_code']
    );

    if (products.length > 0) {
      this.productCache[cacheKey] = products[0].id;
      return products[0].id;
    }

    // Try original SKU
    products = await this.odoo.searchRead('product.product',
      [['default_code', '=', originalSku]],
      ['id', 'name', 'default_code']
    );

    if (products.length > 0) {
      this.productCache[cacheKey] = products[0].id;
      return products[0].id;
    }

    // Try stripping K suffix (e.g., 9030K -> 9030)
    if (resolvedSku.endsWith('K')) {
      const strippedSku = resolvedSku.slice(0, -1);
      products = await this.odoo.searchRead('product.product',
        [['default_code', '=', strippedSku]],
        ['id', 'name', 'default_code']
      );
      if (products.length > 0) {
        this.productCache[cacheKey] = products[0].id;
        return products[0].id;
      }
    }

    return null;
  }

  /**
   * Find or create customer with actual details
   */
  async findOrCreateCustomer(order) {
    const customerName = order.recipientName;
    const countryCode = order.country;
    const cacheKey = `${customerName}|${order.postalCode}`;

    if (this.partnerCache[cacheKey]) return this.partnerCache[cacheKey];

    // Search by name and postal code
    const existing = await this.odoo.searchRead('res.partner',
      [['name', '=', customerName], ['zip', '=', order.postalCode]],
      ['id']
    );

    if (existing.length > 0) {
      this.partnerCache[cacheKey] = existing[0].id;
      return existing[0].id;
    }

    // Create new customer with actual details
    const countryId = this.countryCache[countryCode] || null;
    const street = order.address1 + (order.address2 ? ', ' + order.address2 : '');

    const partnerId = await this.odoo.create('res.partner', {
      name: customerName,
      company_type: order.isBusinessOrder ? 'company' : 'person',
      is_company: order.isBusinessOrder,
      customer_rank: 1,
      street: street,
      street2: order.address3 || false,
      city: order.city,
      zip: order.postalCode,
      country_id: countryId,
      comment: `Created from Amazon FBM order ${order.orderId}`
    });

    this.partnerCache[cacheKey] = partnerId;
    return partnerId;
  }

  /**
   * Check if valid (non-cancelled) order exists in Odoo
   */
  async findValidOrder(amazonOrderId) {
    const fbmName = 'FBM' + amazonOrderId;

    const orders = await this.odoo.searchRead('sale.order',
      [
        '|',
        ['name', '=', fbmName],
        ['client_order_ref', '=', amazonOrderId],
        ['state', '!=', 'cancel']
      ],
      ['id', 'name', 'state']
    );

    return orders.length > 0 ? orders[0] : null;
  }

  /**
   * Determine journal for FBM order based on destination country
   * FBM always ships from Belgium (BE)
   *
   * @param {string} destCountry - Destination country code
   * @returns {object} { journalId, journalCode, journalType }
   */
  determineJournal(destCountry) {
    // Non-EU destination = Export
    if (!EU_COUNTRIES.includes(destCountry)) {
      return {
        journalId: FBM_JOURNALS['EXPORT'].id,
        journalCode: FBM_JOURNALS['EXPORT'].code,
        journalType: 'export'
      };
    }

    // Domestic Belgium
    if (destCountry === 'BE') {
      return {
        journalId: FBM_JOURNALS['BE'].id,
        journalCode: FBM_JOURNALS['BE'].code,
        journalType: 'domestic'
      };
    }

    // EU cross-border = OSS
    return {
      journalId: FBM_JOURNALS['OSS'].id,
      journalCode: FBM_JOURNALS['OSS'].code,
      journalType: 'oss'
    };
  }

  /**
   * Create sale order in Odoo
   */
  async createOdooOrder(order, partnerId, orderLines) {
    const odooLines = orderLines.map(line => [0, 0, {
      product_id: line.product_id,
      product_uom_qty: line.quantity,
      name: line.name
    }]);

    // Determine journal based on destination country
    const journalInfo = this.determineJournal(order.country);

    const orderData = {
      partner_id: partnerId,
      partner_invoice_id: partnerId,
      partner_shipping_id: partnerId,
      client_order_ref: order.orderId,
      date_order: order.purchaseDate,
      warehouse_id: FBM_WAREHOUSE_ID,
      order_line: odooLines,
      payment_term_id: PAYMENT_TERM_21_DAYS,
      team_id: AMAZON_SELLER_TEAM_ID,
      journal_id: journalInfo.journalId
    };

    const orderId = await this.odoo.create('sale.order', orderData);

    // Get the created order name
    const created = await this.odoo.searchRead('sale.order', [['id', '=', orderId]], ['name']);
    const createdName = created.length > 0 ? created[0].name : `SO-${orderId}`;

    console.log(`[FbmOrderImporter] Created order ${createdName} with journal ${journalInfo.journalCode} (${journalInfo.journalType}: BE→${order.country})`);

    // Confirm order
    await this.odoo.execute('sale.order', 'action_confirm', [[orderId]]);

    return { id: orderId, name: createdName, journalCode: journalInfo.journalCode };
  }

  /**
   * Import orders from TSV content
   * @param {string} tsvContent - TSV file content
   * @param {Object} options - Import options
   * @returns {Object} Import results
   */
  async importFromTsv(tsvContent, options = {}) {
    await this.init();

    const results = {
      parsed: 0,
      created: 0,
      skipped: 0,
      errors: [],
      orders: []
    };

    try {
      const orderGroups = this.parseTsv(tsvContent);
      const orderIds = Object.keys(orderGroups);
      results.parsed = orderIds.length;

      console.log(`[FbmOrderImporter] Parsed ${orderIds.length} orders from TSV`);

      for (const orderId of orderIds) {
        const order = orderGroups[orderId];

        try {
          // Check if valid order already exists
          const existing = await this.findValidOrder(orderId);
          if (existing) {
            results.skipped++;
            results.orders.push({
              orderId,
              status: 'skipped',
              reason: `Exists as ${existing.name}`,
              odooName: existing.name
            });
            continue;
          }

          // Find/create customer
          const partnerId = await this.findOrCreateCustomer(order);

          // Resolve order lines
          const orderLines = [];
          let hasError = false;

          for (const item of order.items) {
            const productId = await this.findProduct(item.resolvedSku, item.sku);
            if (!productId) {
              results.errors.push({
                orderId,
                error: `Product not found: ${item.sku} -> ${item.resolvedSku}`
              });
              hasError = true;
              break;
            }
            orderLines.push({
              product_id: productId,
              quantity: item.quantity,
              name: item.productName || item.resolvedSku
            });
          }

          if (hasError) continue;

          // Create order
          const created = await this.createOdooOrder(order, partnerId, orderLines);
          results.created++;
          results.orders.push({
            orderId,
            status: 'created',
            odooId: created.id,
            odooName: created.name,
            customer: order.recipientName
          });

        } catch (error) {
          results.errors.push({
            orderId,
            error: error.message
          });
        }
      }

    } catch (error) {
      results.errors.push({ error: error.message });
    }

    return results;
  }
}

// Singleton instance
let fbmOrderImporterInstance = null;

async function getFbmOrderImporter() {
  if (!fbmOrderImporterInstance) {
    fbmOrderImporterInstance = new FbmOrderImporter();
    await fbmOrderImporterInstance.init();
  }
  return fbmOrderImporterInstance;
}

module.exports = {
  FbmOrderImporter,
  getFbmOrderImporter
};
