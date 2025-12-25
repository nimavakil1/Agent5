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

/**
 * Invoice types
 */
const INVOICE_TYPES = {
  INVOICE: 'Invoice',
  CREDIT_NOTE: 'CreditNote'
};

/**
 * ACROPAQ company info for remitToParty
 */
const ACROPAQ_COMPANY = {
  partyId: 'ACROPAQ',
  address: {
    name: 'ACROPAQ BV',
    addressLine1: 'Patronaatstraat 79',
    city: 'Dendermonde',
    stateOrRegion: 'Oost-Vlaanderen',
    postalCode: '9200',
    countryCode: 'BE'
  },
  taxRegistrationDetails: [{
    taxRegistrationType: 'VAT',
    taxRegistrationNumber: 'BE0644944497'
  }]
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
   */
  getClient(marketplace) {
    if (!this.clients[marketplace]) {
      this.clients[marketplace] = new VendorClient(marketplace);
    }
    return this.clients[marketplace];
  }

  /**
   * Submit invoice for a PO
   *
   * @param {string} poNumber - Purchase order number
   * @param {Object} options - Submission options
   * @param {number} options.odooInvoiceId - Specific Odoo invoice ID (optional)
   * @param {boolean} options.dryRun - If true, don't submit to Amazon
   * @returns {Object} Result with success status and transaction ID
   */
  async submitInvoice(poNumber, options = {}) {
    const { odooInvoiceId = null, dryRun = false } = options;

    const result = {
      success: false,
      purchaseOrderNumber: poNumber,
      invoiceNumber: null,
      transactionId: null,
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

      // Check if PO is acknowledged
      if (!po.acknowledgment?.acknowledged) {
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

      if (!odooInvoice) {
        result.errors.push('No Odoo invoice found for this PO');
        return result;
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
   * Build Amazon invoice payload from Odoo invoice
   */
  async buildInvoicePayload(po, odooInvoice) {
    const invoiceNumber = odooInvoice.name;
    const invoiceDate = odooInvoice.invoice_date || new Date().toISOString().split('T')[0];
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
        itemSequenceNumber: String(sequenceNumber++),
        amazonProductIdentifier: product?.barcode || null,
        vendorProductIdentifier: product?.default_code || null,
        invoicedQuantity: {
          amount: Math.round(line.quantity),
          unitOfMeasure: 'Each'
        },
        netCost: {
          currencyCode: currency,
          amount: String(line.price_unit.toFixed(2))
        },
        purchaseOrderNumber: po.purchaseOrderNumber
      });
    }

    // Build invoice
    return {
      invoices: [{
        invoiceType: INVOICE_TYPES.INVOICE,
        id: invoiceNumber,
        date: invoiceDate,
        remitToParty: ACROPAQ_COMPANY,
        shipFromParty: {
          partyId: ACROPAQ_COMPANY.partyId,
          address: ACROPAQ_COMPANY.address
        },
        shipToParty: po.shipToParty || {
          partyId: po.buyingParty?.partyId || 'AMAZON'
        },
        billToParty: po.billToParty || po.buyingParty || {
          partyId: 'AMAZON'
        },
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
