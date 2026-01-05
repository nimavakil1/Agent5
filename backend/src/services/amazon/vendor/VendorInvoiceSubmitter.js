/**
 * VendorInvoiceSubmitter - Submit Invoices to Amazon Vendor Central
 *
 * Handles the invoice submission workflow for Vendor Central orders.
 * Takes Odoo invoice data and submits it to Amazon.
 *
 * Flow:
 * 1. Get PO from MongoDB
 * 2. Get invoice from Odoo (if linked)
 * 3. Map invoice data to Amazon format
 * 4. Submit to Amazon
 * 5. Track transaction status
 *
 * @module VendorInvoiceSubmitter
 */

const { getDb } = require('../../../db');
const { VendorClient } = require('./VendorClient');
const { getVendorPOImporter } = require('./VendorPOImporter');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { isTestMode, wrapWithTestMode } = require('./TestMode');

/**
 * Invoice types
 */
const INVOICE_TYPES = {
  INVOICE: 'Invoice',
  CREDIT_NOTE: 'CreditNote'
};

/**
 * ACROPAQ company info for remitToParty
 * Note: partyId 'C86K8' is ACROPAQ's Amazon vendor code
 *
 * IMPORTANT: Address and VAT must match Amazon Vendor Central records exactly.
 * Updated 2026-01-05 per Amazon EDI testing feedback (Vasu Keesara).
 */
const ACROPAQ_COMPANY = {
  partyId: 'C86K8',
  address: {
    name: 'ACROPAQ SA',
    addressLine1: 'RUE KONKEL 105',
    city: 'WOLUWE-SAINT-PIERRE',
    postalOrZipCode: '1150',
    countryCode: 'BE'
  },
  taxRegistrationDetails: [{
    taxRegistrationType: 'VAT',
    taxRegistrationNumber: 'BE0476248323'
  }]
};

/**
 * Amazon billing entities per marketplace
 * These are the correct billToParty values that Amazon requires
 * Updated 2026-01-05 per Amazon EDI testing feedback.
 */
const AMAZON_BILLING_ENTITIES = {
  // France - AMAZON EU SARL, SUCCURSALE FRANCAISE
  FR: {
    partyId: 'AMAZONFR',
    address: {
      name: 'AMAZON EU SARL, SUCCURSALE FRANCAISE',
      addressLine1: '67 BOULEVARD DU GENERAL LECLERC',
      city: 'CLICHY',
      postalOrZipCode: '92110',
      countryCode: 'FR'
    },
    taxRegistrationDetails: [{
      taxRegistrationType: 'VAT',
      taxRegistrationNumber: 'FR12487773327'
    }]
  },
  // Germany
  DE: {
    partyId: 'AMAZONDE',
    address: {
      name: 'Amazon EU S.a.r.l.',
      addressLine1: 'Marcel-Breuer-Str. 12',
      city: 'Muenchen',
      postalOrZipCode: '80807',
      countryCode: 'DE'
    },
    taxRegistrationDetails: [{
      taxRegistrationType: 'VAT',
      taxRegistrationNumber: 'DE814584193'
    }]
  },
  // Italy
  IT: {
    partyId: 'AMAZONIT',
    address: {
      name: 'Amazon EU S.a.r.l., Sede secondaria italiana',
      addressLine1: 'Via Cilea Longo 35',
      city: 'Milano',
      postalOrZipCode: '20151',
      countryCode: 'IT'
    },
    taxRegistrationDetails: [{
      taxRegistrationType: 'VAT',
      taxRegistrationNumber: 'IT09944691008'
    }]
  },
  // Spain
  ES: {
    partyId: 'AMAZONES',
    address: {
      name: 'AMAZON EU S.A R.L., SUCURSAL EN ESPANA',
      addressLine1: 'CALLE RAMIREZ DE PRADO, 5',
      city: 'MADRID',
      postalOrZipCode: '28045',
      countryCode: 'ES'
    },
    taxRegistrationDetails: [{
      taxRegistrationType: 'VAT',
      taxRegistrationNumber: 'ESW0184081H'
    }]
  },
  // Netherlands
  NL: {
    partyId: 'AMAZONNL',
    address: {
      name: 'Amazon EU S.a r.l., Dutch Branch',
      addressLine1: 'Herculesplein 25',
      city: 'Utrecht',
      postalOrZipCode: '3584 AA',
      countryCode: 'NL'
    }
  },
  // Belgium
  BE: {
    partyId: 'AMAZONBE',
    address: {
      name: 'Amazon EU S.a.r.l., Belgian Branch',
      addressLine1: 'Avenue des Arts 40',
      city: 'Brussels',
      postalOrZipCode: '1040',
      countryCode: 'BE'
    }
  },
  // UK (post-Brexit)
  GB: {
    partyId: 'AMAZONGB',
    address: {
      name: 'Amazon UK Services Ltd',
      addressLine1: '1 Principal Place',
      city: 'London',
      postalOrZipCode: 'EC2A 2FA',
      countryCode: 'GB'
    },
    taxRegistrationDetails: [{
      taxRegistrationType: 'VAT',
      taxRegistrationNumber: 'GB727255821'
    }]
  }
};

