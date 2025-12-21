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
 * IMPORTANT: Requires existing Odoo sales order (created by Make.com import).
 * Will NOT create invoices for orders that don't exist in Odoo.
 */

const { getDb } = require('../../db');
const { ObjectId } = require('mongodb');

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
const OSS_PARTNERS = {
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

    // Get or create Amazon customer partner
    const partnerId = await this.getOrCreateAmazonPartner();

    for (const order of orders) {
      result.processed++;

      try {
        // Skip orders that shouldn't be invoiced
        if (this.shouldSkipOrder(order)) {
          result.skipped++;
          await this.markOrderSkipped(order._id, 'Not invoiceable');
          continue;
        }

        // REQUIRED: Find existing Odoo order
        const odooOrderData = await this.findOdooOrder(order);
        if (!odooOrderData) {
          result.skipped++;
          await this.markOrderSkipped(order._id, 'No matching Odoo order found');
          result.errors.push({
            orderId: order.orderId,
            error: 'No matching Odoo order found - order must exist in Odoo first',
          });
          continue;
        }

        const { saleOrder, orderLines } = odooOrderData;

        if (dryRun) {
          const invoiceData = this.buildInvoiceData(order, saleOrder.partner_id[0], saleOrder, orderLines);

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
        const invoice = await this.createInvoice(order, saleOrder.partner_id[0], saleOrder, orderLines);
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
   * @param {object} vcsOrder - The VCS order data
   * @returns {object|null} { saleOrder, orderLines } or null if not found
   */
  async findOdooOrder(vcsOrder) {
    const amazonOrderId = vcsOrder.orderId;

    // Search for sale.order by client_order_ref (Amazon order ID)
    const orders = await this.odoo.searchRead('sale.order',
      [['client_order_ref', '=', amazonOrderId]],
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
   * Mark order as skipped
   * @param {ObjectId} orderId
   * @param {string} reason
   */
  async markOrderSkipped(orderId, reason) {
    const db = getDb();
    await db.collection('amazon_vcs_orders').updateOne(
      { _id: orderId },
      {
        $set: {
          status: 'skipped',
          skipReason: reason,
          skippedAt: new Date(),
        }
      }
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
   * Determine the correct partner for the invoice
   * ALWAYS inherit the partner from the sale order to ensure proper linking
   * (so qty_invoiced updates correctly on the sale order)
   * @param {object} order - VCS order data
   * @param {object} saleOrder - Odoo sale.order
   * @returns {number} Partner ID
   */
  determinePartner(order, saleOrder) {
    // Always use the sale order's partner to maintain proper order-invoice linking
    // This ensures qty_invoiced is updated on the sale order
    return saleOrder.partner_id[0];
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
   * Build invoice data from VCS order
   * @param {object} order - VCS order data
   * @param {number} partnerId - Odoo partner ID (may be overridden for OSS)
   * @param {object} saleOrder - Odoo sale.order
   * @param {object[]} orderLines - Odoo sale.order.line records
   * @returns {object}
   */
  buildInvoiceData(order, partnerId, saleOrder, orderLines) {
    const invoiceDate = order.shipmentDate || order.orderDate;
    const fiscalPosition = this.determineFiscalPosition(order);
    const journalId = this.determineJournal(order);

    // Determine the correct partner (OSS orders use Amazon OSS partners)
    const invoicePartnerId = this.determinePartner(order, saleOrder);

    // VCS Invoice Number for reference fields
    const vcsInvoiceNumber = order.vatInvoiceNumber || null;

    // Determine sales team based on marketplace (NOT inherited from order)
    const teamId = this.determineSalesTeam(order);

    return {
      move_type: 'out_invoice',
      partner_id: invoicePartnerId,
      invoice_date: this.formatDate(invoiceDate),
      // ref: VCS invoice number (shown in "Customer Reference" in Odoo)
      ref: vcsInvoiceNumber || order.orderId,
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
   * @param {object} order
   * @returns {number|null} Fiscal position ID
   */
  determineFiscalPosition(order) {
    // Export orders use the export fiscal position directly (ID 3)
    // This ensures proper VAT grid mapping (Grid 47) for exports
    if (this.isExportOrder(order)) {
      return EXPORT_FISCAL_POSITION_ID; // BE*VAT | Régime Extra-Communautaire
    }

    // OSS scheme (selling from BE to other EU countries)
    // Use the hardcoded OSS fiscal position IDs
    if (order.taxReportingScheme === 'VCS_EU_OSS') {
      const country = order.shipToCountry;
      const ossFiscalPositionId = OSS_FISCAL_POSITIONS[country];
      if (ossFiscalPositionId) {
        return ossFiscalPositionId;
      }
      console.warn(`[VcsOdooInvoicer] No OSS fiscal position for country ${country}`);
    }

    // B2B with buyer VAT number - use Intra-Community B2B fiscal position
    if (order.buyerTaxRegistration) {
      // Look up from cache if available
      return this.fiscalPositionCache?.['B2B_EU'] || null;
    }

    // Domestic Belgian sale - no special fiscal position needed
    // The default Belgian VAT will apply

    return null;
  }

  /**
   * Determine journal based on marketplace
   * @param {object} order
   * @returns {number|null}
   */
  determineJournal(order) {
    // For OSS orders (EU cross-border B2C), use the OSS journal
    if (order.taxReportingScheme === 'VCS_EU_OSS') {
      const journalCode = MARKETPLACE_JOURNALS['OSS'];
      return this.journalCache?.[journalCode] || this.defaultJournalId || null;
    }

    // Check if this is an export (destination outside EU)
    const isExport = this.isExportOrder(order);
    if (isExport) {
      const journalCode = MARKETPLACE_JOURNALS['EXPORT']; // VEX
      return this.journalCache?.[journalCode] || this.defaultJournalId || null;
    }

    // Use shipToCountry (destination) to determine the VAT jurisdiction journal
    const country = order.shipToCountry || order.sellerTaxJurisdiction || 'BE';
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
    const invoiceId = await this.odoo.create('account.move', {
      move_type: 'out_invoice',
      partner_id: saleOrder.partner_id[0],
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

    console.log(`[VcsOdooInvoicer] Invoice ${invoice[0]?.name} updated. Total: ${invoice[0]?.amount_total}, Tax: ${invoice[0]?.amount_tax}`);

    return {
      id: invoiceId,
      name: invoice[0]?.name || `INV-${invoiceId}`,
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
  async updateInvoiceFromVCS(invoiceId, order, orderLines) {
    // Determine VCS-based settings
    const fiscalPositionId = this.determineFiscalPosition(order);
    const journalId = this.determineJournal(order);
    const teamId = this.determineSalesTeam(order);
    const vcsInvoiceNumber = order.vatInvoiceNumber || null;
    const invoiceDate = order.shipmentDate || order.orderDate;

    // Update invoice header
    const headerUpdate = {
      invoice_date: this.formatDate(invoiceDate),
      ref: vcsInvoiceNumber || order.orderId,
      payment_reference: vcsInvoiceNumber || null,
    };

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
    const invoiceLines = await this.odoo.searchRead('account.move.line',
      [['move_id', '=', invoiceId], ['display_type', '=', false], ['product_id', '!=', false]],
      ['id', 'product_id', 'name', 'quantity', 'price_unit']
    );

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

    // Get the correct tax for OSS orders
    const isOSS = order.taxReportingScheme === 'VCS_EU_OSS';
    const ossTaxId = isOSS ? this.getOssTaxId(order) : null;

    // Match VCS items to invoice lines and update
    for (const vcsItem of order.items) {
      const transformedSku = this.transformSku(vcsItem.sku);

      // Find matching invoice line by product SKU
      const matchingLine = invoiceLines.find(line => {
        const lineSku = productSkuMap[line.product_id[0]] || '';
        return lineSku === transformedSku || lineSku === vcsItem.sku;
      });

      if (matchingLine) {
        const lineUpdate = {
          quantity: vcsItem.quantity,
          price_unit: vcsItem.priceExclusive / vcsItem.quantity,
        };

        // Set correct OSS tax
        if (isOSS && ossTaxId) {
          lineUpdate.tax_ids = [[6, 0, [ossTaxId]]];
        }

        await this.odoo.execute('account.move.line', 'write', [[matchingLine.id], lineUpdate]);
        console.log(`[VcsOdooInvoicer] Updated line ${matchingLine.id}: qty=${vcsItem.quantity}, price=${lineUpdate.price_unit}`);
      } else {
        console.warn(`[VcsOdooInvoicer] No matching invoice line for VCS SKU ${vcsItem.sku} (transformed: ${transformedSku})`);
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
        if (isOSS && ossTaxId) {
          shippingUpdate.tax_ids = [[6, 0, [ossTaxId]]];
        }
        await this.odoo.execute('account.move.line', 'write', [[shippingLine.id], shippingUpdate]);
        console.log(`[VcsOdooInvoicer] Updated shipping line: price=${order.totalShipping}`);
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
        if (isOSS && ossTaxId) {
          discountUpdate.tax_ids = [[6, 0, [ossTaxId]]];
        }
        await this.odoo.execute('account.move.line', 'write', [[shippingDiscountLine.id], discountUpdate]);
        console.log(`[VcsOdooInvoicer] Updated shipping discount line: price=-${Math.abs(order.totalShippingPromo)}`);
      }
    }

    // Recompute the invoice totals after all changes
    await this.odoo.execute('account.move', '_compute_amount', [[invoiceId]]);
  }

  /**
   * Load and cache fiscal positions, journals, and currencies from Odoo
   */
  async loadCache() {
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

module.exports = { VcsOdooInvoicer, MARKETPLACE_JOURNALS, FISCAL_POSITIONS, SKU_TRANSFORMATIONS };
