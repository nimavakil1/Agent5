/**
 * VCS Odoo Invoicer
 *
 * Creates customer invoices in Odoo from Amazon VCS Tax Report data.
 * Handles VAT, OSS, and B2B scenarios for EU sales.
 *
 * KEY PRINCIPLES:
 * 1. For OSS orders: Use dedicated Amazon OSS partners (e.g., "Amazon | AMZ_OSS_DE")
 *    which have the correct fiscal position already configured
 * 2. Set the correct tax on each invoice line (e.g., DE*OSS | 19.0%)
 * 3. Set fiscal position explicitly by ID
 * 4. Set payment_reference and ref to the VCS invoice number
 * 5. Include shipping from VCS data
 *
 * ORDER CREATION:
 * If no Odoo order exists, VCS import will CREATE the order from VCS data.
 * Orders can also be pre-created via FBM TSV import (with full address data).
 */

const { getDb } = require('../../db');
const { ObjectId } = require('mongodb');

// Retry configuration for MongoDB operations
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

/**
 * Retry wrapper with exponential backoff for MongoDB operations
 * @param {Function} operation - Async function to retry
 * @param {string} operationName - Name for logging
 * @param {object} config - Retry configuration
 * @returns {Promise<any>}
 */
async function withRetry(operation, operationName = 'operation', config = RETRY_CONFIG) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isRetryable = error.message?.includes('timeout') ||
                          error.message?.includes('MongoNetworkError') ||
                          error.message?.includes('MongoNetworkTimeoutError') ||
                          error.code === 'ETIMEDOUT' ||
                          error.code === 'ECONNRESET';

      if (!isRetryable || attempt === config.maxRetries) {
        console.error(`[VcsOdooInvoicer] ${operationName} failed after ${attempt} attempt(s):`, error.message);
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        config.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
        config.maxDelayMs
      );
      console.warn(`[VcsOdooInvoicer] ${operationName} failed (attempt ${attempt}/${config.maxRetries}), retrying in ${Math.round(delay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// SKU transformation patterns - used to match VCS SKU to Odoo order line
const SKU_TRANSFORMATIONS = [
  // Strip -FBM suffix (Fulfilled by Merchant)
  { pattern: /-FBM$/, replacement: '' },
  // Strip -stickerless suffix
  { pattern: /-stickerless$/, replacement: '' },
  // Strip -stickerles suffix (typo variant)
  { pattern: /-stickerles$/, replacement: '' },
];

// Return SKU pattern: amzn.gr.[base-sku]-[random-string]
// Example: amzn.gr.10050K-FBM-6sC9nyZuQGExqXIpf9-VG → 10050K-FBM → 10050K
const RETURN_SKU_PATTERN = /^amzn\.gr\.(.+?)-[A-Za-z0-9]{8,}/;

// VAT cut-off date - invoices cannot be created in closed VAT periods
// This is dynamically loaded from Odoo's tax_lock_date on res.company
// Falls back to env variable VAT_CUTOFF_DATE if not set in Odoo
let vatCutoffDate = process.env.VAT_CUTOFF_DATE || null;

/**
 * Get effective invoice date, respecting VAT period closure
 * - Uses the delivery/shipment date as invoice date
 * - If the date is in a closed period (before/on cut-off), uses first day after cut-off
 * @param {Date|string} originalDate - The shipment/return date from VCS
 * @returns {Date} The effective date to use for the invoice
 */
function getEffectiveInvoiceDate(originalDate) {
  if (!originalDate) return new Date();

  const date = new Date(originalDate);

  // If no cut-off date is set, use the original date
  if (!vatCutoffDate) {
    return date;
  }

  const cutoff = new Date(vatCutoffDate);

  // Set cutoff to end of day to include the cutoff date itself in the closed period
  cutoff.setHours(23, 59, 59, 999);

  if (date <= cutoff) {
    // Calculate first day after cut-off
    const firstOpenDay = new Date(vatCutoffDate);
    firstOpenDay.setDate(firstOpenDay.getDate() + 1);
    firstOpenDay.setHours(0, 0, 0, 0);

    console.log(`[VcsOdooInvoicer] Date ${date.toISOString().split('T')[0]} is before VAT cut-off ${vatCutoffDate}, using first open day: ${firstOpenDay.toISOString().split('T')[0]}`);
    return firstOpenDay;
  }

  return date;
}

// Marketplace to Sales Team ID mapping (Odoo crm.team IDs)
// Based on marketplaceId - the Amazon marketplace where the order was placed
const MARKETPLACE_SALES_TEAMS = {
  'DE': 17,  // Amazon DE (Marketplace)
  'FR': 19,  // Amazon FR (Marketplace)
  'IT': 20,  // Amazon IT (Marketplace)
  'ES': 18,  // Amazon ES (Marketplace)
  'NL': 21,  // Amazon NL (Marketplace)
  'PL': 22,  // Amazon PL (Marketplace)
  'BE': 16,  // Amazon BE (Marketplace)
  'SE': 24,  // Amazon SE (Marketplace)
  'GB': 25,  // Amazon UK (Marketplace)
  'UK': 25,  // Alias for GB
};

// Marketplace to journal mapping (Odoo journal codes)
// Based on shipToCountry - the destination determines the VAT jurisdiction
const MARKETPLACE_JOURNALS = {
  'DE': 'VDE',   // INV*DE/ Invoices
  'FR': 'VFR',   // INV*FR/ Invoices
  'IT': 'VIT',   // INV*IT/ Invoices
  'NL': 'VNL',   // INV*NL/ Invoices
  'BE': 'VBE',   // INV*BE/ Invoices
  'PL': 'VPL',   // INV*PL/ Invoices
  'CZ': 'VCZ',   // INV*CZ/ Invoices
  'GB': 'VGB',   // INV*GB/ Invoices (for UK domestic FBA sales)
  'OSS': 'VOS',  // INV*OSS/ Invoices (for EU cross-border OSS)
  'EXPORT': 'VEX', // INV*EX/ Export Invoices (for non-EU exports: CH, UK cross-border, etc.)
  // Default fallback
  'DEFAULT': 'VBE',
};

// EU member countries (for determining if destination is EU or export)
const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

// Export fiscal position ID (BE*VAT | Régime Extra-Communautaire)
const EXPORT_FISCAL_POSITION_ID = 3;

// OSS Fiscal Position IDs by country (from Odoo query)
const OSS_FISCAL_POSITIONS = {
  'AT': 6,   // AT*OSS | B2C Austria
  'BG': 7,   // BG*OSS | B2C Bulgaria
  'HR': 8,   // HR*OSS | B2C Croatia
  'CY': 9,   // CY*OSS | B2C Cyprus
  'CZ': 10,  // CZ*OSS | B2C Czech Republic
  'DK': 11,  // DK*OSS | B2C Denmark
  'EE': 12,  // EE*OSS | B2C Estonia
  'FI': 13,  // FI*OSS | B2C Finland
  'FR': 14,  // FR*OSS | B2C France
  'DE': 15,  // DE*OSS | B2C Germany
  'GR': 16,  // GR*OSS | B2C Greece
  'HU': 17,  // HU*OSS | B2C Hungary
  'IE': 18,  // IE*OSS | B2C Ireland
  'IT': 19,  // IT*OSS | B2C Italy
  'LV': 20,  // LV*OSS | B2C Latvia
  'LT': 21,  // LT*OSS | B2C Lithuania
  'LU': 22,  // LU*OSS | B2C Luxembourg
  'MT': 23,  // MT*OSS | B2C Malta
  'NL': 24,  // NL*OSS | B2C Netherlands
  'PL': 25,  // PL*OSS | B2C Poland
  'PT': 26,  // PT*OSS | B2C Portugal
  'RO': 27,  // RO*OSS | B2C Romania
  'SK': 28,  // SK*OSS | B2C Slovakia
  'SI': 29,  // SI*OSS | B2C Slovenia
  'ES': 30,  // ES*OSS | B2C Spain
  'SE': 31,  // SE*OSS | B2C Sweden
  'BE': 35,  // BE*OSS | B2C Belgium
};

// OSS Amazon Partner IDs by country (from Odoo query)
const _OSS_PARTNERS = {
  'AT': 18,    // Amazon | AMZ_OSS_AT (Austria)
  'BE': 3192,  // Amazon | AMZ_OSS_BE (Belgium)
  'BG': 3169,  // Amazon | AMZ_OSS_BG (Bulgaria)
  'CY': 21,    // Amazon | AMZ_OSS_CY (Cyprus)
  'CZ': 3152,  // Amazon | AMZ_OSS_CZ (Czech Rep.)
  'DE': 3157,  // Amazon | AMZ_OSS_DE (Germany)
  'DK': 3153,  // Amazon | AMZ_OSS_DK (Denmark)
  'EE': 3160,  // Amazon | AMZ_OSS_EE (Estonia)
  'ES': 3165,  // Amazon | AMZ_OSS_ES (Spain)
  'FI': 3155,  // Amazon | AMZ_OSS_FI (Finland)
  'FR': 3156,  // Amazon | AMZ_OSS_FR (France)
  'GR': 3170,  // Amazon | AMZ_OSS_GR (Greece)
  'HR': 3162,  // Amazon | AMZ_OSS_HR (Croatia)
  'HU': 3178,  // Amazon | AMZ_OSS_HU (Hungary)
  'IE': 3171,  // Amazon | AMZ_OSS_IE (Ireland)
  'IT': 3164,  // Amazon | AMZ_OSS_IT (Italy)
  'LT': 3168,  // Amazon | AMZ_OSS_LT (Lithuania)
  'LU': 3163,  // Amazon | AMZ_OSS_LU (Luxembourg)
  'LV': 3166,  // Amazon | AMZ_OSS_LV (Latvia)
  'MT': 3172,  // Amazon | AMZ_OSS_MT (Malta)
  'NL': 3173,  // Amazon | AMZ_OSS_NL (The Netherlands)
  'PL': 3174,  // Amazon | AMZ_OSS_PL (Poland)
  'PT': 3167,  // Amazon | AMZ_OSS_PT (Portugal)
  'RO': 3161,  // Amazon | AMZ_OSS_RO (Romania)
  'SE': 3177,  // Amazon | AMZ_OSS_SE (Sweden)
  'SI': 3176,  // Amazon | AMZ_OSS_SI (Slovenia)
  'SK': 3175,  // Amazon | AMZ_OSS_SK (Slovakia)
};

// OSS Tax IDs by country and standard rate (from Odoo query)
// Format: { country: { rate: taxId } }
const OSS_TAXES = {
  'AT': { 20: 72, 10: 73 },      // AT*OSS | 20.0%, 10.0%
  'BE': { 21: 138, 6: 142 },     // BE*OSS | 21.0%, 6.0%
  'BG': { 20: 74 },              // BG*OSS | 20.0%
  'HR': { 25: 75, 5: 76 },       // HR*OSS | 25.0%, 5.0%
  'CY': { 19: 77, 5: 78 },       // CY*OSS | 19.0%, 5.0%
  'CZ': { 21: 79, 15: 80 },      // CZ*OSS | 21.0%, 15.0%
  'DK': { 25: 81 },              // DK*OSS | 25.0%
  'EE': { 20: 82, 9: 83 },       // EE*OSS | 20.0%, 9.0%
  'FI': { 24: 84, 10: 85 },      // FI*OSS | 24.0%, 10.0%
  'FR': { 20: 141, 5.5: 87 },    // FR*OSS | 20.0%, 5.5%
  'DE': { 19: 140, 7: 89 },      // DE*OSS | 19.0%, 7.0%
  'GR': { 24: 90, 13: 91 },      // GR*OSS | 24.0%, 13.0%
  'HU': { 27: 92, 5: 93 },       // HU*OSS | 27.0%, 5.0%
  'IE': { 23: 94, 13.5: 95 },    // IE*OSS | 23.0%, 13.5%
  'IT': { 22: 96, 4: 97 },       // IT*OSS | 22.0%, 4.0%
  'LV': { 21: 98, 12: 99 },      // LV*OSS | 21.0%, 12.0%
  'LT': { 21: 100, 5: 101 },     // LT*OSS | 21.0%, 5.0%
  'LU': { 17: 102, 7: 103 },     // LU*OSS | 17.0%, 7.0%
  'MT': { 18: 104, 5: 105 },     // MT*OSS | 18.0%, 5.0%
  'NL': { 21: 106, 9: 107 },     // NL*OSS | 21.0%, 9.0%
  'PL': { 23: 108, 8: 109 },     // PL*OSS | 23.0%, 8.0%
  'PT': { 23: 110, 6: 111 },     // PT*OSS | 23.0%, 6.0%
  'RO': { 19: 112, 5: 113 },     // RO*OSS | 19.0%, 5.0%
  'SK': { 20: 114, 10: 115 },    // SK*OSS | 20.0%, 10.0%
  'SI': { 22: 116, 9.5: 117 },   // SI*OSS | 22.0%, 9.5%
  'ES': { 21: 118, 10: 119 },    // ES*OSS | 21.0%, 10.0%
  'SE': { 25: 120, 6: 121 },     // SE*OSS | 25.0%, 6.0%
};

// Standard VAT rates by country (for looking up taxes)
const STANDARD_VAT_RATES = {
  'AT': 20, 'BE': 21, 'BG': 20, 'HR': 25, 'CY': 19, 'CZ': 21,
  'DK': 25, 'EE': 20, 'FI': 24, 'FR': 20, 'DE': 19, 'GR': 24,
  'HU': 27, 'IE': 23, 'IT': 22, 'LV': 21, 'LT': 21, 'LU': 17,
  'MT': 18, 'NL': 21, 'PL': 23, 'PT': 23, 'RO': 19, 'SK': 20,
  'SI': 22, 'ES': 21, 'SE': 25,
};

// Domestic VAT Tax IDs by country (for local/domestic sales within a country)
// Format: { country: { rate: taxId } }
const DOMESTIC_TAXES = {
  'BE': { 21: 1, 12: 4, 6: 6, 0: 8 },           // BE*VAT | 21%, 12%, 6%, 0%
  'DE': { 19: 135, 7: 134, 0: 163 },            // DE*VAT | 19%, 7%, 0% EU
  'FR': { 20: 122, 5.5: 123, 0: 144 },          // FR*VAT | 20%, 5.5%, 0% EU
  'NL': { 21: 136, 9: 137 },                    // NL*VAT | 21%, 9%
  'IT': { 22: 180 },                            // IT*VAT | 22%
  'CZ': { 21: 187, 15: 189, 10: 191, 0: 193 },  // CZ*VAT | 21%, 15%, 10%, 0%
  'PL': { 23: 194, 8: 196, 5: 198, 0: 200 },    // PL*VAT | 23%, 8%, 5%, 0%
  'GB': { 20: 182, 5: 184, 0: 186 },            // GB*VAT | 20%, 5%, 0%
};

// Domestic Fiscal Position IDs by country (for same-country sales)
// Format: { country: fiscalPositionId }
const DOMESTIC_FISCAL_POSITIONS = {
  'BE': 1,   // BE*VAT | Régime National
  'DE': 32,  // DE*VAT | Régime National
  'FR': 33,  // FR*VAT | Régime National
  'NL': 34,  // NL*VAT | Régime National
  'IT': 61,  // IT*VAT | Régime National
  'PL': 65,  // PL*VAT | Régime National
  'CZ': 63,  // CZ*VAT | Régime National
  'GB': 67,  // GB*VAT | Régime National
};

// Marketplace-specific receivable account IDs
// These are used for B2C Amazon marketplace sales, where Amazon collects payment
// Format: { marketplaceCountry: accountId }
const MARKETPLACE_RECEIVABLE_ACCOUNTS = {
  'DE': 820,  // 400102DE Trade debtors - Amazon Seller Germany
  'FR': 821,  // 400102FR Trade debtors - Amazon Seller France
  'NL': 822,  // 400102NL Trade debtors - Amazon Seller Netherlands
  'ES': 823,  // 400102ES Trade debtors - Amazon Seller Spain
  'IT': 824,  // 400102IT Trade debtors - Amazon Seller Italy
  'SE': 825,  // 400102SE Trade debtors - Amazon Seller Sweden
  'PL': 826,  // 400102PL Trade debtors - Amazon Seller Poland
  'GB': 827,  // 400102UK Trade debtors - Amazon Seller United Kingdom
  'UK': 827,  // Alias for GB
  'BE': 828,  // 400102BE Trade debtors - Amazon Seller Belgium
  'TR': 829,  // 400102TR Trade debtors - Amazon Seller Turkey
};

// Default Amazon Customer partner ID (for B2C sales)
const _AMAZON_CUSTOMER_PARTNER_ID = 232128;

// Country to fiscal position mapping (legacy, kept for reference)
const FISCAL_POSITIONS = {
  // OSS (selling to EU consumers from Belgium)
  'OSS_DE': 'OSS Germany',
  'OSS_FR': 'OSS France',
  'OSS_IT': 'OSS Italy',
  'OSS_ES': 'OSS Spain',
  'OSS_NL': 'OSS Netherlands',
  'OSS_AT': 'OSS Austria',
  'OSS_PL': 'OSS Poland',
  'OSS_SE': 'OSS Sweden',
  'OSS_LU': 'OSS Luxembourg',
  'OSS_CZ': 'OSS Czech Republic',
  // B2B (reverse charge)
  'B2B_EU': 'Intra-Community B2B',
  // Export
  'EXPORT': 'Export Outside EU',
  // Domestic
  'DOMESTIC_BE': 'Belgium Domestic',
};

class VcsOdooInvoicer {
  constructor(odooClient, options = {}) {
    this.odoo = odooClient;
    this.options = options;
    this.defaultJournalId = options.defaultJournalId;
    this.amazonPartnerId = options.amazonPartnerId; // Partner for "Amazon Customer"
    // Cache for batch-prefetched orders: amazonOrderId -> { saleOrder, orderLines }
    this.orderCache = new Map();
    // Cache for product SKUs: productId -> default_code
    this.productSkuCache = new Map();
  }

  /**
   * Batch prefetch all Odoo orders for the given VCS orders
   * This dramatically improves performance by reducing thousands of API calls to just a few
   * @param {object[]} vcsOrders - Array of VCS orders to prefetch
   */
  async prefetchOrders(vcsOrders) {
    // Extract unique Amazon order IDs
    const amazonOrderIds = [...new Set(vcsOrders.map(o => o.orderId))];

    if (amazonOrderIds.length === 0) {
      return;
    }

    console.log(`[VcsOdooInvoicer] Prefetching ${amazonOrderIds.length} orders from Odoo...`);
    const startTime = Date.now();

    // Generate all possible variations of order IDs (raw, FBA, FBM)
    // VCS provides raw IDs like "205-1829787-5409110" but Odoo stores them as "FBA205-1829787-5409110"
    const allSearchIds = [];
    for (const orderId of amazonOrderIds) {
      // Add raw ID
      allSearchIds.push(orderId);
      // Add with FBA prefix if not already present
      if (!orderId.startsWith('FBA')) {
        allSearchIds.push('FBA' + orderId);
      }
      // Add with FBM prefix if not already present
      if (!orderId.startsWith('FBM')) {
        allSearchIds.push('FBM' + orderId);
      }
    }

    // Fetch all orders in batches (Odoo can handle large 'in' queries, but let's batch for safety)
    // Search by BOTH client_order_ref AND name to catch all variations
    const BATCH_SIZE = 500;
    const allOrders = [];

    for (let i = 0; i < allSearchIds.length; i += BATCH_SIZE) {
      const batchIds = allSearchIds.slice(i, i + BATCH_SIZE);
      console.log(`[VcsOdooInvoicer] Fetching batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allSearchIds.length / BATCH_SIZE)}...`);

      // Search by client_order_ref OR name to catch all orders regardless of how they were created
      const orders = await this.odoo.searchRead('sale.order',
        [
          '|',
          ['client_order_ref', 'in', batchIds],
          ['name', 'in', batchIds]
        ],
        ['id', 'name', 'client_order_ref', 'order_line', 'partner_id', 'state', 'team_id']
      );
      allOrders.push(...orders);
    }

    console.log(`[VcsOdooInvoicer] Found ${allOrders.length} Odoo orders`);

    // Collect all order line IDs
    const allOrderLineIds = [];
    for (const order of allOrders) {
      if (order.order_line && order.order_line.length > 0) {
        allOrderLineIds.push(...order.order_line);
      }
    }

    // Fetch all order lines in batches
    console.log(`[VcsOdooInvoicer] Fetching ${allOrderLineIds.length} order lines...`);
    const allOrderLines = [];
    for (let i = 0; i < allOrderLineIds.length; i += BATCH_SIZE) {
      const batchIds = allOrderLineIds.slice(i, i + BATCH_SIZE);
      const lines = await this.odoo.searchRead('sale.order.line',
        [['id', 'in', batchIds]],
        ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'price_total', 'order_id']
      );
      allOrderLines.push(...lines);
    }

    // Collect all product IDs for SKU lookup
    const productIds = [...new Set(allOrderLines.filter(l => l.product_id).map(l => l.product_id[0]))];

    // Fetch all products in batches
    console.log(`[VcsOdooInvoicer] Fetching ${productIds.length} product SKUs...`);
    for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
      const batchIds = productIds.slice(i, i + BATCH_SIZE);
      const products = await this.odoo.searchRead('product.product',
        [['id', 'in', batchIds]],
        ['id', 'default_code', 'name']
      );
      for (const p of products) {
        this.productSkuCache.set(p.id, p.default_code || '');
      }
    }

    // Create order line lookup by order ID
    const orderLinesByOrderId = {};
    for (const line of allOrderLines) {
      const orderId = line.order_id[0];
      if (!orderLinesByOrderId[orderId]) {
        orderLinesByOrderId[orderId] = [];
      }
      // Add product SKU from cache
      if (line.product_id) {
        line.product_default_code = this.productSkuCache.get(line.product_id[0]) || '';
        line.product_name = line.name;
      }
      orderLinesByOrderId[orderId].push(line);
    }

    // Build the order cache - map Amazon order ID to Odoo order data
    // Handle multiple orders for same Amazon ID (FBA/FBM split)
    // Store by BOTH the Odoo format (FBA...) AND the raw VCS format for easy lookup
    const ordersByAmazonId = {};
    for (const order of allOrders) {
      const amazonId = order.client_order_ref;
      // Extract the raw order ID without FBA/FBM prefix
      const rawOrderId = amazonId.replace(/^(FBA|FBM)/, '');

      // Add to grouping by Odoo format
      if (!ordersByAmazonId[amazonId]) {
        ordersByAmazonId[amazonId] = [];
      }
      ordersByAmazonId[amazonId].push({
        saleOrder: order,
        orderLines: orderLinesByOrderId[order.id] || []
      });

      // Also add to grouping by raw VCS format (for lookup from VCS orders)
      if (rawOrderId !== amazonId) {
        if (!ordersByAmazonId[rawOrderId]) {
          ordersByAmazonId[rawOrderId] = [];
        }
        ordersByAmazonId[rawOrderId].push({
          saleOrder: order,
          orderLines: orderLinesByOrderId[order.id] || []
        });
      }
    }

    // Store in cache
    for (const [amazonId, orderDataList] of Object.entries(ordersByAmazonId)) {
      this.orderCache.set(amazonId, orderDataList);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[VcsOdooInvoicer] Prefetch complete in ${elapsed}s. Cached ${this.orderCache.size} unique Amazon order IDs`);
  }

  /**
   * Create invoices in Odoo for selected VCS orders
   * @param {object} options
   * @param {string[]} options.orderIds - MongoDB IDs of orders to process
   * @param {boolean} options.dryRun - If true, don't create invoices
   * @returns {object} Results
   */
  async createInvoices(options = {}) {
    const { orderIds = [], dryRun = false } = options;
    const db = getDb();

    const result = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [],
      invoices: [],
      skippedOrders: [],  // Track skipped orders with reasons
    };

    if (orderIds.length === 0) {
      return { ...result, message: 'No orders selected' };
    }

    // Get selected orders by their MongoDB IDs
    const orders = await db.collection('amazon_vcs_orders')
      .find({ _id: { $in: orderIds.map(id => new ObjectId(id)) } })
      .toArray();

    if (orders.length === 0) {
      return { ...result, message: 'No orders found for the given IDs' };
    }

    // PERFORMANCE OPTIMIZATION: Prefetch all Odoo orders in batch
    // This reduces thousands of individual API calls to just a few batch calls
    console.log(`[VcsOdooInvoicer] Processing ${orders.length} VCS orders...`);
    await this.prefetchOrders(orders);

    // Get or create Amazon customer partner
    const _partnerId = await this.getOrCreateAmazonPartner();

    for (const order of orders) {
      result.processed++;

      try {
        // Skip orders that shouldn't be invoiced
        if (this.shouldSkipOrder(order)) {
          result.skipped++;
          result.skippedOrders.push({
            orderId: order.orderId,
            reason: 'Not invoiceable (cancelled or return)',
            customerName: order.buyerName || null,
          });
          await this.markOrderSkipped(order._id, 'Not invoiceable');
          continue;
        }

        // Find existing Odoo order or create one from VCS data
        let odooOrderData = await this.findOdooOrder(order);
        if (!odooOrderData) {
          // No existing order - create one from VCS data
          console.log(`[VcsOdooInvoicer] No Odoo order found for ${order.orderId}, creating from VCS data...`);
          try {
            odooOrderData = await this.createOrderFromVcs(order);
            console.log(`[VcsOdooInvoicer] Created order ${odooOrderData.saleOrder.name} for ${order.orderId}`);
          } catch (createError) {
            result.skipped++;
            await this.markOrderSkipped(order._id, `Failed to create order: ${createError.message}`);
            result.errors.push({
              orderId: order.orderId,
              error: `Failed to create order: ${createError.message}`,
            });
            continue;
          }
        }

        const { saleOrder, orderLines } = odooOrderData;

        // Check if invoice already exists in Odoo for this sale order
        const existingInvoice = await this.findExistingInvoice(saleOrder.name);
        if (existingInvoice) {
          result.skipped++;
          result.skippedOrders.push({
            orderId: order.orderId,
            reason: `Invoice already exists: ${existingInvoice.name}`,
            customerName: order.buyerName || null,
            odooOrderName: saleOrder.name,
          });
          await this.markOrderSkipped(order._id, `Invoice already exists: ${existingInvoice.name}`);
          console.log(`[VcsOdooInvoicer] Invoice already exists for ${order.orderId}: ${existingInvoice.name}`);
          continue;
        }

        if (dryRun) {
          const partnerId = await this.determinePartner(order, saleOrder);
          const invoiceData = this.buildInvoiceData(order, partnerId, saleOrder, orderLines);

          // Get human-readable names, with fallbacks showing expected values
          const journalName = this.getJournalName(invoiceData.journal_id);
          const fiscalPositionName = this.getFiscalPositionName(invoiceData.fiscal_position_id);
          const expectedJournal = this.getExpectedJournalCode(order);
          const expectedFiscalPosition = this.getExpectedFiscalPositionKey(order);

          result.invoices.push({
            orderId: order.orderId,
            dryRun: true,
            odooOrderName: saleOrder.name,
            odooOrderId: saleOrder.id,
            // Human-readable preview fields
            preview: {
              invoiceDate: invoiceData.invoice_date,
              journalName: journalName || `Not found (expected: ${expectedJournal})`,
              fiscalPositionName: fiscalPositionName || (expectedFiscalPosition ? `Not found (expected: ${expectedFiscalPosition})` : 'Default'),
              currency: order.currency || 'EUR',
              shipFrom: order.shipFromCountry || 'BE',
              shipTo: order.shipToCountry,
              taxScheme: order.taxReportingScheme || 'Standard',
              buyerVatId: order.buyerTaxRegistration || null,
              vatAmount: order.totalTax || 0,
              totalExclVat: order.totalExclusive || 0,
              totalInclVat: order.totalInclusive || 0,
              vatInvoiceNumber: order.vatInvoiceNumber,
            },
            wouldCreate: invoiceData,
          });
          continue;
        }

        // Create invoice linked to sale order
        const partnerId = await this.determinePartner(order, saleOrder);
        const invoice = await this.createInvoice(order, partnerId, saleOrder, orderLines);
        result.created++;
        result.invoices.push(invoice);

        // Mark order as invoiced
        await db.collection('amazon_vcs_orders').updateOne(
          { _id: order._id },
          {
            $set: {
              status: 'invoiced',
              odooInvoiceId: invoice.id,
              odooInvoiceName: invoice.name,
              odooSaleOrderId: saleOrder.id,
              odooSaleOrderName: saleOrder.name,
              invoicedAt: new Date(),
            }
          }
        );

        // Rate limiting: add delay between invoice creations to prevent Odoo overload
        await new Promise(resolve => setTimeout(resolve, 150));

      } catch (error) {
        result.errors.push({
          orderId: order.orderId,
          error: error.message,
        });
        console.error(`[VcsOdooInvoicer] Error processing ${order.orderId}:`, error);
      }
    }

    return result;
  }

  /**
   * Create invoices with progress callback for streaming
   * @param {object} options - { orderIds, dryRun }
   * @param {function} onProgress - Callback function for progress updates
   * @returns {object} Results
   */
  async createInvoicesWithProgress(options = {}, onProgress = () => {}) {
    const { orderIds = [], dryRun = false } = options;
    const db = getDb();

    const result = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [],
      invoices: [],
      skippedOrders: [],  // Track skipped orders with reasons
    };

    if (orderIds.length === 0) {
      return { ...result, message: 'No orders selected' };
    }

    // Get selected orders by their MongoDB IDs with retry logic
    const orders = await withRetry(
      () => db.collection('amazon_vcs_orders')
        .find({ _id: { $in: orderIds.map(id => new ObjectId(id)) } })
        .toArray(),
      'Fetching VCS orders from MongoDB'
    );

    if (orders.length === 0) {
      return { ...result, message: 'No orders found for the given IDs' };
    }

    const total = orders.length;
    onProgress({ phase: 'prefetch', message: `Prefetching ${total} orders...`, current: 0, total });

    // PERFORMANCE OPTIMIZATION: Prefetch all Odoo orders in batch
    await this.prefetchOrders(orders);
    onProgress({ phase: 'prefetch', message: 'Prefetch complete', current: total, total });

    // Get or create Amazon customer partner
    const _partnerId = await this.getOrCreateAmazonPartner();

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      result.processed++;

      // Send progress update
      onProgress({
        phase: 'processing',
        current: i + 1,
        total,
        orderId: order.orderId,
        created: result.created,
        skipped: result.skipped,
        errors: result.errors.length,
      });

      try {
        // Skip orders that shouldn't be invoiced
        if (this.shouldSkipOrder(order)) {
          result.skipped++;
          result.skippedOrders.push({
            orderId: order.orderId,
            reason: 'Not invoiceable (cancelled or return)',
            customerName: order.buyerName || null,
          });
          await this.markOrderSkipped(order._id, 'Not invoiceable');
          continue;
        }

        // Find existing Odoo order or create one from VCS data
        let odooOrderData = await this.findOdooOrder(order);
        if (!odooOrderData) {
          // No existing order - create one from VCS data
          console.log(`[VcsOdooInvoicer] No Odoo order found for ${order.orderId}, creating from VCS data...`);
          try {
            odooOrderData = await this.createOrderFromVcs(order);
            console.log(`[VcsOdooInvoicer] Created order ${odooOrderData.saleOrder.name} for ${order.orderId}`);
          } catch (createError) {
            result.skipped++;
            await this.markOrderSkipped(order._id, `Failed to create order: ${createError.message}`);
            result.errors.push({
              orderId: order.orderId,
              error: `Failed to create order: ${createError.message}`,
            });
            continue;
          }
        }

        const { saleOrder, orderLines } = odooOrderData;

        // Check if invoice already exists in Odoo for this sale order
        const existingInvoice = await this.findExistingInvoice(saleOrder.name);
        if (existingInvoice) {
          result.skipped++;
          result.skippedOrders.push({
            orderId: order.orderId,
            reason: `Invoice already exists: ${existingInvoice.name}`,
            customerName: order.buyerName || null,
            odooOrderName: saleOrder.name,
          });
          await this.markOrderSkipped(order._id, `Invoice already exists: ${existingInvoice.name}`);
          continue;
        }

        if (dryRun) {
          const partnerId = await this.determinePartner(order, saleOrder);
          const invoiceData = this.buildInvoiceData(order, partnerId, saleOrder, orderLines);
          const journalName = this.getJournalName(invoiceData.journal_id);
          const fiscalPositionName = this.getFiscalPositionName(invoiceData.fiscal_position_id);
          const expectedJournal = this.getExpectedJournalCode(order);
          const expectedFiscalPosition = this.getExpectedFiscalPositionKey(order);

          result.invoices.push({
            orderId: order.orderId,
            dryRun: true,
            odooOrderName: saleOrder.name,
            odooOrderId: saleOrder.id,
            preview: {
              invoiceDate: invoiceData.invoice_date,
              journalName: journalName || `Not found (expected: ${expectedJournal})`,
              fiscalPositionName: fiscalPositionName || (expectedFiscalPosition ? `Not found (expected: ${expectedFiscalPosition})` : 'Default'),
              currency: order.currency || 'EUR',
              shipFrom: order.shipFromCountry || 'BE',
              shipTo: order.shipToCountry,
              taxScheme: order.taxReportingScheme || 'Standard',
              buyerVatId: order.buyerTaxRegistration || null,
              vatAmount: order.totalTax || 0,
              totalExclVat: order.totalExclusive || 0,
              totalInclVat: order.totalInclusive || 0,
              vatInvoiceNumber: order.vatInvoiceNumber,
            },
            wouldCreate: invoiceData,
          });
          result.created++;
          continue;
        }

        // Create invoice linked to sale order
        const partnerId = await this.determinePartner(order, saleOrder);
        const invoice = await this.createInvoice(order, partnerId, saleOrder, orderLines);
        result.created++;
        result.invoices.push(invoice);

        // Mark order as invoiced (with retry logic)
        await withRetry(
          () => db.collection('amazon_vcs_orders').updateOne(
            { _id: order._id },
            {
              $set: {
                status: 'invoiced',
                odooInvoiceId: invoice.id,
                odooInvoiceName: invoice.name,
                odooSaleOrderId: saleOrder.id,
                odooSaleOrderName: saleOrder.name,
                invoicedAt: new Date(),
              }
            }
          ),
          `markOrderInvoiced(${order.orderId})`
        );

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 150));

      } catch (error) {
        result.errors.push({
          orderId: order.orderId,
          error: error.message,
        });
        console.error(`[VcsOdooInvoicer] Error processing ${order.orderId}:`, error);
      }
    }

    return result;
  }

  /**
   * Check if order should be skipped
   * @param {object} order
   * @returns {boolean}
   */
  shouldSkipOrder(order) {
    // NOTE: DEEMED_RESELLER and CH_VOEC orders are NOT skipped!
    // Even though Amazon handles VAT for these, we still need to record the revenue.
    // They will be processed with 0% VAT (Amazon handles VAT collection).

    // Skip if no items
    if (!order.items || order.items.length === 0) {
      return true;
    }

    // Skip if total is 0
    if (order.totalExclusive === 0 && order.totalInclusive === 0) {
      return true;
    }

    return false;
  }

  /**
   * Transform Amazon SKU to base Odoo SKU
   * @param {string} amazonSku - The SKU from Amazon VCS
   * @returns {string} The transformed SKU
   */
  transformSku(amazonSku) {
    let sku = amazonSku;

    // First, check for return SKU pattern: amzn.gr.[base-sku]-[random-string]
    // Example: amzn.gr.10050K-FBM-6sC9nyZuQGExqXIpf9-VG → 10050K-FBM
    const returnMatch = sku.match(RETURN_SKU_PATTERN);
    if (returnMatch) {
      sku = returnMatch[1]; // Extract base SKU from return pattern
    }

    // Then apply regular transformations (-FBM, -stickerless, etc.)
    for (const transform of SKU_TRANSFORMATIONS) {
      sku = sku.replace(transform.pattern, transform.replacement);
    }
    return sku;
  }

  /**
   * Find the Odoo sales order for a VCS order
   * Uses cached data from prefetchOrders() if available, otherwise falls back to API call
   * @param {object} vcsOrder - The VCS order data
   * @returns {object|null} { saleOrder, orderLines } or null if not found
   */
  async findOdooOrder(vcsOrder) {
    const amazonOrderId = vcsOrder.orderId;

    // Check cache first (populated by prefetchOrders)
    const cachedOrderDataList = this.orderCache.get(amazonOrderId);
    if (cachedOrderDataList && cachedOrderDataList.length > 0) {
      // If only one order cached, use it
      if (cachedOrderDataList.length === 1) {
        return cachedOrderDataList[0];
      }

      // Multiple orders cached (FBA/FBM split) - match by SKU
      const vcsSku = vcsOrder.items?.[0]?.sku;
      if (!vcsSku) {
        return cachedOrderDataList[0]; // No SKU, use first
      }

      const transformedSku = this.transformSku(vcsSku);
      for (const orderData of cachedOrderDataList) {
        for (const line of orderData.orderLines) {
          const productSku = line.product_default_code || '';
          if (productSku === transformedSku || productSku === vcsSku) {
            return orderData;
          }
        }
      }

      // No exact match, use first
      return cachedOrderDataList[0];
    }

    // Cache miss - fall back to individual API call (for orders not in the batch)
    console.log(`[VcsOdooInvoicer] Cache miss for ${amazonOrderId}, fetching from Odoo...`);

    // Search for sale.order by client_order_ref OR by FBA/FBM name pattern
    // This catches orders created by different import sources
    const orders = await this.odoo.searchRead('sale.order',
      [
        '|',
        ['client_order_ref', '=', amazonOrderId],
        '|',
        ['name', '=', `FBA${amazonOrderId}`],
        ['name', '=', `FBM${amazonOrderId}`]
      ],
      ['id', 'name', 'client_order_ref', 'order_line', 'partner_id', 'state', 'team_id']
    );

    if (orders.length === 0) {
      return null;
    }

    // If only one order found, use it
    if (orders.length === 1) {
      const order = orders[0];
      const orderLines = await this.getOrderLines(order.order_line);
      return { saleOrder: order, orderLines };
    }

    // Multiple orders found (FBA/FBM split) - need to match by SKU
    const vcsSku = vcsOrder.items?.[0]?.sku;
    if (!vcsSku) {
      // No SKU in VCS, just use first order
      const order = orders[0];
      const orderLines = await this.getOrderLines(order.order_line);
      return { saleOrder: order, orderLines };
    }

    const transformedSku = this.transformSku(vcsSku);

    // Check each order's lines for matching SKU
    for (const order of orders) {
      const orderLines = await this.getOrderLines(order.order_line);

      for (const line of orderLines) {
        const productSku = line.product_default_code || '';
        if (productSku === transformedSku || productSku === vcsSku) {
          return { saleOrder: order, orderLines };
        }
      }
    }

    // No exact match, but we have orders - use the first one and log warning
    console.warn(`[VcsOdooInvoicer] Multiple orders found for ${amazonOrderId}, using first match`);
    const order = orders[0];
    const orderLines = await this.getOrderLines(order.order_line);
    return { saleOrder: order, orderLines };
  }

  /**
   * Create a sale order in Odoo from VCS data
   * Used when no existing order is found during invoice import
   *
   * @param {object} vcsOrder - VCS order data
   * @returns {object} { saleOrder, orderLines }
   */
  async createOrderFromVcs(vcsOrder) {
    const amazonOrderId = vcsOrder.orderId;

    // DUPLICATE PREVENTION: Check again right before creating
    // This prevents race conditions where another process may have created the order
    const existingOrders = await this.odoo.searchRead('sale.order',
      [
        '|',
        ['client_order_ref', '=', amazonOrderId],
        '|',
        ['name', '=', `FBA${amazonOrderId}`],
        ['name', '=', `FBM${amazonOrderId}`]
      ],
      ['id', 'name', 'client_order_ref', 'order_line', 'partner_id', 'state', 'team_id']
    );

    if (existingOrders.length > 0) {
      console.log(`[VcsOdooInvoicer] Order already exists (duplicate prevention): ${existingOrders[0].name}`);
      const order = existingOrders[0];
      const orderLines = await this.getOrderLines(order.order_line);
      return { saleOrder: order, orderLines };
    }

    // Determine if FBA or FBM based on ship-from country
    // FBM ships from BE (our warehouse), FBA ships from Amazon warehouses (DE, FR, etc.)
    const shipFromCountry = vcsOrder.shipFromCountry || 'BE';
    const isFBA = shipFromCountry !== 'BE';
    const orderPrefix = isFBA ? 'FBA' : 'FBM';
    const orderName = `${orderPrefix}${amazonOrderId}`;

    // Determine partner from VCS data
    const partnerId = await this.determinePartner(vcsOrder, null);

    // Resolve products from VCS items
    const orderLines = [];
    for (const item of (vcsOrder.items || [])) {
      const sku = item.sku;
      const transformedSku = this.transformSku(sku);

      // Find product in Odoo
      let products = await this.odoo.searchRead('product.product',
        [['default_code', '=', transformedSku]],
        ['id', 'name', 'default_code']
      );

      if (products.length === 0) {
        // Try original SKU
        products = await this.odoo.searchRead('product.product',
          [['default_code', '=', sku]],
          ['id', 'name', 'default_code']
        );
      }

      if (products.length === 0) {
        console.warn(`[VcsOdooInvoicer] Product not found for SKU: ${sku} (transformed: ${transformedSku})`);
        continue;
      }

      const product = products[0];
      const quantity = parseFloat(item.quantity) || 1;
      const priceUnit = parseFloat(item.itemPriceExclTax || item.totalExclusive || 0) / quantity;

      // Ensure line name is never empty (Odoo requires it)
      const lineName = product.name || item.title || transformedSku || sku || item.asin || `Product ${product.id}`;

      // DEBUG: Log line creation details
      console.log(`[VcsOdooInvoicer] Creating order line for ${amazonOrderId}:`, {
        productId: product.id,
        productName: product.name,
        itemTitle: item.title,
        transformedSku,
        sku,
        asin: item.asin,
        lineName,
        lineNameEmpty: !lineName || lineName.trim() === ''
      });

      if (!lineName || lineName.trim() === '') {
        console.error(`[VcsOdooInvoicer] CRITICAL: Empty line name for order ${amazonOrderId}, SKU: ${sku}`);
        throw new Error(`Cannot create order line with empty name for SKU: ${sku}`);
      }

      orderLines.push([0, 0, {
        product_id: product.id,
        product_uom_qty: quantity,
        price_unit: priceUnit,
        name: lineName,
      }]);
    }

    if (orderLines.length === 0) {
      throw new Error(`No products found for order ${amazonOrderId}`);
    }

    // Determine warehouse
    const warehouseId = await this.getWarehouseForOrder(shipFromCountry, isFBA);

    // Get order date
    const orderDate = vcsOrder.orderDate || vcsOrder.shipmentDate || new Date().toISOString();
    const formattedDate = typeof orderDate === 'string'
      ? orderDate.split('T')[0]
      : orderDate.toISOString().split('T')[0];

    // Create the sale order
    const saleOrderId = await this.odoo.create('sale.order', {
      name: orderName,
      partner_id: partnerId,
      partner_invoice_id: partnerId,
      partner_shipping_id: partnerId,
      client_order_ref: amazonOrderId,
      date_order: formattedDate,
      warehouse_id: warehouseId,
      order_line: orderLines,
      team_id: 11, // Amazon Seller team
    });

    console.log(`[VcsOdooInvoicer] Created sale order ${orderName} (ID: ${saleOrderId})`);

    // Confirm the order
    try {
      await this.odoo.execute('sale.order', 'action_confirm', [[saleOrderId]]);
      console.log(`[VcsOdooInvoicer] Confirmed order ${orderName}`);
    } catch (confirmError) {
      console.warn(`[VcsOdooInvoicer] Could not confirm order ${orderName}: ${confirmError.message}`);
    }

    // For FBA/SHIPMENT orders, set qty_delivered to match ordered qty
    // This ensures invoicing works correctly
    if (isFBA || vcsOrder.transactionType === 'SHIPMENT') {
      const createdOrderLines = await this.odoo.searchRead('sale.order.line',
        [['order_id', '=', saleOrderId]],
        ['id', 'product_uom_qty']
      );
      for (const line of createdOrderLines) {
        await this.odoo.execute('sale.order.line', 'write', [[line.id], {
          qty_delivered: line.product_uom_qty
        }]);
      }
    }

    // Fetch the created order and lines
    const saleOrder = await this.odoo.searchRead('sale.order',
      [['id', '=', saleOrderId]],
      ['id', 'name', 'client_order_ref', 'order_line', 'partner_id', 'state', 'team_id']
    );

    const createdOrderLines = await this.odoo.searchRead('sale.order.line',
      [['order_id', '=', saleOrderId]],
      ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'tax_id', 'qty_delivered']
    );

    // Add product_default_code to each line for SKU matching (field doesn't exist on sale.order.line)
    for (const line of createdOrderLines) {
      if (line.product_id) {
        const product = await this.odoo.searchRead('product.product',
          [['id', '=', line.product_id[0]]],
          ['default_code']
        );
        line.product_default_code = product[0]?.default_code || '';
      }
    }

    return {
      saleOrder: saleOrder[0],
      orderLines: createdOrderLines
    };
  }

  /**
   * Get warehouse ID for order based on ship-from country
   * @param {string} shipFromCountry - Country code
   * @param {boolean} isFBA - Whether this is an FBA order
   * @returns {number} Warehouse ID
   */
  async getWarehouseForOrder(shipFromCountry, _isFBA) {
    // Warehouse mapping
    const warehouseMap = {
      'BE': 'CW',  // Central Warehouse (FBM)
      'DE': 'de1', // FBA Germany
      'FR': 'fr1', // FBA France
      'IT': 'it1', // FBA Italy
      'ES': 'es1', // FBA Spain
      'PL': 'pl1', // FBA Poland
      'CZ': 'cz1', // FBA Czech
      'NL': 'nl1', // FBA Netherlands
    };

    const warehouseCode = warehouseMap[shipFromCountry] || 'CW';

    // Find warehouse in Odoo
    const warehouses = await this.odoo.searchRead('stock.warehouse',
      [['code', '=', warehouseCode]],
      ['id']
    );

    if (warehouses.length > 0) {
      return warehouses[0].id;
    }

    // Fallback to first warehouse
    const defaultWh = await this.odoo.searchRead('stock.warehouse', [], ['id'], 1);
    return defaultWh[0]?.id || 1;
  }

  /**
   * Check if an invoice already exists for a sale order
   * @param {string} saleOrderName - The Odoo sale order name (e.g., "FBA305-1901951-5970703")
   * @returns {object|null} Existing invoice or null
   */
  async findExistingInvoice(saleOrderName) {
    // Build list of possible order name variants to check
    // e.g., "FBA305-1901951-5970703" should also check "305-1901951-5970703"
    const namesToCheck = [saleOrderName];

    // If name starts with FBA or FBM, also check without the prefix
    if (saleOrderName.startsWith('FBA') || saleOrderName.startsWith('FBM')) {
      namesToCheck.push(saleOrderName.substring(3)); // Remove FBA/FBM prefix
    }

    // Search for invoices with invoice_origin matching any of the name variants
    const invoices = await this.odoo.searchRead('account.move',
      [
        ['invoice_origin', 'in', namesToCheck],
        ['move_type', '=', 'out_invoice'],
      ],
      ['id', 'name', 'state', 'amount_total', 'invoice_origin']
    );

    if (invoices.length > 0) {
      return invoices[0];
    }

    return null;
  }

  /**
   * Get order line details including product info
   * @param {number[]} lineIds - Order line IDs
   * @returns {object[]} Order lines with product details
   */
  async getOrderLines(lineIds) {
    if (!lineIds || lineIds.length === 0) {
      return [];
    }

    const lines = await this.odoo.searchRead('sale.order.line',
      [['id', 'in', lineIds]],
      ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'price_total']
    );

    // Get product default_code (SKU) for each line
    for (const line of lines) {
      if (line.product_id) {
        const productId = line.product_id[0];
        const products = await this.odoo.searchRead('product.product',
          [['id', '=', productId]],
          ['default_code', 'name']
        );
        if (products.length > 0) {
          line.product_default_code = products[0].default_code;
          line.product_name = products[0].name;
        }
      }
    }

    return lines;
  }

  /**
   * Mark order as skipped (with retry logic)
   * @param {ObjectId} orderId
   * @param {string} reason
   */
  async markOrderSkipped(orderId, reason) {
    const db = getDb();
    await withRetry(
      () => db.collection('amazon_vcs_orders').updateOne(
        { _id: orderId },
        {
          $set: {
            status: 'skipped',
            skipReason: reason,
            skippedAt: new Date(),
          }
        }
      ),
      `markOrderSkipped(${orderId})`
    );
  }

  /**
   * Get or create Amazon customer partner in Odoo
   * @returns {number} Partner ID
   */
  async getOrCreateAmazonPartner() {
    if (this.amazonPartnerId) {
      return this.amazonPartnerId;
    }

    // Search for existing Amazon customer
    const existing = await this.odoo.searchRead('res.partner',
      [['name', '=', 'Amazon Customer']],
      ['id']
    );

    if (existing.length > 0) {
      this.amazonPartnerId = existing[0].id;
      return this.amazonPartnerId;
    }

    // Create new partner
    const partnerId = await this.odoo.create('res.partner', {
      name: 'Amazon Customer',
      company_type: 'company',
      customer_rank: 1,
      is_company: true,
      comment: 'Generic customer for Amazon marketplace sales',
    });

    this.amazonPartnerId = partnerId;
    return partnerId;
  }

  /**
   * Determine the correct partner for the invoice based on VCS data
   * - B2B (buyer has VAT): Find or create partner by VAT number
   * - B2C (no VAT): Use generic Amazon B2C partner for the destination country
   *
   * Note: Invoice lines link to order lines via sale_line_ids, so the invoice
   * partner does NOT need to match the order partner for qty_invoiced to update.
   *
   * @param {object} order - VCS order data
   * @param {object} saleOrder - Odoo sale.order (not used for partner, only for reference)
   * @returns {Promise<number>} Partner ID
   */
  async determinePartner(order, _saleOrder) {
    return await this.findOrCreatePartnerFromVcs(order);
  }

  /**
   * Find or create partner based on VCS data
   * - B2B: Find/create by VAT number
   * - B2C: Use generic Amazon B2C partner for destination country
   * @param {object} order - VCS order data
   * @returns {Promise<number>} Partner ID
   */
  async findOrCreatePartnerFromVcs(order) {
    const buyerVat = order.buyerTaxRegistration;
    const shipToCountry = order.shipToCountry || 'BE';

    // B2B: Customer has VAT number
    if (buyerVat && buyerVat.trim() !== '') {
      return await this.findOrCreateB2BPartner(buyerVat, shipToCountry);
    }

    // B2C: Use generic country-specific Amazon customer
    return await this.findOrCreateB2CPartner(shipToCountry);
  }

  /**
   * Find or create B2B partner by VAT number
   * @param {string} vatNumber - Buyer's VAT registration number
   * @param {string} countryCode - Destination country code
   * @returns {Promise<number>} Partner ID
   */
  async findOrCreateB2BPartner(vatNumber, countryCode) {
    const cleanVat = vatNumber.trim().toUpperCase();

    // Check if this is a valid EU VAT number format
    // EU VAT: 2-letter country code + digits (varying length by country)
    // Italian fiscal codes (codice fiscale) are 16 alphanumeric chars - NOT a VAT
    const isValidVatFormat = this.isValidEuVatFormat(cleanVat);

    // Search for existing partner by VAT or name
    let existing;
    if (isValidVatFormat) {
      existing = await this.odoo.searchRead('res.partner',
        [['vat', '=', cleanVat]],
        ['id', 'name']
      );
    }

    // If not found by VAT, try by name (for fiscal codes stored without VAT field)
    if (!existing || existing.length === 0) {
      const partnerName = `Amazon B2B | ${cleanVat}`;
      existing = await this.odoo.searchRead('res.partner',
        [['name', '=', partnerName]],
        ['id', 'name']
      );
    }

    if (existing && existing.length > 0) {
      console.log(`[VcsOdooInvoicer] Found B2B partner: ${existing[0].name} (ID: ${existing[0].id})`);
      return existing[0].id;
    }

    // Get country ID
    const countries = await this.odoo.searchRead('res.country',
      [['code', '=', countryCode]],
      ['id']
    );
    const countryId = countries.length > 0 ? countries[0].id : null;

    // Create new B2B partner
    const partnerName = `Amazon B2B | ${cleanVat}`;
    const partnerData = {
      name: partnerName,
      company_type: 'company',
      is_company: true,
      customer_rank: 1,
      country_id: countryId,
      comment: `Amazon B2B customer created from VCS report. Tax ID: ${cleanVat}`,
    };

    // Only set VAT field if it's a valid EU VAT format (Odoo validates this)
    if (isValidVatFormat) {
      partnerData.vat = cleanVat;
    }

    const partnerId = await this.odoo.create('res.partner', partnerData);

    console.log(`[VcsOdooInvoicer] Created B2B partner: ${partnerName} (ID: ${partnerId})${!isValidVatFormat ? ' (fiscal code, not VAT)' : ''}`);
    return partnerId;
  }

  /**
   * Check if a tax ID is a valid EU VAT number format
   * EU VAT numbers: country code (2 letters) + digits/letters (varies by country)
   * Italian fiscal codes (codice fiscale): exactly 16 alphanumeric chars, NOT starting with IT
   * @param {string} taxId - The tax identifier to check
   * @returns {boolean} True if it looks like a valid EU VAT
   */
  isValidEuVatFormat(taxId) {
    if (!taxId || taxId.length < 4) return false;

    // Italian fiscal code (codice fiscale): 16 chars, alphanumeric, specific pattern
    // Pattern: 6 letters + 2 digits + 1 letter + 2 digits + 1 letter + 3 chars + 1 letter
    const italianFiscalCodePattern = /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/;
    if (italianFiscalCodePattern.test(taxId)) {
      console.log(`[VcsOdooInvoicer] Detected Italian fiscal code (not VAT): ${taxId}`);
      return false;
    }

    // Valid EU VAT patterns by country
    const euVatPatterns = {
      AT: /^ATU\d{8}$/,           // Austria
      BE: /^BE[01]\d{9}$/,        // Belgium
      BG: /^BG\d{9,10}$/,         // Bulgaria
      CY: /^CY\d{8}[A-Z]$/,       // Cyprus
      CZ: /^CZ\d{8,10}$/,         // Czech Republic
      DE: /^DE\d{9}$/,            // Germany
      DK: /^DK\d{8}$/,            // Denmark
      EE: /^EE\d{9}$/,            // Estonia
      EL: /^EL\d{9}$/,            // Greece
      ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/, // Spain
      FI: /^FI\d{8}$/,            // Finland
      FR: /^FR[A-Z0-9]{2}\d{9}$/, // France
      HR: /^HR\d{11}$/,           // Croatia
      HU: /^HU\d{8}$/,            // Hungary
      IE: /^IE\d{7}[A-Z]{1,2}$|^IE\d[A-Z]\d{5}[A-Z]$/, // Ireland
      IT: /^IT\d{11}$/,           // Italy (company VAT, NOT fiscal code)
      LT: /^LT(\d{9}|\d{12})$/,   // Lithuania
      LU: /^LU\d{8}$/,            // Luxembourg
      LV: /^LV\d{11}$/,           // Latvia
      MT: /^MT\d{8}$/,            // Malta
      NL: /^NL\d{9}B\d{2}$/,      // Netherlands
      PL: /^PL\d{10}$/,           // Poland
      PT: /^PT\d{9}$/,            // Portugal
      RO: /^RO\d{2,10}$/,         // Romania
      SE: /^SE\d{12}$/,           // Sweden
      SI: /^SI\d{8}$/,            // Slovenia
      SK: /^SK\d{10}$/,           // Slovakia
      XI: /^XI\d{9}$|^XI\d{12}$|^XIGD\d{3}$/, // Northern Ireland
    };

    // Check if it matches any EU VAT pattern
    for (const [_country, pattern] of Object.entries(euVatPatterns)) {
      if (pattern.test(taxId)) {
        return true;
      }
    }

    // If starts with 2 letters and has mostly digits, it might be a VAT we don't have a pattern for
    if (/^[A-Z]{2}\d+$/.test(taxId) && taxId.length >= 8) {
      return true;
    }

    return false;
  }

  /**
   * Find or create generic B2C partner for a country
   * Uses pattern: "Amazon | AMZ_B2C_{countryCode}"
   * @param {string} countryCode - Destination country code
   * @returns {Promise<number>} Partner ID
   */
  async findOrCreateB2CPartner(countryCode) {
    const partnerName = `Amazon | AMZ_B2C_${countryCode}`;

    // Check cache first
    if (!this._b2cPartnerCache) {
      this._b2cPartnerCache = {};
    }
    if (this._b2cPartnerCache[countryCode]) {
      return this._b2cPartnerCache[countryCode];
    }

    // Search for existing B2C partner
    const existing = await this.odoo.searchRead('res.partner',
      [['name', '=', partnerName]],
      ['id']
    );

    if (existing.length > 0) {
      this._b2cPartnerCache[countryCode] = existing[0].id;
      return existing[0].id;
    }

    // Get country ID
    const countries = await this.odoo.searchRead('res.country',
      [['code', '=', countryCode]],
      ['id']
    );
    const countryId = countries.length > 0 ? countries[0].id : null;

    // Create new B2C partner
    const partnerId = await this.odoo.create('res.partner', {
      name: partnerName,
      company_type: 'company',
      is_company: true,
      customer_rank: 1,
      country_id: countryId,
      comment: `Generic Amazon B2C customer for ${countryCode} marketplace orders`,
    });

    console.log(`[VcsOdooInvoicer] Created B2C partner: ${partnerName} (ID: ${partnerId})`);
    this._b2cPartnerCache[countryCode] = partnerId;
    return partnerId;
  }

  /**
   * Determine the sales team based on the Amazon marketplace
   * @param {object} order - VCS order data
   * @returns {number|null} Sales team ID
   */
  determineSalesTeam(order) {
    const marketplace = order.marketplaceId;
    if (marketplace && MARKETPLACE_SALES_TEAMS[marketplace]) {
      return MARKETPLACE_SALES_TEAMS[marketplace];
    }
    // Fallback: no sales team (will use Odoo default)
    console.warn(`[VcsOdooInvoicer] No sales team mapping for marketplace: ${marketplace}`);
    return null;
  }

  /**
   * Determine the receivable account based on the Amazon marketplace
   * ALL Amazon Seller invoices (B2C and B2B) use marketplace-specific receivable accounts
   * because Amazon collects payment from all customers (including B2B)
   *
   * @param {object} order - VCS order data
   * @returns {number|null} Account ID for the marketplace receivable
   */
  determineReceivableAccount(order) {
    const marketplace = order.marketplaceId;
    if (marketplace && MARKETPLACE_RECEIVABLE_ACCOUNTS[marketplace]) {
      const accountId = MARKETPLACE_RECEIVABLE_ACCOUNTS[marketplace];
      console.log(`[VcsOdooInvoicer] Using receivable account for marketplace ${marketplace}: ${accountId}`);
      return accountId;
    }
    // Fallback: use BE account as default
    console.warn(`[VcsOdooInvoicer] No receivable account for marketplace ${marketplace}, using BE default`);
    return MARKETPLACE_RECEIVABLE_ACCOUNTS['BE'] || null;
  }

  /**
   * Get the OSS tax ID for a country based on the VCS tax rate
   * @param {object} order - VCS order data
   * @returns {number|null} Tax ID
   */
  getOssTaxId(order) {
    const country = order.shipToCountry;
    const countryTaxes = OSS_TAXES[country];
    if (!countryTaxes) {
      console.warn(`[VcsOdooInvoicer] No OSS taxes found for country ${country}`);
      return null;
    }

    // Get tax rate from VCS (e.g., 0.19 for 19%)
    const vcsRate = order.items?.[0]?.taxRate;
    if (vcsRate) {
      const ratePercent = Math.round(vcsRate * 100);
      if (countryTaxes[ratePercent]) {
        return countryTaxes[ratePercent];
      }
    }

    // Fallback to standard rate for the country
    const standardRate = STANDARD_VAT_RATES[country];
    if (standardRate && countryTaxes[standardRate]) {
      return countryTaxes[standardRate];
    }

    // Return the first available tax for this country
    const rates = Object.keys(countryTaxes);
    if (rates.length > 0) {
      return countryTaxes[rates[0]];
    }

    return null;
  }

  /**
   * Get tax ID from VCS data - derives the correct tax based on VCS totals
   * This is the primary method for determining taxes - VCS data is authoritative!
   *
   * Logic:
   * 1. Calculate the tax rate from VCS data (totalTax / totalExclusive)
   * 2. Determine if this is OSS (cross-border EU) or domestic (same country)
   * 3. Look up the correct tax ID from OSS_TAXES or DOMESTIC_TAXES
   *
   * @param {object} order - VCS order data
   * @returns {number|null} Tax ID
   */
  getTaxIdFromVCS(order) {
    const shipFrom = order.shipFromCountry;
    const shipTo = order.shipToCountry;
    const totalExcl = Math.abs(order.totalExclusive || 0);
    const totalTax = Math.abs(order.totalTax || 0);

    // Calculate actual tax rate from VCS data
    let vcsRatePercent = 0;
    if (totalExcl > 0 && totalTax > 0) {
      vcsRatePercent = Math.round((totalTax / totalExcl) * 100);
    }

    console.log(`[VcsOdooInvoicer] getTaxIdFromVCS: shipFrom=${shipFrom}, shipTo=${shipTo}, rate=${vcsRatePercent}%`);

    // Determine the VAT scenario
    const isOSS = order.taxReportingScheme === 'VCS_EU_OSS';
    const isExport = this.isExportOrder(order);
    const isDomestic = shipFrom === shipTo && EU_COUNTRIES.includes(shipTo);
    const isCrossBorderEU = shipFrom !== shipTo && EU_COUNTRIES.includes(shipFrom) && EU_COUNTRIES.includes(shipTo);

    // 1. Export orders - use BE 0% export tax (must match BE export fiscal position)
    // IMPORTANT: We always use BE's export fiscal position (ID 3), so we must use BE's 0% tax
    // to avoid "tax not compatible with fiscal position" errors
    if (isExport) {
      console.log(`[VcsOdooInvoicer] Export order - using BE 0% export tax`);
      const beTaxes = DOMESTIC_TAXES['BE'];
      return beTaxes?.[0] || null; // BE*VAT | 0% (ID 8)
    }

    // 2. Explicit OSS scheme OR cross-border EU sale
    if (isOSS || isCrossBorderEU) {
      console.log(`[VcsOdooInvoicer] OSS/Cross-border EU - using OSS taxes for ${shipTo}`);
      const countryTaxes = OSS_TAXES[shipTo];
      if (countryTaxes) {
        // Try exact rate match first
        if (countryTaxes[vcsRatePercent]) {
          return countryTaxes[vcsRatePercent];
        }
        // Fallback to standard rate for destination country
        const standardRate = STANDARD_VAT_RATES[shipTo];
        if (standardRate && countryTaxes[standardRate]) {
          return countryTaxes[standardRate];
        }
        // Return first available
        const rates = Object.keys(countryTaxes);
        if (rates.length > 0) {
          return countryTaxes[rates[0]];
        }
      }
      // If no OSS taxes for this country, fall through to domestic
      console.warn(`[VcsOdooInvoicer] No OSS taxes for ${shipTo}, falling back to domestic`);
    }

    // 3. Domestic sale (same country) - use domestic VAT
    if (isDomestic) {
      console.log(`[VcsOdooInvoicer] Domestic sale in ${shipTo} - using domestic VAT`);
      const countryTaxes = DOMESTIC_TAXES[shipTo];
      if (countryTaxes) {
        // Try exact rate match first
        if (countryTaxes[vcsRatePercent]) {
          return countryTaxes[vcsRatePercent];
        }
        // Fallback to standard rate for this country
        const standardRate = STANDARD_VAT_RATES[shipTo];
        if (standardRate && countryTaxes[standardRate]) {
          return countryTaxes[standardRate];
        }
        // Return first available
        const rates = Object.keys(countryTaxes);
        if (rates.length > 0) {
          return countryTaxes[rates[0]];
        }
      }
    }

    // 4. Fallback - if we have a taxReportingScheme, use the existing OSS logic
    if (order.taxReportingScheme === 'VCS_EU_OSS') {
      return this.getOssTaxId(order);
    }

    console.warn(`[VcsOdooInvoicer] Could not determine tax for order ${order.orderId}`);
    return null;
  }

  /**
   * Build invoice data from VCS order
   * @param {object} order - VCS order data
   * @param {number} partnerId - Odoo partner ID (may be overridden for OSS)
   * @param {object} saleOrder - Odoo sale.order
   * @param {object[]} orderLines - Odoo sale.order.line records
   * @returns {object}
   */
  buildInvoiceData(order, partnerId, saleOrder, _orderLines) {
    const invoiceDate = getEffectiveInvoiceDate(order.shipmentDate || order.orderDate);
    const fiscalPosition = this.determineFiscalPosition(order);
    const journalId = this.determineJournal(order);

    // Use the partnerId passed in (already determined from VCS data by caller)
    const invoicePartnerId = partnerId;

    // VCS Invoice Number for reference fields
    const vcsInvoiceNumber = order.vatInvoiceNumber || null;

    // Determine sales team based on marketplace (NOT inherited from order)
    const teamId = this.determineSalesTeam(order);

    return {
      move_type: 'out_invoice',
      partner_id: invoicePartnerId,
      invoice_date: this.formatDate(invoiceDate),
      // ref: Amazon order ID (shown in "Customer Reference" in Odoo)
      ref: order.orderId,
      // x_vcs_invoice_number: VCS invoice number (our custom field)
      x_vcs_invoice_number: vcsInvoiceNumber || null,
      // payment_reference: Also set to VCS invoice number
      payment_reference: vcsInvoiceNumber || null,
      // invoice_origin: Amazon order ID (link to sale order)
      invoice_origin: order.orderId,
      narration: `Amazon Order: ${order.orderId}\nSale Order: ${saleOrder.name}\nVAT Invoice: ${vcsInvoiceNumber || 'N/A'}`,
      currency_id: this.getCurrencyId(order.currency),
      fiscal_position_id: fiscalPosition,
      journal_id: journalId,
      // Sales team based on Amazon marketplace
      team_id: teamId,
      // Note: invoice_line_ids not included here - lines come from sale order
      // via Odoo's _create_invoices, then updated with VCS data
    };
  }

  /**
   * Determine fiscal position based on order data
   * IMPORTANT: Derives fiscal position from VCS data (shipFrom/shipTo), NOT from order data
   * @param {object} order
   * @returns {number|null} Fiscal position ID
   */
  determineFiscalPosition(order) {
    const shipFrom = order.shipFromCountry;
    const shipTo = order.shipToCountry;

    // Export orders use the export fiscal position directly (ID 3)
    // This ensures proper VAT grid mapping (Grid 47) for exports
    if (this.isExportOrder(order)) {
      return EXPORT_FISCAL_POSITION_ID; // BE*VAT | Régime Extra-Communautaire
    }

    // Explicit OSS scheme OR cross-border EU (infer OSS when taxReportingScheme empty)
    // OSS = selling from one EU country to consumer in another EU country
    const isExplicitOSS = order.taxReportingScheme === 'VCS_EU_OSS';
    const isCrossBorderEU = shipFrom !== shipTo && EU_COUNTRIES.includes(shipFrom) && EU_COUNTRIES.includes(shipTo);

    if (isExplicitOSS || isCrossBorderEU) {
      const ossFiscalPositionId = OSS_FISCAL_POSITIONS[shipTo];
      if (ossFiscalPositionId) {
        console.log(`[VcsOdooInvoicer] Using OSS fiscal position for ${shipTo}: ${ossFiscalPositionId}`);
        return ossFiscalPositionId;
      }
      console.warn(`[VcsOdooInvoicer] No OSS fiscal position for country ${shipTo}`);
    }

    // B2B with buyer VAT number - use Intra-Community B2B fiscal position
    if (order.buyerTaxRegistration) {
      // Look up from cache if available
      return this.fiscalPositionCache?.['B2B_EU'] || null;
    }

    // Domestic sale (same country) - use the domestic fiscal position
    // The local VAT of that country will be applied via getTaxIdFromVCS
    if (shipFrom === shipTo && EU_COUNTRIES.includes(shipTo)) {
      const domesticFiscalPositionId = DOMESTIC_FISCAL_POSITIONS[shipTo];
      if (domesticFiscalPositionId) {
        console.log(`[VcsOdooInvoicer] Domestic ${shipTo} sale - using fiscal position ${domesticFiscalPositionId}`);
        return domesticFiscalPositionId;
      }
      console.warn(`[VcsOdooInvoicer] No domestic fiscal position for country ${shipTo}`);
      return null;
    }

    return null;
  }

  /**
   * Determine journal based on marketplace
   * IMPORTANT: Derives journal from VCS data (shipFrom/shipTo), NOT from order data
   * @param {object} order
   * @returns {number|null}
   */
  determineJournal(order) {
    const shipFrom = order.shipFromCountry;
    const shipTo = order.shipToCountry;

    // Check if this is an export (destination outside EU)
    const isExport = this.isExportOrder(order);
    if (isExport) {
      const journalCode = MARKETPLACE_JOURNALS['EXPORT']; // VEX
      return this.journalCache?.[journalCode] || this.defaultJournalId || null;
    }

    // For OSS orders (EU cross-border B2C), use the OSS journal
    // This includes both explicit VCS_EU_OSS and inferred cross-border EU
    const isExplicitOSS = order.taxReportingScheme === 'VCS_EU_OSS';
    const isCrossBorderEU = shipFrom !== shipTo && EU_COUNTRIES.includes(shipFrom) && EU_COUNTRIES.includes(shipTo);

    if (isExplicitOSS || isCrossBorderEU) {
      const journalCode = MARKETPLACE_JOURNALS['OSS'];
      return this.journalCache?.[journalCode] || this.defaultJournalId || null;
    }

    // Domestic sale - use the destination country's journal
    const country = shipTo || order.sellerTaxJurisdiction || 'BE';
    const journalCode = MARKETPLACE_JOURNALS[country] || MARKETPLACE_JOURNALS['DEFAULT'];

    // Look up journal ID from cache
    return this.journalCache?.[journalCode] || this.defaultJournalId || null;
  }

  /**
   * Check if order is an export (outside EU)
   * @param {object} order
   * @returns {boolean}
   */
  isExportOrder(order) {
    // DEEMED_RESELLER means Amazon handles VAT (typically UK post-Brexit from EU)
    if (order.taxReportingScheme === 'DEEMED_RESELLER') {
      return true;
    }

    // CH_VOEC is Swiss export
    if (order.taxReportingScheme === 'CH_VOEC') {
      return true;
    }

    // Check if destination is outside EU
    const destination = order.shipToCountry;
    if (destination && !EU_COUNTRIES.includes(destination)) {
      // GB shipped FROM GB is domestic UK, not export
      // GB shipped FROM EU is export
      if (destination === 'GB' && order.shipFromCountry === 'GB') {
        return false; // UK domestic sale
      }
      return true; // Non-EU destination = export
    }

    return false;
  }

  /**
   * Create invoice in Odoo using the sale order's native _create_invoices
   * This ensures proper linking (qty_invoiced updates, correct products)
   * Then update the draft invoice with VCS data (quantities, prices, taxes)
   *
   * @param {object} order - VCS order data
   * @param {number} partnerId - Odoo partner ID
   * @param {object} saleOrder - Odoo sale.order
   * @param {object[]} orderLines - Odoo sale.order.line records
   * @returns {object}
   */
  async createInvoice(order, partnerId, saleOrder, orderLines) {
    // Step 1: Create invoice from sale order using the wizard approach
    // This properly links the invoice to the order and updates qty_invoiced
    console.log(`[VcsOdooInvoicer] Creating invoice from order ${saleOrder.name}...`);

    // Create invoice directly by copying from sale order lines
    // This links the invoice to the order via sale_line_ids
    console.log(`[VcsOdooInvoicer] Building invoice from order lines...`);

    // Get order lines with product info
    const orderLineDetails = await this.odoo.searchRead('sale.order.line',
      [['order_id', '=', saleOrder.id]],
      ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'tax_id', 'qty_delivered']
    );

    // For SHIPMENT transactions, update qty_delivered on order lines
    // This ensures Odoo calculates invoice_status correctly as "invoiced" instead of "to invoice"
    // VCS SHIPMENT means the order was shipped by Amazon, so qty_delivered should match qty ordered
    if (order.transactionType === 'SHIPMENT') {
      console.log(`[VcsOdooInvoicer] Updating qty_delivered for SHIPMENT order ${saleOrder.name}...`);
      for (const line of orderLineDetails) {
        if (line.qty_delivered < line.product_uom_qty) {
          await this.odoo.execute('sale.order.line', 'write', [[line.id], {
            qty_delivered: line.product_uom_qty
          }]);
          // Update local copy too for invoice creation
          line.qty_delivered = line.product_uom_qty;
        }
      }
    }

    // Build invoice line data from order lines
    const invoiceLines = [];
    for (const line of orderLineDetails) {
      if (!line.product_id) continue;

      // Use qty_delivered if set, otherwise use product_uom_qty
      const qty = line.qty_delivered > 0 ? line.qty_delivered : line.product_uom_qty;

      invoiceLines.push([0, 0, {
        product_id: line.product_id[0],
        name: line.name,
        quantity: qty,
        price_unit: line.price_unit,
        tax_ids: line.tax_id ? [[6, 0, line.tax_id]] : false,
        sale_line_ids: [[4, line.id]], // Link to sale order line
      }]);
    }

    // Create the invoice linked to the sale order
    // Use partnerId from VCS data (NOT inherited from sale order)
    const invoiceId = await this.odoo.create('account.move', {
      move_type: 'out_invoice',
      partner_id: partnerId,
      invoice_origin: saleOrder.name,
      invoice_line_ids: invoiceLines,
    });

    if (!invoiceId) {
      throw new Error(`Failed to create invoice for order ${saleOrder.name}`);
    }

    console.log(`[VcsOdooInvoicer] Invoice created with ID ${invoiceId}, updating with VCS data...`);

    // Step 2: Update the draft invoice with VCS data
    await this.updateInvoiceFromVCS(invoiceId, order, orderLines);

    // Get final invoice details
    const invoice = await this.odoo.searchRead('account.move',
      [['id', '=', invoiceId]],
      ['name', 'amount_total', 'amount_tax', 'state']
    );

    // Draft invoices have name "/", show ID instead for UI
    const invoiceName = invoice[0]?.name === '/' ? `Draft #${invoiceId}` : invoice[0]?.name;

    console.log(`[VcsOdooInvoicer] Invoice ${invoiceName} (ID: ${invoiceId}) updated. Total: ${invoice[0]?.amount_total}, Tax: ${invoice[0]?.amount_tax}`);

    return {
      id: invoiceId,
      name: invoiceName || `Draft #${invoiceId}`,
      amountTotal: invoice[0]?.amount_total,
      amountTax: invoice[0]?.amount_tax,
      orderId: order.orderId,
      saleOrderName: saleOrder.name,
      saleOrderId: saleOrder.id,
    };
  }

  /**
   * Update a draft invoice with VCS data
   * VCS is the authoritative source for quantities, prices, and taxes
   *
   * @param {number} invoiceId - The Odoo invoice ID
   * @param {object} order - VCS order data
   * @param {object[]} orderLines - Odoo sale.order.line records (for SKU matching)
   */
  async updateInvoiceFromVCS(invoiceId, order, _orderLines) {
    // Determine VCS-based settings
    const fiscalPositionId = this.determineFiscalPosition(order);
    const journalId = this.determineJournal(order);
    const teamId = this.determineSalesTeam(order);
    const vcsInvoiceNumber = order.vatInvoiceNumber || null;
    const invoiceDate = getEffectiveInvoiceDate(order.shipmentDate || order.orderDate);

    // Update invoice header
    const headerUpdate = {
      invoice_date: this.formatDate(invoiceDate),
      // ref: Amazon order ID
      ref: order.orderId,
      // x_vcs_invoice_number: VCS invoice number (our custom field)
      x_vcs_invoice_number: vcsInvoiceNumber || null,
      payment_reference: vcsInvoiceNumber || null,
    };

    // Set the VCS invoice URL field (our own Acropaq field)
    // x_vcs_invoice_url is from the acropaq_amazon module (independent of Amazon EPT)
    if (order.invoiceUrl) {
      headerUpdate.x_vcs_invoice_url = order.invoiceUrl;
      // Also set the legacy Amazon EPT field for backward compatibility during transition
      headerUpdate.invoice_url = order.invoiceUrl;
    }

    if (fiscalPositionId) {
      headerUpdate.fiscal_position_id = fiscalPositionId;
    }
    if (journalId) {
      headerUpdate.journal_id = journalId;
    }
    if (teamId) {
      headerUpdate.team_id = teamId;
    }

    await this.odoo.execute('account.move', 'write', [[invoiceId], headerUpdate]);

    // Get invoice lines with product info
    // Simply filter by product_id existing - this gives us the product lines
    const invoiceLines = await this.odoo.searchRead('account.move.line',
      [['move_id', '=', invoiceId], ['product_id', '!=', false]],
      ['id', 'product_id', 'name', 'quantity', 'price_unit']
    );
    console.log(`[VcsOdooInvoicer] Found ${invoiceLines.length} invoice lines to update`);

    // Get product SKUs for all invoice lines
    const productIds = invoiceLines.map(l => l.product_id[0]).filter(Boolean);
    const products = await this.odoo.searchRead('product.product',
      [['id', 'in', productIds]],
      ['id', 'default_code', 'name']
    );

    const productSkuMap = {};
    for (const p of products) {
      productSkuMap[p.id] = p.default_code || '';
    }

    // Get the correct tax ID from VCS data - this handles OSS, domestic, and export scenarios
    // VCS is authoritative for tax rates!
    const correctTaxId = this.getTaxIdFromVCS(order);
    console.log(`[VcsOdooInvoicer] Using tax ID ${correctTaxId} for order (shipFrom=${order.shipFromCountry}, shipTo=${order.shipToCountry}, scheme=${order.taxReportingScheme})`);

    // Match VCS items to invoice lines and update
    for (const vcsItem of order.items) {
      const transformedSku = this.transformSku(vcsItem.sku);

      // Find matching invoice line by product SKU
      // Try multiple matching strategies
      const matchingLine = invoiceLines.find(line => {
        const lineSku = productSkuMap[line.product_id[0]] || '';
        const lineProduct = products.find(p => p.id === line.product_id[0]);
        const lineName = line.name || '';
        const productName = lineProduct?.name || '';

        // Exact match
        if (lineSku === transformedSku || lineSku === vcsItem.sku) return true;

        // SKU contained in product default_code or line name
        if (lineSku.includes(transformedSku) || transformedSku.includes(lineSku)) return true;
        if (lineName.includes(transformedSku) || lineName.includes(vcsItem.sku)) return true;

        // SKU with brackets [82004] style
        if (lineName.includes(`[${transformedSku}]`) || lineName.includes(`[${vcsItem.sku}]`)) return true;
        if (productName.includes(`[${transformedSku}]`) || productName.includes(`[${vcsItem.sku}]`)) return true;

        return false;
      });

      if (matchingLine) {
        const lineUpdate = {
          quantity: vcsItem.quantity,
          price_unit: vcsItem.priceExclusive / vcsItem.quantity,
        };

        // ALWAYS set the correct tax from VCS data (OSS, domestic, or export)
        if (correctTaxId) {
          lineUpdate.tax_ids = [[6, 0, [correctTaxId]]];
        }

        await this.odoo.execute('account.move.line', 'write', [[matchingLine.id], lineUpdate]);
        console.log(`[VcsOdooInvoicer] Updated line ${matchingLine.id}: qty=${vcsItem.quantity}, price=${lineUpdate.price_unit}, tax_id=${correctTaxId}`);
      } else {
        console.warn(`[VcsOdooInvoicer] No matching invoice line for VCS SKU ${vcsItem.sku} (transformed: ${transformedSku})`);
        console.warn(`[VcsOdooInvoicer] Available invoice lines:`, invoiceLines.map(l => ({ id: l.id, name: l.name, sku: productSkuMap[l.product_id[0]] })));
      }
    }

    // Update shipping line if present
    if (order.totalShipping && order.totalShipping !== 0) {
      // Find shipping line by looking for product with SHIP or shipping in name
      const shippingLine = invoiceLines.find(line => {
        const productName = (line.name || '').toLowerCase();
        const productSku = (productSkuMap[line.product_id[0]] || '').toLowerCase();
        return productName.includes('shipping') || productName.includes('ship') ||
               productSku.includes('ship');
      });

      if (shippingLine) {
        const shippingUpdate = { price_unit: order.totalShipping };
        // ALWAYS apply correct tax from VCS (OSS, domestic, or export)
        if (correctTaxId) {
          shippingUpdate.tax_ids = [[6, 0, [correctTaxId]]];
        }
        await this.odoo.execute('account.move.line', 'write', [[shippingLine.id], shippingUpdate]);
        console.log(`[VcsOdooInvoicer] Updated shipping line: price=${order.totalShipping}, tax_id=${correctTaxId}`);
      }
    }

    // Update shipping discount line if present
    if (order.totalShippingPromo && order.totalShippingPromo !== 0) {
      // Find shipping discount line
      const shippingDiscountLine = invoiceLines.find(line => {
        const productName = (line.name || '').toLowerCase();
        return productName.includes('shipment discount') || productName.includes('shipping discount');
      });

      if (shippingDiscountLine) {
        const discountUpdate = { price_unit: -Math.abs(order.totalShippingPromo) };
        // ALWAYS apply correct tax from VCS (OSS, domestic, or export)
        if (correctTaxId) {
          discountUpdate.tax_ids = [[6, 0, [correctTaxId]]];
        }
        await this.odoo.execute('account.move.line', 'write', [[shippingDiscountLine.id], discountUpdate]);
        console.log(`[VcsOdooInvoicer] Updated shipping discount line: price=-${Math.abs(order.totalShippingPromo)}, tax_id=${correctTaxId}`);
      }
    }

    // Update the receivable line with the correct marketplace-specific account
    // The receivable line is auto-created by Odoo and uses the partner's default account
    // We need to override it with the marketplace-specific account (400102XX)
    const receivableAccountId = this.determineReceivableAccount(order);
    if (receivableAccountId) {
      // Find the receivable line (account_type = 'asset_receivable' or name contains 'Trade debtors')
      const allLines = await this.odoo.searchRead('account.move.line',
        [['move_id', '=', invoiceId]],
        ['id', 'name', 'account_id', 'account_type', 'balance']
      );

      // Find the receivable line (it's the one with positive balance and receivable type)
      const receivableLine = allLines.find(line =>
        line.account_type === 'asset_receivable' ||
        (line.account_id && line.account_id[1] && line.account_id[1].includes('400'))
      );

      if (receivableLine) {
        await this.odoo.execute('account.move.line', 'write', [[receivableLine.id], {
          account_id: receivableAccountId
        }]);
        console.log(`[VcsOdooInvoicer] Updated receivable line ${receivableLine.id} to account ${receivableAccountId}`);
      } else {
        console.warn(`[VcsOdooInvoicer] Could not find receivable line to update`);
      }
    }

    // Note: Odoo will automatically recompute totals when lines are modified
    // No need to call _compute_amount explicitly
  }

  /**
   * Load and cache fiscal positions, journals, currencies, and tax lock date from Odoo
   */
  async loadCache() {
    // Load tax lock date from company settings
    try {
      const companies = await this.odoo.searchRead('res.company',
        [['id', '=', 1]], // Main company
        ['tax_lock_date']
      );
      if (companies.length > 0 && companies[0].tax_lock_date) {
        vatCutoffDate = companies[0].tax_lock_date;
        console.log(`[VcsOdooInvoicer] Tax lock date from Odoo: ${vatCutoffDate}`);
      } else if (!vatCutoffDate) {
        console.log('[VcsOdooInvoicer] No tax lock date set in Odoo, invoices will use delivery date');
      }
    } catch (err) {
      console.warn('[VcsOdooInvoicer] Could not fetch tax lock date:', err.message);
    }

    // Load fiscal positions
    const fiscalPositions = await this.odoo.searchRead('account.fiscal.position',
      [],
      ['id', 'name']
    );

    this.fiscalPositionCache = {};
    this.fiscalPositionNameCache = {}; // id -> name
    for (const fp of fiscalPositions) {
      this.fiscalPositionNameCache[fp.id] = fp.name;
      // Map by name pattern
      for (const [key, name] of Object.entries(FISCAL_POSITIONS)) {
        if (fp.name.toLowerCase().includes(name.toLowerCase())) {
          this.fiscalPositionCache[key] = fp.id;
        }
      }
    }

    // Load journals
    const journals = await this.odoo.searchRead('account.journal',
      [['type', '=', 'sale']],
      ['id', 'code', 'name']
    );

    this.journalCache = {};
    this.journalNameCache = {}; // id -> name
    for (const j of journals) {
      this.journalCache[j.code] = j.id;
      this.journalNameCache[j.id] = j.name || j.code;
    }

    // Load currencies
    const currencies = await this.odoo.searchRead('res.currency',
      [['active', '=', true]],
      ['id', 'name', 'symbol']
    );

    this.currencyCache = {};
    for (const c of currencies) {
      this.currencyCache[c.name] = c.id;
    }

    console.log('[VcsOdooInvoicer] Cache loaded:', {
      fiscalPositions: Object.keys(this.fiscalPositionCache).length,
      journals: Object.keys(this.journalCache).length,
      currencies: Object.keys(this.currencyCache).length,
      taxLockDate: vatCutoffDate || 'not set',
    });
  }

  /**
   * Get currency ID from code
   * @param {string} currencyCode
   * @returns {number|null}
   */
  getCurrencyId(currencyCode) {
    if (this.currencyCache && this.currencyCache[currencyCode]) {
      return this.currencyCache[currencyCode];
    }
    // Fallback for dry run mode
    return null;
  }

  /**
   * Get journal name by ID
   * @param {number} journalId
   * @returns {string|null}
   */
  getJournalName(journalId) {
    if (!journalId) return null;
    return this.journalNameCache?.[journalId] || null;
  }

  /**
   * Get fiscal position name by ID
   * @param {number} fiscalPositionId
   * @returns {string|null}
   */
  getFiscalPositionName(fiscalPositionId) {
    if (!fiscalPositionId) return null;
    return this.fiscalPositionNameCache?.[fiscalPositionId] || null;
  }

  /**
   * Get expected journal code for an order (for display when not found)
   * @param {object} order
   * @returns {string}
   */
  getExpectedJournalCode(order) {
    // For OSS orders, use the OSS journal
    if (order.taxReportingScheme === 'VCS_EU_OSS') {
      return MARKETPLACE_JOURNALS['OSS'];
    }
    // For export orders, use the export journal
    if (this.isExportOrder(order)) {
      return MARKETPLACE_JOURNALS['EXPORT'];
    }
    // Use shipToCountry (destination) to determine journal
    const country = order.shipToCountry || order.sellerTaxJurisdiction || 'BE';
    return MARKETPLACE_JOURNALS[country] || MARKETPLACE_JOURNALS['DEFAULT'];
  }

  /**
   * Get expected fiscal position key for an order (for display when not found)
   * @param {object} order
   * @returns {string|null}
   */
  getExpectedFiscalPositionKey(order) {
    // Export orders (non-EU destinations)
    if (this.isExportOrder(order)) {
      return 'Extra-Communautaire (Export)';
    }
    // OSS scheme
    if (order.taxReportingScheme === 'VCS_EU_OSS') {
      return `OSS ${order.shipToCountry}`;
    }
    // B2B with buyer VAT number
    if (order.buyerTaxRegistration) {
      return 'Intra-Community B2B';
    }
    // Domestic Belgian sale
    if (order.shipToCountry === 'BE' && (order.sellerTaxJurisdiction === 'BE' || order.shipFromCountry === 'BE')) {
      return 'Belgium Domestic';
    }
    return null; // Will use default
  }

  /**
   * Format date for Odoo
   * @param {Date} date
   * @returns {string}
   */
  formatDate(date) {
    if (!date) return null;
    const d = new Date(date);
    return d.toISOString().split('T')[0];
  }

  /**
   * Create credit notes in Odoo for selected VCS return orders
   * @param {object} options
   * @param {string[]} options.orderIds - MongoDB IDs of return orders to process
   * @param {boolean} options.dryRun - If true, don't create credit notes
   * @returns {object} Results
   */
  async createCreditNotes(options = {}) {
    const { orderIds = [], dryRun = false } = options;
    const db = getDb();

    const result = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [],
      creditNotes: [],
    };

    if (orderIds.length === 0) {
      return { ...result, message: 'No return orders selected' };
    }

    // Get selected return orders by their MongoDB IDs
    const orders = await db.collection('amazon_vcs_orders')
      .find({
        _id: { $in: orderIds.map(id => new ObjectId(id)) },
        transactionType: 'RETURN'
      })
      .toArray();

    if (orders.length === 0) {
      return { ...result, message: 'No return orders found for the given IDs' };
    }

    // PERFORMANCE OPTIMIZATION: Prefetch all Odoo orders in batch
    console.log(`[VcsOdooInvoicer] Processing ${orders.length} VCS return orders...`);
    await this.prefetchOrders(orders);

    for (const order of orders) {
      result.processed++;

      try {
        // Skip orders that shouldn't create credit notes
        if (this.shouldSkipOrder(order)) {
          result.skipped++;
          await this.markOrderSkipped(order._id, 'Not refundable');
          continue;
        }

        // Find existing Odoo order (required for proper linking)
        const odooOrderData = await this.findOdooOrder(order);
        if (!odooOrderData) {
          result.skipped++;
          await this.markOrderSkipped(order._id, 'No matching Odoo order found for return');
          result.errors.push({
            orderId: order.orderId,
            error: 'No matching Odoo order found - order must exist in Odoo first',
          });
          continue;
        }

        const { saleOrder, orderLines } = odooOrderData;

        // Check if credit note already exists
        const existingCreditNote = await this.findExistingCreditNote(saleOrder.name, order.returnDate);
        if (existingCreditNote) {
          result.skipped++;
          await this.markOrderSkipped(order._id, `Credit note already exists: ${existingCreditNote.name}`);
          console.log(`[VcsOdooInvoicer] Credit note already exists for return ${order.orderId}: ${existingCreditNote.name}`);
          continue;
        }

        if (dryRun) {
          result.creditNotes.push({
            orderId: order.orderId,
            orderKey: order.orderKey,
            dryRun: true,
            odooOrderName: saleOrder.name,
            preview: {
              returnDate: order.returnDate,
              shipTo: order.shipToCountry,
              taxScheme: order.taxReportingScheme || 'Standard',
              totalExclVat: order.totalExclusive || 0,
              vatAmount: order.totalTax || 0,
              totalInclVat: (order.totalExclusive || 0) + (order.totalTax || 0),
            },
          });
          continue;
        }

        // Create credit note
        const creditNote = await this.createCreditNote(order, saleOrder, orderLines);
        result.created++;
        result.creditNotes.push(creditNote);

        // Mark order as credit-noted
        await db.collection('amazon_vcs_orders').updateOne(
          { _id: order._id },
          {
            $set: {
              status: 'credit_noted',
              odooCreditNoteId: creditNote.id,
              odooCreditNoteName: creditNote.name,
              odooSaleOrderId: saleOrder.id,
              odooSaleOrderName: saleOrder.name,
              creditNotedAt: new Date(),
            }
          }
        );

      } catch (error) {
        result.errors.push({
          orderId: order.orderId,
          error: error.message,
        });
        console.error(`[VcsOdooInvoicer] Error processing return ${order.orderId}:`, error);
      }
    }

    return result;
  }

  /**
   * Check if a credit note already exists for a return
   * @param {string} saleOrderName - The Odoo sale order name
   * @param {Date} returnDate - The return date (to distinguish multiple returns)
   * @returns {object|null} Existing credit note or null
   */
  async findExistingCreditNote(saleOrderName, returnDate) {
    const filters = [
      ['invoice_origin', '=', saleOrderName],
      ['move_type', '=', 'out_refund'],
    ];

    // If we have a return date, also filter by invoice_date to distinguish multiple returns
    if (returnDate) {
      filters.push(['invoice_date', '=', this.formatDate(returnDate)]);
    }

    const creditNotes = await this.odoo.searchRead('account.move',
      filters,
      ['id', 'name', 'state', 'amount_total']
    );

    if (creditNotes.length > 0) {
      return creditNotes[0];
    }

    return null;
  }

  /**
   * Create a credit note in Odoo for a return
   * @param {object} order - VCS return order data
   * @param {object} saleOrder - Odoo sale.order
   * @param {object[]} orderLines - Odoo sale.order.line records
   * @returns {object}
   */
  async createCreditNote(order, saleOrder, _orderLines) {
    console.log(`[VcsOdooInvoicer] Creating credit note for return ${order.orderId}...`);

    // Get order lines with product info
    const orderLineDetails = await this.odoo.searchRead('sale.order.line',
      [['order_id', '=', saleOrder.id]],
      ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'tax_id']
    );

    // Build credit note lines - amounts should be positive in Odoo credit notes
    // VCS returns have negative amounts, so we take absolute value
    const creditNoteLines = [];
    for (const vcsItem of order.items) {
      const transformedSku = this.transformSku(vcsItem.sku);

      // Find matching order line
      let matchingOrderLine = null;
      for (const line of orderLineDetails) {
        if (!line.product_id) continue;
        const productId = line.product_id[0];
        const products = await this.odoo.searchRead('product.product',
          [['id', '=', productId]],
          ['default_code', 'name']
        );
        if (products.length > 0) {
          const productSku = products[0].default_code || '';
          if (productSku === transformedSku || productSku === vcsItem.sku ||
              productSku.includes(transformedSku) || transformedSku.includes(productSku)) {
            matchingOrderLine = { ...line, product_default_code: productSku };
            break;
          }
        }
      }

      if (matchingOrderLine) {
        // Calculate positive price for credit note (VCS has negative amounts for returns)
        const unitPrice = Math.abs(vcsItem.priceExclusive) / Math.abs(vcsItem.quantity);

        // IMPORTANT: Derive tax from VCS data, NOT from order line (Emipro may have wrong data)
        const vcsTaxId = this.getTaxIdFromVCS(order);

        creditNoteLines.push([0, 0, {
          product_id: matchingOrderLine.product_id[0],
          name: matchingOrderLine.name,
          quantity: Math.abs(vcsItem.quantity),
          price_unit: unitPrice,
          // Use VCS-derived tax, NOT the order line tax
          tax_ids: vcsTaxId ? [[6, 0, [vcsTaxId]]] : false,
        }]);
      } else {
        console.warn(`[VcsOdooInvoicer] No matching product for return SKU ${vcsItem.sku}`);
      }
    }

    // Determine settings
    const fiscalPositionId = this.determineFiscalPosition(order);
    const journalId = this.determineJournal(order);
    const teamId = this.determineSalesTeam(order);
    const returnDate = getEffectiveInvoiceDate(order.returnDate || order.shipmentDate || new Date());

    // Determine partner from VCS data (NOT inherited from sale order)
    const partnerId = await this.determinePartner(order, saleOrder);

    // Create the credit note
    const creditNoteId = await this.odoo.create('account.move', {
      move_type: 'out_refund',
      partner_id: partnerId,
      invoice_origin: saleOrder.name,
      invoice_date: this.formatDate(returnDate),
      // ref: Amazon order ID (for returns, prefix with RETURN if no VCS number)
      ref: order.orderId,
      // x_vcs_invoice_number: VCS invoice number (our custom field)
      x_vcs_invoice_number: order.vatInvoiceNumber || null,
      payment_reference: order.vatInvoiceNumber || null,
      fiscal_position_id: fiscalPositionId,
      journal_id: journalId,
      team_id: teamId,
      narration: `Amazon Return for Order: ${order.orderId}\nSale Order: ${saleOrder.name}`,
      invoice_line_ids: creditNoteLines,
    });

    if (!creditNoteId) {
      throw new Error(`Failed to create credit note for return ${order.orderId}`);
    }

    // Update the receivable line with the correct marketplace-specific account
    const receivableAccountId = this.determineReceivableAccount(order);
    if (receivableAccountId) {
      const allLines = await this.odoo.searchRead('account.move.line',
        [['move_id', '=', creditNoteId]],
        ['id', 'name', 'account_id', 'account_type', 'balance']
      );

      // Find the receivable line (for credit notes, it has negative balance)
      const receivableLine = allLines.find(line =>
        line.account_type === 'asset_receivable' ||
        (line.account_id && line.account_id[1] && line.account_id[1].includes('400'))
      );

      if (receivableLine) {
        await this.odoo.execute('account.move.line', 'write', [[receivableLine.id], {
          account_id: receivableAccountId
        }]);
        console.log(`[VcsOdooInvoicer] Updated credit note receivable line ${receivableLine.id} to account ${receivableAccountId}`);
      }
    }

    // Get final credit note details
    const creditNote = await this.odoo.searchRead('account.move',
      [['id', '=', creditNoteId]],
      ['name', 'amount_total', 'amount_tax', 'state']
    );

    console.log(`[VcsOdooInvoicer] Credit note ${creditNote[0]?.name} created. Total: ${creditNote[0]?.amount_total}`);

    return {
      id: creditNoteId,
      name: creditNote[0]?.name || `RINV-${creditNoteId}`,
      amountTotal: creditNote[0]?.amount_total,
      amountTax: creditNote[0]?.amount_tax,
      orderId: order.orderId,
      saleOrderName: saleOrder.name,
      saleOrderId: saleOrder.id,
    };
  }

  /**
   * Get invoice creation status/summary
   * @returns {object}
   */
  async getStatus() {
    const db = getDb();

    const statusCounts = await db.collection('amazon_vcs_orders')
      .aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalExclusive: { $sum: '$totalExclusive' },
            totalTax: { $sum: '$totalTax' },
          }
        }
      ])
      .toArray();

    return {
      byStatus: statusCounts,
      pending: statusCounts.find(s => s._id === 'pending')?.count || 0,
      invoiced: statusCounts.find(s => s._id === 'invoiced')?.count || 0,
      skipped: statusCounts.find(s => s._id === 'skipped')?.count || 0,
    };
  }
}

module.exports = { VcsOdooInvoicer, MARKETPLACE_JOURNALS, FISCAL_POSITIONS, SKU_TRANSFORMATIONS, MARKETPLACE_RECEIVABLE_ACCOUNTS };