/**
 * MongoDB collection for tracking submitted invoices
 */
const INVOICE_COLLECTION = 'vendor_invoices';

class VendorInvoiceSubmitter {
  constructor(odooClient = null) {
    this.db = null;
    this.importer = null;
    this.odoo = odooClient || new OdooDirectClient();
    this.clients = {};
  }

  /**
   * Initialize the submitter
   */
  async init() {
    this.db = getDb();
    this.importer = await getVendorPOImporter();

    // Authenticate with Odoo
    if (!this.odoo.authenticated) {
      await this.odoo.authenticate();
    }

    // Ensure indexes
    await this.ensureIndexes();

    return this;
  }

  /**
   * Ensure MongoDB indexes exist
   */
  async ensureIndexes() {
    const collection = this.db.collection(INVOICE_COLLECTION);
    await collection.createIndexes([
      { key: { invoiceNumber: 1 }, unique: true },
      { key: { purchaseOrderNumber: 1 } },
      { key: { odooInvoiceId: 1 } },
      { key: { status: 1 } },
      { key: { submittedAt: -1 } }
    ]);
  }

  /**
   * Get or create VendorClient for marketplace
   * Wraps with test mode support when test mode is enabled
   */
  getClient(marketplace) {
    const cacheKey = `${marketplace}_${isTestMode() ? 'test' : 'prod'}`;
    if (!this.clients[cacheKey]) {
      const client = new VendorClient(marketplace);
      // Wrap with test mode support
      this.clients[cacheKey] = wrapWithTestMode(client);
    }
    return this.clients[cacheKey];
  }

