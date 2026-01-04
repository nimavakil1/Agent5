/**
 * Amazon VCS Invoice Importer Service
 *
 * Imports Amazon VCS (VAT Calculation Service) transaction data into Odoo as invoices.
 *
 * VCS provides VAT-compliant invoice data for Amazon orders, including:
 * - Ship-from country (determines journal and VAT registration)
 * - Buyer country (determines fiscal position)
 * - B2B vs B2C (determines if reverse charge applies)
 * - VAT rates and amounts
 *
 * Flow:
 * 1. Receive VCS transaction data from Make.com webhook
 * 2. Parse and validate transactions
 * 3. Determine journal, fiscal position, and taxes
 * 4. Create invoice in Odoo with correct VAT handling
 */

const { getDb } = require('../../db');
const { skuResolver } = require('./SkuResolver');
const { euCountryConfig } = require('./EuCountryConfig');

class VcsInvoiceImporter {
  constructor(odooClient) {
    this.odoo = odooClient;
    this.db = null;
    this.taxCache = new Map();
    this.journalCache = new Map();
    this.fiscalPositionCache = new Map();
    this.customerCache = new Map();
  }

  /**
   * Initialize the importer
   */
  async init() {
    this.db = getDb();
    if (!skuResolver.loaded) {
      await skuResolver.load();
    }
    await this.loadCaches();
  }

  /**
   * Load Odoo lookup caches for performance
   */
  async loadCaches() {
    // Load taxes
    const taxes = await this.odoo.searchRead('account.tax', [
      ['type_tax_use', '=', 'sale']
    ], { fields: ['id', 'name', 'amount', 'price_include'] });

    for (const tax of taxes) {
      this.taxCache.set(tax.name, tax);
    }

    // Load sales journals
    const journals = await this.odoo.searchRead('account.journal', [
      ['type', '=', 'sale']
    ], { fields: ['id', 'name', 'code'] });

    for (const journal of journals) {
      this.journalCache.set(journal.code, journal);
    }

    // Load fiscal positions
    const fps = await this.odoo.searchRead('account.fiscal.position', [],
      { fields: ['id', 'name'] });

    for (const fp of fps) {
      this.fiscalPositionCache.set(fp.name, fp);
    }

    console.log(`[VcsInvoiceImporter] Loaded ${this.taxCache.size} taxes, ${this.journalCache.size} journals, ${this.fiscalPositionCache.size} fiscal positions`);
  }

  /**
   * Parse VCS report content (tab-separated or JSON)
   * @param {string|object} content - Raw report content
   * @returns {object[]} Parsed transactions
   */
  parseVcsReport(content) {
    // If already parsed JSON
    if (typeof content === 'object') {
      return Array.isArray(content) ? content : [content];
    }

    // Parse TSV format (Amazon's default)
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];

    const delimiter = lines[0].includes('\t') ? '\t' : ',';
    const headers = lines[0].split(delimiter).map(h => this.normalizeHeader(h));

    const transactions = [];
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(delimiter);
      const row = {};

      headers.forEach((header, idx) => {
        let value = values[idx]?.trim() || '';
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        row[header] = value;
      });

