/**
 * VCS Odoo Invoicer
 *
 * Creates customer invoices in Odoo from Amazon VCS Tax Report data.
 * Handles VAT, OSS, and B2B scenarios for EU sales.
 */

const { getDb } = require('../../db');
const { ObjectId } = require('mongodb');

// Marketplace to journal mapping
const MARKETPLACE_JOURNALS = {
  'DE': 'AMZN-DE',
  'FR': 'AMZN-FR',
  'IT': 'AMZN-IT',
  'ES': 'AMZN-ES',
  'NL': 'AMZN-NL',
  'BE': 'AMZN-BE',
  'PL': 'AMZN-PL',
  'SE': 'AMZN-SE',
  'GB': 'AMZN-UK',
  // Default
  'DEFAULT': 'AMZN',
};

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
   * Create invoices in Odoo for pending VCS orders
   * @param {object} options
   * @param {number} options.limit - Max orders to process
   * @param {boolean} options.dryRun - If true, don't create invoices
   * @returns {object} Results
   */
  async createInvoices(options = {}) {
    const { limit = 50, dryRun = false } = options;
    const db = getDb();

    const result = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [],
      invoices: [],
    };

    // Get pending orders
    const orders = await db.collection('amazon_vcs_orders')
      .find({ status: 'pending' })
      .sort({ orderDate: 1 })
      .limit(limit)
      .toArray();

    if (orders.length === 0) {
      return { ...result, message: 'No pending orders' };
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

        if (dryRun) {
          result.invoices.push({
            orderId: order.orderId,
            dryRun: true,
            wouldCreate: this.buildInvoiceData(order, partnerId),
          });
          continue;
        }

        // Create invoice
        const invoice = await this.createInvoice(order, partnerId);
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
    // Skip deemed reseller (Amazon handles VAT)
    if (order.taxReportingScheme === 'DEEMED_RESELLER') {
      return true;
    }

    // Skip Swiss low-value (Amazon handles)
    if (order.taxReportingScheme === 'CH_VOEC') {
      return true;
    }

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
   * @param {object} order
   * @param {number} partnerId
   * @returns {object}
   */
  buildInvoiceData(order, partnerId) {
    const invoiceDate = order.shipmentDate || order.orderDate;
    const fiscalPosition = this.determineFiscalPosition(order);
    const journalId = this.determineJournal(order);

    return {
      move_type: 'out_invoice',
      partner_id: partnerId,
      invoice_date: this.formatDate(invoiceDate),
      ref: order.orderId,
      narration: `Amazon Order: ${order.orderId}\nVAT Invoice: ${order.vatInvoiceNumber || 'N/A'}`,
      currency_id: this.getCurrencyId(order.currency),
      fiscal_position_id: fiscalPosition,
      journal_id: journalId,
      invoice_line_ids: this.buildInvoiceLines(order),
    };
  }

  /**
   * Build invoice lines from order items
   * @param {object} order
   * @returns {Array}
   */
  buildInvoiceLines(order) {
    const lines = [];

    for (const item of order.items) {
      // Product line
      lines.push([0, 0, {
        name: `${item.sku} (ASIN: ${item.asin})`,
        quantity: item.quantity,
        price_unit: item.priceExclusive / item.quantity,
        // Tax will be determined by fiscal position
      }]);

      // Promo discount if any
      if (item.promoAmount && item.promoAmount !== 0) {
        lines.push([0, 0, {
          name: `Promotion discount - ${item.sku}`,
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
    let positionName = null;

    // OSS scheme (selling from BE to other EU countries)
    if (order.taxReportingScheme === 'VCS_EU_OSS') {
      positionName = `OSS_${order.shipToCountry}`;
    }
    // B2B with buyer VAT number
    else if (order.buyerTaxRegistration) {
      positionName = 'B2B_EU';
    }
    // Export outside EU
    else if (order.exportOutsideEu) {
      positionName = 'EXPORT';
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
    // Extract country from marketplace ID or seller jurisdiction
    const country = order.sellerTaxJurisdiction || order.marketplaceId?.substring(0, 2);
    const journalCode = MARKETPLACE_JOURNALS[country] || MARKETPLACE_JOURNALS['DEFAULT'];

    // Look up journal ID (would need to cache these)
    return this.journalCache?.[journalCode] || this.defaultJournalId || null;
  }

  /**
   * Create invoice in Odoo
   * @param {object} order
   * @param {number} partnerId
   * @returns {object}
   */
  async createInvoice(order, partnerId) {
    const invoiceData = this.buildInvoiceData(order, partnerId);

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
    for (const fp of fiscalPositions) {
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
    for (const j of journals) {
      this.journalCache[j.code] = j.id;
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

module.exports = { VcsOdooInvoicer, MARKETPLACE_JOURNALS, FISCAL_POSITIONS };