  /**
   * Submit invoice for a PO
   *
   * @param {string} poNumber - Purchase order number
   * @param {Object} options - Submission options
   * @param {number} options.odooInvoiceId - Specific Odoo invoice ID (optional)
   * @param {boolean} options.dryRun - If true, don't submit to Amazon
   * @param {boolean} options.skipValidation - If true, skip validation checks
   * @param {boolean} options.forceSubmit - If true, submit even with validation warnings
   * @returns {Object} Result with success status and transaction ID
   */
  async submitInvoice(poNumber, options = {}) {
    const { odooInvoiceId = null, dryRun = false, skipValidation = false, forceSubmit = false } = options;

    const result = {
      success: false,
      purchaseOrderNumber: poNumber,
      invoiceNumber: null,
      transactionId: null,
      validation: null,
      errors: [],
      warnings: []
    };

    try {
      // Get PO from MongoDB
      const po = await this.importer.getPurchaseOrder(poNumber);
      if (!po) {
        result.errors.push(`PO not found: ${poNumber}`);
        return result;
      }

      // Check if PO is acknowledged (either locally or by Amazon)
      const isAcknowledged = po.acknowledgment?.acknowledged || po.purchaseOrderState === 'Acknowledged';
      if (!isAcknowledged) {
        result.errors.push('PO must be acknowledged before invoicing');
        return result;
      }

      // Check if already invoiced
      const existingInvoice = await this.findExistingInvoice(poNumber);
      if (existingInvoice && existingInvoice.status === 'submitted') {
        result.success = true;
        result.skipped = true;
        result.skipReason = `Invoice already submitted: ${existingInvoice.invoiceNumber}`;
        result.invoiceNumber = existingInvoice.invoiceNumber;
        result.warnings.push(result.skipReason);
        return result;
      }

      // Get Odoo invoice
      const invoiceId = odooInvoiceId || po.odoo?.invoiceId;
      let odooInvoice = null;

      if (invoiceId) {
        odooInvoice = await this.getOdooInvoice(invoiceId);
      } else if (po.odoo?.saleOrderId) {
        // Try to find invoice by sale order
        odooInvoice = await this.findOdooInvoiceBySaleOrder(po.odoo.saleOrderId);
      }

      // TEST MODE: Generate mock invoice if no real one exists for test POs
      if (!odooInvoice && isTestMode() && po._testData) {
        odooInvoice = this.generateMockOdooInvoice(po);
        result.warnings.push('TEST MODE: Using mock Odoo invoice');
        console.log(`[VendorInvoiceSubmitter] TEST MODE: Generated mock invoice ${odooInvoice.name} for PO ${poNumber}`);
      }

      if (!odooInvoice) {
        result.errors.push('No Odoo invoice found for this PO');
        return result;
      }

      // Check invoice state
      if (odooInvoice.state !== 'posted') {
        result.errors.push(`Invoice ${odooInvoice.name} is not posted (state: ${odooInvoice.state}). Please validate the invoice in Odoo first.`);
        return result;
      }

      // Run validation unless skipped
      if (!skipValidation) {
        const validation = await this.validateInvoice(po, odooInvoice);
        result.validation = validation;
        result.warnings.push(...validation.warnings);

        if (!validation.isValid) {
          result.errors.push(...validation.errors);
          if (!forceSubmit) {
            result.errors.push('Validation failed. Use forceSubmit=true to override.');
            return result;
          } else {
            result.warnings.push('Validation errors overridden with forceSubmit');
          }
        }
      }

      // Get client for marketplace
      const client = this.getClient(po.marketplaceId);

      // Build invoice payload
      const invoicePayload = await this.buildInvoicePayload(po, odooInvoice);
      result.invoiceNumber = invoicePayload.invoices[0].id;
      result.payload = invoicePayload;

      if (dryRun) {
        result.success = true;
        result.dryRun = true;
        result.warnings.push('Dry run - not submitted to Amazon');
        return result;
      }

      // Submit to Amazon
      console.log(`[VendorInvoiceSubmitter] Submitting invoice ${result.invoiceNumber} for PO ${poNumber}...`);
      const response = await client.submitInvoices(invoicePayload);

      // Check for transaction ID
      if (response.transactionId) {
        result.transactionId = response.transactionId;
      }

      // Save to MongoDB
      await this.saveInvoiceRecord({
        invoiceNumber: result.invoiceNumber,
        purchaseOrderNumber: poNumber,
        marketplaceId: po.marketplaceId,
        odooInvoiceId: odooInvoice.id,
        odooInvoiceName: odooInvoice.name,
        status: 'submitted',
        transactionId: result.transactionId,
        submittedAt: new Date(),
        validation: result.validation,
        invoiceTotal: {
          currencyCode: invoicePayload.invoices[0].invoiceTotal?.currencyCode || 'EUR',
          amount: invoicePayload.invoices[0].invoiceTotal?.amount || 0
        }
      });

      // Update PO with invoice link
      await this.importer.addInvoice(poNumber, {
        invoiceNumber: result.invoiceNumber,
        odooInvoiceId: odooInvoice.id,
        odooInvoiceName: odooInvoice.name,
        status: 'submitted',
        submittedAt: new Date()
      });

      result.success = true;
      result.amazonResponse = response;

      console.log(`[VendorInvoiceSubmitter] Successfully submitted invoice ${result.invoiceNumber}`);
      return result;

    } catch (error) {
      result.errors.push(error.message);
      console.error(`[VendorInvoiceSubmitter] Error submitting invoice for ${poNumber}:`, error);
      return result;
    }
  }