      // Only include actual sales (not refunds in this pass)
      if (row.transactionType === 'SHIPMENT' || row.transactionType === 'SALE') {
        transactions.push(row);
      }
    }

    return transactions;
  }

  /**
   * Normalize header names to camelCase
   */
  normalizeHeader(header) {
    return header.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+(.)/g, (m, chr) => chr.toUpperCase())
      .replace(/[^a-z0-9]/g, '');
  }

  /**
   * Import a single VCS transaction as an Odoo invoice
   * @param {object} transaction - VCS transaction data
   * @returns {object} Import result
   */
  async importTransaction(transaction) {
    const result = {
      success: false,
      amazonOrderId: transaction.amazonOrderId || transaction.orderId,
      invoiceNumber: transaction.vatInvoiceNumber || transaction.invoiceNumber,
      odooInvoiceId: null,
      odooInvoiceName: null,
      errors: [],
      warnings: []
    };

    try {
      // Check if invoice already exists
      const existingInvoice = await this.findExistingInvoice(result.amazonOrderId, result.invoiceNumber);
      if (existingInvoice) {
        result.success = true;
        result.odooInvoiceId = existingInvoice.id;
        result.odooInvoiceName = existingInvoice.name;
        result.warnings.push('Invoice already exists in Odoo');
        return result;
      }

      // Determine configuration based on VCS data
      const config = this.getInvoiceConfig(transaction);

      // Find or create customer
      const partnerId = await this.findOrCreateCustomer(transaction, config);

      // Find journal
      const journalId = await this.findJournal(config.journalCode);
      if (!journalId) {
        result.errors.push(`Journal not found: ${config.journalCode}`);
        return result;
      }

      // Find fiscal position
      const fiscalPositionId = await this.findFiscalPosition(config.fiscalPosition);

      // Prepare invoice lines
      const invoiceLines = await this.prepareInvoiceLines(transaction, config);
      if (invoiceLines.errors.length > 0) {
        result.errors.push(...invoiceLines.errors);
      }
      if (invoiceLines.lines.length === 0) {
        result.errors.push('No valid invoice lines');
        return result;
      }

      // Create invoice
      const invoiceData = {
        move_type: 'out_invoice',
        partner_id: partnerId,
        journal_id: journalId,
        fiscal_position_id: fiscalPositionId,
        invoice_date: transaction.transactionDate || transaction.invoiceDate,
        ref: result.amazonOrderId,
        narration: `Amazon Order: ${result.amazonOrderId}\nVCS Invoice: ${result.invoiceNumber || 'N/A'}`,
        invoice_line_ids: invoiceLines.lines.map(line => [0, 0, line]),
        // Custom fields for Amazon tracking
        x_amazon_order_id: result.amazonOrderId,
        x_amazon_invoice_number: result.invoiceNumber,
        x_amazon_marketplace: transaction.marketplaceId,
        x_amazon_ship_from: config.shipFromCountry,
      };

      const invoiceId = await this.odoo.create('account.move', invoiceData);

      result.success = true;
      result.odooInvoiceId = invoiceId;
      result.config = config;
      result.linesCreated = invoiceLines.lines.length;

      // Get invoice name
      const invoice = await this.odoo.read('account.move', invoiceId, ['name']);
      result.odooInvoiceName = invoice.name;

      // Log import
      await this.logImport(result, transaction);

      return result;
    } catch (error) {
      result.errors.push(error.message);
      await this.logImport(result, transaction, error);
      return result;
    }
  }

  /**
   * Determine invoice configuration from VCS transaction
   */
  getInvoiceConfig(transaction) {
    // Extract key fields from VCS data
    const shipFromCountry = transaction.shipFromCountry ||
                           transaction.departureCountry ||
                           transaction.sellerVatCountry ||
                           'BE';

    const buyerCountry = transaction.shipToCountry ||
                        transaction.arrivalCountry ||
                        transaction.buyerCountry ||
                        transaction.destinationCountry ||
                        shipFromCountry;

    const buyerVat = transaction.buyerVatNumber ||
                    transaction.customerVatNumber ||
                    transaction.vatNumber ||
                    null;

    const isB2B = !!buyerVat && buyerVat.length > 5;

    // Use EuCountryConfig for consistent logic
    const invoiceConfig = euCountryConfig.getInvoiceConfig({
      marketplaceId: transaction.marketplaceId,
      fulfillmentCenter: transaction.fulfillmentCenter,
      buyerCountry,
      buyerVat
    });

    // Override with VCS-specific ship-from if available
    if (shipFromCountry) {
      invoiceConfig.shipFromCountry = shipFromCountry.toUpperCase();
      invoiceConfig.journalCode = euCountryConfig.getJournalCode(shipFromCountry);
      invoiceConfig.fiscalPosition = euCountryConfig.getFiscalPosition(
        shipFromCountry,
        buyerCountry,
        isB2B
      );
    }

    // Determine if prices include VAT (Amazon usually includes VAT)
    invoiceConfig.priceIncludesVat = transaction.priceType === 'GROSS' ||
                                     transaction.taxIncluded === 'true' ||
                                     transaction.taxIncluded === true ||
                                     true; // Default to VAT included for Amazon

    return invoiceConfig;
  }

  /**
   * Prepare invoice lines from VCS transaction items
   */
  async prepareInvoiceLines(transaction, config) {
    const lines = [];
    const errors = [];

    // VCS may have items as array or single item
    const items = transaction.items ||
                 transaction.lineItems ||
                 (transaction.sku ? [transaction] : []);

    for (const item of items) {
      try {
        const sku = item.sellerSku || item.sku || item.productSku;

        // Resolve SKU if we have one
        let productId = null;
        if (sku) {
          const resolved = skuResolver.resolve(sku);
          if (resolved.odooSku) {
            productId = await this.findProduct(resolved.odooSku);
          }
        }

        // Get amounts
        const quantity = parseFloat(item.quantity) || 1;
        const totalAmount = parseFloat(item.totalAmount || item.itemPrice || item.amount) || 0;
        const vatAmount = parseFloat(item.vatAmount || item.taxAmount || item.vat) || 0;
        const vatRate = parseFloat(item.vatRate || item.taxRate) || 0;

        // Calculate unit price
        let unitPrice;
        if (config.priceIncludesVat) {
          unitPrice = totalAmount / quantity;
        } else {
          unitPrice = (totalAmount - vatAmount) / quantity;
        }

        // Find appropriate tax
        const taxId = await this.findTax(config.shipFromCountry, vatRate, config.priceIncludesVat, config.isB2B);

        const line = {
          product_id: productId,
          name: item.productName || item.title || item.description || sku || 'Amazon Sale',
          quantity: quantity,
          price_unit: unitPrice,
          tax_ids: taxId ? [[6, 0, [taxId]]] : [[6, 0, []]],
          // Custom fields
          x_amazon_sku: sku,
          x_amazon_asin: item.asin,
        };

        lines.push(line);
      } catch (error) {
        errors.push(`Error processing item ${item.sellerSku || 'unknown'}: ${error.message}`);
      }
    }

    // If no items but we have totals, create a single line
    if (lines.length === 0 && (transaction.totalAmount || transaction.itemPrice)) {
      const totalAmount = parseFloat(transaction.totalAmount || transaction.itemPrice) || 0;
      const vatRate = parseFloat(transaction.vatRate || transaction.taxRate) || 0;
      const taxId = await this.findTax(config.shipFromCountry, vatRate, config.priceIncludesVat, config.isB2B);

      lines.push({
        name: `Amazon Order ${transaction.amazonOrderId || transaction.orderId}`,
        quantity: 1,
        price_unit: totalAmount,
        tax_ids: taxId ? [[6, 0, [taxId]]] : [[6, 0, []]],
      });
    }

    return { lines, errors };
  }

  /**
   * Find tax by country, rate, and include type
   */
  async findTax(countryCode, vatRate, priceIncludesVat, _isB2B) {
    const country = countryCode?.toUpperCase() || 'BE';
    const rate = Math.round(vatRate * 10) / 10; // Round to 1 decimal
    const includeStr = priceIncludesVat ? 'Included' : '';

    // Build possible tax name patterns
    const patterns = [];

    if (euCountryConfig.hasVatRegistration(country)) {
      // Country with VAT registration
      if (includeStr) {
        patterns.push(`${country}*VAT | ${rate}% Included`);
        patterns.push(`${country}*VAT | ${rate}.0% Included`);
      }
      patterns.push(`${country}*VAT | ${rate}%`);
      patterns.push(`${country}*VAT | ${rate}.0%`);
    } else {
      // OSS country
      if (includeStr) {
        patterns.push(`${country}*OSS | ${rate}% Included`);
        patterns.push(`${country}*OSS | ${rate}.0% Included`);
      }
      patterns.push(`${country}*OSS | ${rate}%`);
      patterns.push(`${country}*OSS | ${rate}.0%`);
    }

    // Also check BE*OSS for fallback
    if (country !== 'BE' && !euCountryConfig.hasVatRegistration(country)) {
      patterns.push(`BE*OSS | ${rate}%`);
    }

    // Search cache first
    for (const pattern of patterns) {
      const tax = this.taxCache.get(pattern);
      if (tax) {
        return tax.id;
      }
    }

    // Search with partial match if exact not found
    for (const [name, tax] of this.taxCache) {
      if (name.includes(`${country}*`) && name.includes(`${rate}%`)) {
        if (priceIncludesVat && name.includes('Included')) {
          return tax.id;
        } else if (!priceIncludesVat && !name.includes('Included')) {
          return tax.id;
        }
      }
    }

    // Return null if no match (Odoo will use default)
    return null;
  }

  /**
   * Find existing invoice by Amazon order ID or invoice number
   */
  async findExistingInvoice(amazonOrderId, invoiceNumber) {
    const conditions = [];
    if (amazonOrderId) {
      conditions.push(['ref', '=', amazonOrderId]);
    }
    if (invoiceNumber) {
      conditions.push(['x_amazon_invoice_number', '=', invoiceNumber]);
    }

    if (conditions.length === 0) return null;

    // Use OR for multiple conditions
    const domain = conditions.length > 1
      ? ['|', ...conditions]
      : conditions;

    const invoices = await this.odoo.search('account.move', domain, { limit: 1 });
    if (invoices.length > 0) {
      return await this.odoo.read('account.move', invoices[0], ['id', 'name']);
    }
    return null;
  }

  /**
   * Find or create customer
   */
  async findOrCreateCustomer(transaction, config) {
    // For B2C, use generic country customer
    if (!config.isB2B) {
      const genericName = config.genericCustomer;

      // Check cache
      if (this.customerCache.has(genericName)) {
        return this.customerCache.get(genericName);
      }

      const existing = await this.odoo.search('res.partner', [
        ['name', '=', genericName]
      ], { limit: 1 });

      if (existing.length > 0) {
        this.customerCache.set(genericName, existing[0]);
        return existing[0];
      }

      // Create generic customer
      const countryId = await this.getCountryId(config.buyerCountry);
      const partnerId = await this.odoo.create('res.partner', {
        name: genericName,
        company_type: 'company',
        customer_rank: 1,
        country_id: countryId,
        is_company: true
      });

      this.customerCache.set(genericName, partnerId);
      return partnerId;
    }

    // For B2B, find or create by VAT
    const vatNumber = transaction.buyerVatNumber || transaction.customerVatNumber;
    if (vatNumber) {
      const byVat = await this.odoo.search('res.partner', [
        ['vat', '=', vatNumber]
      ], { limit: 1 });

      if (byVat.length > 0) {
        return byVat[0];
      }
    }

    // Create B2B customer
    const companyName = transaction.buyerName ||
                       transaction.customerName ||
                       `Amazon B2B - ${transaction.amazonOrderId || transaction.orderId}`;

    const countryId = await this.getCountryId(config.buyerCountry);
    return await this.odoo.create('res.partner', {
      name: companyName,
      company_type: 'company',
      customer_rank: 1,
      vat: vatNumber,
      country_id: countryId,
      street: transaction.buyerAddress || transaction.shipToAddress,
      city: transaction.buyerCity || transaction.shipToCity,
      zip: transaction.buyerPostalCode || transaction.shipToPostalCode,
      is_company: true
    });
  }

  /**
   * Find product by Odoo SKU
   */
  async findProduct(odooSku) {
    const products = await this.odoo.search('product.product', [
      ['default_code', '=', odooSku]
    ], { limit: 1 });
    return products.length > 0 ? products[0] : null;
  }

  /**
   * Find journal by code
   */
  async findJournal(journalCode) {
    const journal = this.journalCache.get(journalCode);
    if (journal) return journal.id;

    // Try database
    const journals = await this.odoo.search('account.journal', [
      ['code', '=', journalCode],
      ['type', '=', 'sale']
    ], { limit: 1 });

    return journals.length > 0 ? journals[0] : null;
  }

  /**
   * Find fiscal position by name
   */
  async findFiscalPosition(fiscalPositionName) {
    // Try exact match in cache
    const fp = this.fiscalPositionCache.get(fiscalPositionName);
    if (fp) return fp.id;

    // Try partial match
    for (const [name, fpData] of this.fiscalPositionCache) {
      if (name.includes(fiscalPositionName.split('|')[0].trim())) {
        return fpData.id;
      }
    }

    return null;
  }

  /**
   * Get country ID from code
   */
  async getCountryId(countryCode) {
    const countries = await this.odoo.search('res.country', [
      ['code', '=', countryCode?.toUpperCase()]
    ], { limit: 1 });
    return countries.length > 0 ? countries[0] : null;
  }

  /**
   * Log import to database
   */
  async logImport(result, transaction, error = null) {
    if (!this.db) return;

    try {
      await this.db.collection('amazon_vcs_imports').insertOne({
        amazonOrderId: result.amazonOrderId,
        invoiceNumber: result.invoiceNumber,
        odooInvoiceId: result.odooInvoiceId,
        odooInvoiceName: result.odooInvoiceName,
        success: result.success,
        errors: result.errors,
        warnings: result.warnings,
        config: result.config,
        rawTransaction: transaction,
        error: error ? error.message : null,
        importedAt: new Date()
      });
    } catch (logError) {
      console.error('[VcsInvoiceImporter] Failed to log import:', logError);
    }
  }

  /**
   * Bulk import VCS transactions
   * @param {object[]} transactions - Array of VCS transactions
   * @returns {object} { imported, failed, results }
   */
  async importTransactions(transactions) {
    const results = [];
    let imported = 0;
    let failed = 0;

    for (const transaction of transactions) {
      const result = await this.importTransaction(transaction);
      results.push(result);

      if (result.success) {
        imported++;
      } else {
        failed++;
      }
    }

    return { imported, failed, total: transactions.length, results };
  }

  /**
   * Import from VCS report content
   * @param {string|object} reportContent - Raw report content
   * @returns {object} Import results
   */
  async importFromReport(reportContent) {
    const transactions = this.parseVcsReport(reportContent);
    console.log(`[VcsInvoiceImporter] Parsed ${transactions.length} transactions from report`);
    return await this.importTransactions(transactions);
  }

  /**
   * Get import statistics
   */
  async getStats(days = 30) {
    if (!this.db) return null;

    const since = new Date();
    since.setDate(since.getDate() - days);

    const stats = await this.db.collection('amazon_vcs_imports').aggregate([
      { $match: { importedAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          success: { $sum: { $cond: ['$success', 1, 0] } },
          failed: { $sum: { $cond: ['$success', 0, 1] } }
        }
      }
    ]).toArray();

    return stats[0] || { total: 0, success: 0, failed: 0 };
  }
}

module.exports = { VcsInvoiceImporter };
