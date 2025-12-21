/**
 * VCS Odoo Invoicer
 *
 * Creates customer invoices in Odoo from Amazon VCS Tax Report data.
 * Handles VAT, OSS, and B2B scenarios for EU sales.
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

// Country to fiscal position mapping
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
      ['id', 'name', 'client_order_ref', 'order_line', 'partner_id', 'state']
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
   * Build invoice data from VCS order
   * @param {object} order - VCS order data
   * @param {number} partnerId - Odoo partner ID
   * @param {object} saleOrder - Odoo sale.order
   * @param {object[]} orderLines - Odoo sale.order.line records
   * @returns {object}
   */
  buildInvoiceData(order, partnerId, saleOrder, orderLines) {
    const invoiceDate = order.shipmentDate || order.orderDate;
    const fiscalPosition = this.determineFiscalPosition(order);
    const journalId = this.determineJournal(order);

    return {
      move_type: 'out_invoice',
      partner_id: partnerId,
      invoice_date: this.formatDate(invoiceDate),
      ref: order.orderId,
      invoice_origin: saleOrder.name, // Link to sale order
      narration: `Amazon Order: ${order.orderId}\nSale Order: ${saleOrder.name}\nVAT Invoice: ${order.vatInvoiceNumber || 'N/A'}`,
      currency_id: this.getCurrencyId(order.currency),
      fiscal_position_id: fiscalPosition,
      journal_id: journalId,
      invoice_line_ids: this.buildInvoiceLines(order, orderLines),
    };
  }

  /**
   * Build invoice lines from VCS order, using products from Odoo order
   * @param {object} order - VCS order data
   * @param {object[]} odooOrderLines - Odoo sale.order.line records
   * @returns {Array}
   */
  buildInvoiceLines(order, odooOrderLines) {
    const lines = [];

    for (const item of order.items) {
      // Find matching Odoo order line by SKU
      const transformedSku = this.transformSku(item.sku);
      const odooLine = odooOrderLines.find(line => {
        const lineSku = line.product_default_code || '';
        return lineSku === transformedSku || lineSku === item.sku;
      });

      if (odooLine && odooLine.product_id) {
        // Use product from Odoo order - show VCS SKU → Odoo SKU
        const odooSku = odooLine.product_default_code || transformedSku;
        const skuDisplay = item.sku !== odooSku ? `${item.sku} → ${odooSku}` : odooSku;
        lines.push([0, 0, {
          product_id: odooLine.product_id[0],
          name: `${skuDisplay} (ASIN: ${item.asin})`,
          quantity: item.quantity,
          price_unit: item.priceExclusive / item.quantity,
          // Tax will be determined by fiscal position + product tax settings
        }]);
      } else {
        // Fallback: no matching product found, use text-only line
        console.warn(`[VcsOdooInvoicer] No matching product for SKU ${item.sku} (transformed: ${transformedSku})`);
        const skuDisplay = item.sku !== transformedSku ? `${item.sku} → ${transformedSku}` : transformedSku;
        lines.push([0, 0, {
          name: `${skuDisplay} (ASIN: ${item.asin}) - PRODUCT NOT FOUND`,
          quantity: item.quantity,
          price_unit: item.priceExclusive / item.quantity,
        }]);
      }

      // Promo discount if any
      if (item.promoAmount && item.promoAmount !== 0) {
        const discountSku = odooLine?.product_default_code || transformedSku;
        lines.push([0, 0, {
          name: `Promotion discount - ${discountSku}`,
          quantity: 1,
          price_unit: -Math.abs(item.promoAmount),
        }]);
      }
    }

    // Shipping line if any
    if (order.totalShipping > 0) {
      lines.push([0, 0, {
        name: 'Shipping',
        quantity: 1,
        price_unit: order.totalShipping,
      }]);
    }

    return lines;
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

    let positionName = null;

    // OSS scheme (selling from BE to other EU countries)
    if (order.taxReportingScheme === 'VCS_EU_OSS') {
      positionName = `OSS_${order.shipToCountry}`;
    }
    // B2B with buyer VAT number
    else if (order.buyerTaxRegistration) {
      positionName = 'B2B_EU';
    }
    // Domestic Belgian sale
    else if (order.shipToCountry === 'BE' && order.sellerTaxJurisdiction === 'BE') {
      positionName = 'DOMESTIC_BE';
    }

    if (!positionName) {
      return null;
    }

    // Look up fiscal position ID (would need to cache these)
    return this.fiscalPositionCache?.[positionName] || null;
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
   * Create invoice in Odoo
   * @param {object} order - VCS order data
   * @param {number} partnerId - Odoo partner ID
   * @param {object} saleOrder - Odoo sale.order
   * @param {object[]} orderLines - Odoo sale.order.line records
   * @returns {object}
   */
  async createInvoice(order, partnerId, saleOrder, orderLines) {
    const invoiceData = this.buildInvoiceData(order, partnerId, saleOrder, orderLines);

    // Create invoice
    const invoiceId = await this.odoo.create('account.move', invoiceData);

    // Get invoice name
    const invoice = await this.odoo.searchRead('account.move',
      [['id', '=', invoiceId]],
      ['name', 'amount_total', 'amount_tax']
    );

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