  /**
   * Generate mock Odoo invoice for test mode
   * @param {object} po - Purchase order data
   * @returns {object} Mock invoice matching Odoo format
   */
  generateMockOdooInvoice(po) {
    const mockInvoiceId = 800000 + Math.floor(Math.random() * 100000);
    const mockInvoiceName = `TEST-INV/${po.purchaseOrderNumber}`;

    // Calculate totals from PO items
    let totalUntaxed = 0;
    const mockLines = (po.items || []).map((item, idx) => {
      const qty = item.acknowledgeQty ?? item.orderedQuantity?.amount ?? 1;
      const price = parseFloat(item.netCost?.amount) || 0;
      const subtotal = qty * price;
      totalUntaxed += subtotal;

      return {
        id: mockInvoiceId * 100 + idx,
        product_id: [item.odooProductId || 1000 + idx, item.vendorProductIdentifier || 'TEST-PRODUCT'],
        name: item.vendorProductIdentifier || 'Test Product',
        quantity: qty,
        price_unit: price,
        price_subtotal: subtotal,
        price_total: subtotal, // No tax for simplicity
        tax_ids: []
      };
    });

    return {
      id: mockInvoiceId,
      name: mockInvoiceName,
      partner_id: [po.odoo?.customerId || 1, 'Amazon Vendor (Test)'],
      invoice_date: new Date().toISOString().split('T')[0],
      amount_total: totalUntaxed,
      amount_untaxed: totalUntaxed,
      amount_tax: 0,
      currency_id: [1, po.items?.[0]?.netCost?.currencyCode || 'EUR'],
      state: 'posted',
      move_type: 'out_invoice',
      invoice_line_ids: mockLines.map(l => l.id),
      lines: mockLines,
      _testMode: true,
      _mockResponse: true
    };
  }

  /**
   * Get Odoo invoice by ID
   */
  async getOdooInvoice(invoiceId) {
    const invoices = await this.odoo.searchRead('account.move',
      [['id', '=', invoiceId]],
      [
        'id', 'name', 'partner_id', 'invoice_date', 'amount_total',
        'amount_untaxed', 'amount_tax', 'currency_id', 'state',
        'invoice_line_ids', 'move_type'
      ]
    );

    if (invoices.length === 0) return null;

    const invoice = invoices[0];

    // Get invoice lines
    if (invoice.invoice_line_ids?.length > 0) {
      invoice.lines = await this.odoo.searchRead('account.move.line',
        [['id', 'in', invoice.invoice_line_ids]],
        [
          'id', 'product_id', 'name', 'quantity', 'price_unit',
          'price_subtotal', 'price_total', 'tax_ids'
        ]
      );
    }

    return invoice;
  }

  /**
   * Find Odoo invoice by sale order
   */
  async findOdooInvoiceBySaleOrder(saleOrderId) {
    // Get sale order name
    const orders = await this.odoo.read('sale.order', [saleOrderId], ['name']);
    if (!orders || orders.length === 0) return null;

    const orderName = orders[0].name;

    // Find invoice with this origin
    const invoices = await this.odoo.searchRead('account.move',
      [
        ['invoice_origin', 'ilike', orderName],
        ['move_type', '=', 'out_invoice'],
        ['state', '=', 'posted']
      ],
      [
        'id', 'name', 'partner_id', 'invoice_date', 'amount_total',
        'amount_untaxed', 'amount_tax', 'currency_id', 'state',
        'invoice_line_ids', 'move_type'
      ],
      { limit: 1 }
    );

    if (invoices.length === 0) return null;

    const invoice = invoices[0];

    // Get invoice lines
    if (invoice.invoice_line_ids?.length > 0) {
      invoice.lines = await this.odoo.searchRead('account.move.line',
        [['id', 'in', invoice.invoice_line_ids]],
        [
          'id', 'product_id', 'name', 'quantity', 'price_unit',
          'price_subtotal', 'price_total', 'tax_ids'
        ]
      );
    }

    return invoice;
  }

  /**
   * Get country code from marketplace ID or country code
   */
  getCountryFromMarketplace(marketplaceId) {
    // If it's already a 2-letter country code, return it
    const countryCodes = ['DE', 'ES', 'FR', 'IT', 'NL', 'GB', 'UK', 'SE', 'PL', 'BE'];
    if (countryCodes.includes(marketplaceId?.toUpperCase())) {
      return marketplaceId.toUpperCase() === 'UK' ? 'GB' : marketplaceId.toUpperCase();
    }

    // Map Amazon marketplace IDs to country codes
    const marketplaceToCountry = {
      'A1PA6795UKMFR9': 'DE',
      'A1RKKUPIHCS9HS': 'ES',
      'A13V1IB3VIYZZH': 'FR',
      'APJ6JRA9NG5V4': 'IT',
      'A1805IZSGTT6HS': 'NL',
      'A1F83G8C2ARO7P': 'GB',
      'A2NODRKZP88ZB9': 'SE',
      'A1C3SOZRARQ6R3': 'PL',
      'AMEN7PMS3EDWL': 'BE'
    };
    return marketplaceToCountry[marketplaceId] || 'DE';
  }

  /**
   * Clean party object for Amazon API
   * When address is null, provide minimal address with required fields
   * Amazon requires: name, addressLine1, city, countryCode
   */
  cleanPartyForPayload(party, countryCode = 'DE') {
    if (!party) return null;

    // If address is null or empty, provide minimal address
    if (!party.address || Object.keys(party.address).length === 0) {
      return {
        partyId: party.partyId,
        address: {
          name: 'Amazon EU Sarl',
          addressLine1: 'Amazon Fulfillment Center',
          city: this.getDefaultCity(countryCode),
          countryCode: countryCode
        }
      };
    }

    // Return full party with address
    return {
      partyId: party.partyId,
      address: party.address
    };
  }

  /**
   * Get default city for a country (for Amazon fulfillment centers)
   */
  getDefaultCity(countryCode) {
    const defaultCities = {
      'DE': 'Dortmund',
      'FR': 'Paris',
      'IT': 'Milano',
      'ES': 'Madrid',
      'NL': 'Amsterdam',
      'GB': 'London',
      'SE': 'Stockholm',
      'PL': 'Warsaw',
      'BE': 'Brussels'
    };
    return defaultCities[countryCode] || 'Dortmund';
  }

  /**
   * Get default Amazon address for a country (for shipToParty fallback)
   */
  getDefaultAmazonAddress(countryCode) {
    return {
      name: 'Amazon EU Sarl',
      addressLine1: 'Amazon Fulfillment Center',
      city: this.getDefaultCity(countryCode),
      countryCode: countryCode
    };
  }

  /**
   * Get the correct Amazon billing entity for a marketplace
   * IMPORTANT: These must match Amazon's records exactly for EDI invoices
   *
   * @param {string} countryCode - Country code (DE, FR, IT, etc.)
   * @returns {object} billToParty object for Amazon invoice
   */
  getAmazonBillingEntity(countryCode) {
    // Use the predefined billing entity if available
    const entity = AMAZON_BILLING_ENTITIES[countryCode];

    if (entity) {
      return entity;
    }

    // Fallback for unmapped countries - use France as default (Amazon EU HQ)
    console.warn(`[VendorInvoiceSubmitter] No billing entity defined for ${countryCode}, using FR`);
    return AMAZON_BILLING_ENTITIES.FR;
  }

  /**
   * Build Amazon invoice payload from Odoo invoice
   */
  async buildInvoicePayload(po, odooInvoice) {
    const invoiceNumber = odooInvoice.name;
    // Amazon requires full ISO 8601 datetime format
    const rawDate = odooInvoice.invoice_date || new Date().toISOString().split('T')[0];
    const invoiceDate = rawDate.includes('T') ? rawDate : `${rawDate}T00:00:00Z`;
    const currency = odooInvoice.currency_id?.[1]?.split(' ')[0] || 'EUR';

    // Build items from invoice lines
    const items = [];
    let sequenceNumber = 1;

    for (const line of (odooInvoice.lines || [])) {
      // Skip non-product lines
      if (!line.product_id) continue;

      // Get product SKU
      const products = await this.odoo.read('product.product',
        [line.product_id[0]],
        ['default_code', 'barcode']
      );
      const product = products?.[0];

      items.push({
        itemSequenceNumber: sequenceNumber++,
        amazonProductIdentifier: product?.barcode || null,
        vendorProductIdentifier: product?.default_code || null,
        invoicedQuantity: {
          amount: Math.round(line.quantity),
          unitOfMeasure: 'Eaches'
        },
        netCost: {
          currencyCode: currency,
          amount: String(line.price_unit.toFixed(2))
        },
        purchaseOrderNumber: po.purchaseOrderNumber
      });
    }

    // Get country code from marketplace
    const countryCode = this.getCountryFromMarketplace(po.marketplaceId);

    // Get shipToParty from PO or use default
    const shipToParty = this.cleanPartyForPayload(po.shipToParty, countryCode) ||
      { partyId: po.buyingParty?.partyId || 'AMAZON', address: this.getDefaultAmazonAddress(countryCode) };

    // IMPORTANT: Use the correct Amazon billing entity for the marketplace
    // This must match exactly what Amazon expects for EDI invoices
    const billToParty = this.getAmazonBillingEntity(countryCode);

    // Use the vendor partyId from the PO (Amazon assigns different codes per marketplace)
    const vendorPartyId = po.sellingParty?.partyId || ACROPAQ_COMPANY.partyId;

    // Build invoice
    // Note: Amazon invoice schema expects: invoiceType, id, referenceNumber, remitToParty,
    // shipToParty, shipFromParty, paymentTerms, invoiceTotal, chargeDetails, allowanceDetails, items
    return {
      invoices: [{
        invoiceType: INVOICE_TYPES.INVOICE,
        id: invoiceNumber,
        date: invoiceDate,
        remitToParty: {
          partyId: vendorPartyId,
          address: ACROPAQ_COMPANY.address,
          taxRegistrationDetails: ACROPAQ_COMPANY.taxRegistrationDetails
        },
        shipFromParty: {
          partyId: vendorPartyId,
          address: ACROPAQ_COMPANY.address
        },
        shipToParty,
        billToParty,
        invoiceTotal: {
          currencyCode: currency,
          amount: String(odooInvoice.amount_total.toFixed(2))
        },
        taxDetails: [{
          taxType: 'VAT',
          taxRate: this.calculateTaxRate(odooInvoice),
          taxAmount: {
            currencyCode: currency,
            amount: String(odooInvoice.amount_tax.toFixed(2))
          },
          taxableAmount: {
            currencyCode: currency,
            amount: String(odooInvoice.amount_untaxed.toFixed(2))
          }
        }],
        items
      }]
    };
  }

  /**
   * Calculate tax rate from Odoo invoice
   */
  calculateTaxRate(odooInvoice) {
    if (!odooInvoice.amount_untaxed || odooInvoice.amount_untaxed === 0) {
      return '0.00';
    }
    const rate = (odooInvoice.amount_tax / odooInvoice.amount_untaxed) * 100;
    return rate.toFixed(2);
  }

  /**
   * Validate invoice against PO before submission
   * Checks: totals match, quantities match, all items present
   *
   * @param {Object} po - Purchase order from MongoDB
   * @param {Object} odooInvoice - Invoice from Odoo
   * @returns {Object} Validation result with isValid, errors, warnings
   */
  async validateInvoice(po, odooInvoice) {
    const result = {
      isValid: true,
      errors: [],
      warnings: [],
      comparison: {
        poTotal: 0,
        invoiceTotal: 0,
        difference: 0,
        percentDiff: 0,
        itemsMatched: 0,
        itemsMissing: [],
        itemsExtra: [],
        quantityMismatches: []
      }
    };

    // Calculate expected PO total (net cost * qty for each item)
    let poNetTotal = 0;
    const poItems = {};

    for (const item of (po.items || [])) {
      const qty = item.acknowledgeQty ?? item.orderedQuantity?.amount ?? 0;
      const netCost = parseFloat(item.netCost?.amount) || 0;
      const sku = item.vendorProductIdentifier;

      poNetTotal += qty * netCost;

      if (sku) {
        poItems[sku] = {
          sku,
          asin: item.amazonProductIdentifier,
          qty,
          netCost,
          lineTotal: qty * netCost
        };
      }
    }

    result.comparison.poTotal = parseFloat(poNetTotal.toFixed(2));
    result.comparison.invoiceTotal = odooInvoice.amount_untaxed || 0;
    result.comparison.difference = parseFloat((result.comparison.invoiceTotal - result.comparison.poTotal).toFixed(2));

    if (result.comparison.poTotal > 0) {
      result.comparison.percentDiff = parseFloat(((result.comparison.difference / result.comparison.poTotal) * 100).toFixed(2));
    }

    // Check total difference - allow 1% tolerance for rounding
    const tolerancePercent = 1;
    if (Math.abs(result.comparison.percentDiff) > tolerancePercent) {
      result.errors.push(`Invoice total (€${result.comparison.invoiceTotal}) differs from PO total (€${result.comparison.poTotal}) by ${result.comparison.percentDiff}%`);
      result.isValid = false;
    } else if (result.comparison.difference !== 0) {
      result.warnings.push(`Minor total difference: €${result.comparison.difference} (${result.comparison.percentDiff}%)`);
    }

    // Compare line items
    const invoiceItems = {};
    for (const line of (odooInvoice.lines || [])) {
      if (!line.product_id) continue;

      // Get product SKU/barcode
      const products = await this.odoo.read('product.product',
        [line.product_id[0]],
        ['default_code', 'barcode']
      );
      const product = products?.[0];
      const sku = product?.barcode || product?.default_code;

      if (sku) {
        invoiceItems[sku] = {
          sku,
          qty: line.quantity,
          unitPrice: line.price_unit,
          lineTotal: line.price_subtotal
        };
      }
    }

    // Check for missing items in invoice
    for (const [sku, poItem] of Object.entries(poItems)) {
      if (!invoiceItems[sku]) {
        result.comparison.itemsMissing.push({
          sku,
          asin: poItem.asin,
          expectedQty: poItem.qty,
          expectedTotal: poItem.lineTotal
        });
        result.errors.push(`Missing item in invoice: ${sku} (expected qty: ${poItem.qty})`);
        result.isValid = false;
      } else {
        result.comparison.itemsMatched++;

        // Check quantity
        const invoiceItem = invoiceItems[sku];
        if (invoiceItem.qty !== poItem.qty) {
          result.comparison.quantityMismatches.push({
            sku,
            poQty: poItem.qty,
            invoiceQty: invoiceItem.qty,
            difference: invoiceItem.qty - poItem.qty
          });
          result.warnings.push(`Quantity mismatch for ${sku}: PO has ${poItem.qty}, invoice has ${invoiceItem.qty}`);
        }

        // Check unit price
        if (Math.abs(invoiceItem.unitPrice - poItem.netCost) > 0.01) {
          result.warnings.push(`Price mismatch for ${sku}: PO has €${poItem.netCost}, invoice has €${invoiceItem.unitPrice}`);
        }
      }
    }

    // Check for extra items in invoice (not in PO)
    for (const [sku, invoiceItem] of Object.entries(invoiceItems)) {
      if (!poItems[sku]) {
        result.comparison.itemsExtra.push({
          sku,
          qty: invoiceItem.qty,
          total: invoiceItem.lineTotal
        });
        result.warnings.push(`Extra item in invoice not in PO: ${sku}`);
      }
    }

    return result;
  }

  /**
   * Validate invoice for a PO without submitting
   *
   * @param {string} poNumber - Purchase order number
   * @param {Object} options - Validation options
   * @returns {Object} Validation result
   */
  async validateInvoiceForPO(poNumber, options = {}) {
    const { odooInvoiceId = null } = options;

    const result = {
      purchaseOrderNumber: poNumber,
      hasInvoice: false,
      validation: null,
      po: null,
      invoice: null,
      errors: []
    };

    try {
      // Get PO from MongoDB
      const po = await this.importer.getPurchaseOrder(poNumber);
      if (!po) {
        result.errors.push(`PO not found: ${poNumber}`);
        return result;
      }

      result.po = {
        purchaseOrderNumber: po.purchaseOrderNumber,
        marketplaceId: po.marketplaceId,
        purchaseOrderState: po.purchaseOrderState,
        itemCount: po.items?.length || 0,
        odooOrderId: po.odoo?.saleOrderId,
        odooOrderName: po.odoo?.saleOrderName
      };

      // Get Odoo invoice
      const invoiceId = odooInvoiceId || po.odoo?.invoiceId;
      let odooInvoice = null;

      if (invoiceId) {
        odooInvoice = await this.getOdooInvoice(invoiceId);
      } else if (po.odoo?.saleOrderId) {
        odooInvoice = await this.findOdooInvoiceBySaleOrder(po.odoo.saleOrderId);
      }

      if (!odooInvoice) {
        result.errors.push('No Odoo invoice found for this PO');
        return result;
      }

      result.hasInvoice = true;
      result.invoice = {
        id: odooInvoice.id,
        name: odooInvoice.name,
        state: odooInvoice.state,
        invoiceDate: odooInvoice.invoice_date,
        amountTotal: odooInvoice.amount_total,
        amountUntaxed: odooInvoice.amount_untaxed,
        amountTax: odooInvoice.amount_tax,
        lineCount: odooInvoice.lines?.length || 0
      };

      // Run validation
      result.validation = await this.validateInvoice(po, odooInvoice);

    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Find existing invoice submission
   */
  async findExistingInvoice(poNumber) {
    const collection = this.db.collection(INVOICE_COLLECTION);
    return collection.findOne({ purchaseOrderNumber: poNumber });
  }

  /**
   * Save invoice record to MongoDB
   */
  async saveInvoiceRecord(data) {
    const collection = this.db.collection(INVOICE_COLLECTION);

    await collection.updateOne(
      { invoiceNumber: data.invoiceNumber },
      {
        $set: {
          ...data,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
  }

  /**
   * Submit invoices for multiple POs
   */
  async submitInvoices(poNumbers, options = {}) {
    const results = {
      processed: 0,
      submitted: 0,
      skipped: 0,
      failed: 0,
      invoices: []
    };

    for (const poNumber of poNumbers) {
      const result = await this.submitInvoice(poNumber, options);
      results.processed++;
      results.invoices.push(result);

      if (result.skipped) {
        results.skipped++;
      } else if (result.success) {
        results.submitted++;
      } else {
        results.failed++;
      }
    }

    return results;
  }

  /**
   * Submit invoices for all POs ready for invoicing
   */
  async submitPendingInvoices(options = {}) {
    const { limit = 50 } = options;

    const pendingPOs = await this.importer.getReadyForInvoicing(limit);
    const poNumbers = pendingPOs.map(po => po.purchaseOrderNumber);

    if (poNumbers.length === 0) {
      return {
        processed: 0,
        submitted: 0,
        skipped: 0,
        failed: 0,
        invoices: [],
        message: 'No POs ready for invoicing'
      };
    }

    return this.submitInvoices(poNumbers, options);
  }

  /**
   * Get submitted invoices
   */
  async getSubmittedInvoices(filters = {}, options = {}) {
    const collection = this.db.collection(INVOICE_COLLECTION);

    const query = {};
    if (filters.status) query.status = filters.status;
    if (filters.marketplace) query.marketplaceId = filters.marketplace;
    if (filters.poNumber) query.purchaseOrderNumber = filters.poNumber;

    return collection.find(query)
      .sort({ submittedAt: -1 })
      .limit(options.limit || 50)
      .toArray();
  }

  /**
   * Get transaction status for a submitted invoice
   */
  async getTransactionStatus(transactionId, marketplace) {
    const client = this.getClient(marketplace);
    return client.getTransactionStatus(transactionId);
  }

  /**
   * Get invoice statistics
   */
  async getStats() {
    const collection = this.db.collection(INVOICE_COLLECTION);

    const stats = await collection.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          submitted: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
          accepted: { $sum: { $cond: [{ $eq: ['$status', 'accepted'] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
          totalAmount: { $sum: { $toDouble: '$invoiceTotal.amount' } }
        }
      }
    ]).toArray();

    return stats[0] || { total: 0, submitted: 0, accepted: 0, rejected: 0, totalAmount: 0 };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the VendorInvoiceSubmitter instance
 */
async function getVendorInvoiceSubmitter() {
  if (!instance) {
    instance = new VendorInvoiceSubmitter();
    await instance.init();
  }
  return instance;
}

module.exports = {
  VendorInvoiceSubmitter,
  getVendorInvoiceSubmitter,
  INVOICE_TYPES,
  ACROPAQ_COMPANY,
  INVOICE_COLLECTION
};
