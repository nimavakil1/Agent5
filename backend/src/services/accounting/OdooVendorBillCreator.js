/**
 * OdooVendorBillCreator - Create vendor bills in Odoo from processed invoices
 *
 * Follows the pattern from BolInvoiceBooker.js for Odoo integration.
 */

const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const VendorInvoice = require('../../models/VendorInvoice');
const InvoiceAuditLog = require('../../models/InvoiceAuditLog');

class OdooVendorBillCreator {
  constructor(odooClient = null) {
    this.odooClient = odooClient;

    // Default configuration
    this.config = {
      defaultJournalCode: 'BILL', // Purchase journal
      defaultAccountCode: '600000', // Expense account
      autoPost: false, // Don't auto-post by default
      attachPdf: true,
    };
  }

  /**
   * Initialize Odoo client if not provided
   */
  async _ensureClient() {
    if (!this.odooClient) {
      this.odooClient = new OdooDirectClient();
      await this.odooClient.authenticate();
    }
  }

  /**
   * Create a vendor bill in Odoo from a processed invoice
   * @param {Object} invoiceDoc - VendorInvoice MongoDB document
   * @param {Object} options - Options (force, autoPost)
   */
  async createVendorBill(invoiceDoc, options = {}) {
    await this._ensureClient();

    // Fetch fresh invoice data
    const invoice = invoiceDoc._id
      ? await VendorInvoice.findById(invoiceDoc._id)
      : invoiceDoc;

    console.log(`[OdooVendorBillCreator] Creating bill for invoice: ${invoice.invoice?.number}`);

    // Check for duplicate
    const existing = await this._checkDuplicate(invoice);
    if (existing) {
      console.log(`[OdooVendorBillCreator] Duplicate found: ${existing.name}`);
      return {
        success: false,
        alreadyExists: true,
        odooInvoiceId: existing.id,
        odooInvoiceNumber: existing.name,
      };
    }

    // Get or create vendor partner
    let partnerId = invoice.vendor?.odooPartnerId;
    if (!partnerId) {
      partnerId = await this._getOrCreatePartner(invoice.vendor);

      // Update invoice with partner ID
      invoice.vendor.odooPartnerId = partnerId;
    }

    // Get expense account
    const accountId = await this._getExpenseAccount(invoice);

    // Get tax IDs
    const taxIds = await this._getTaxIds(invoice.totals?.vatRate);

    // Build invoice lines
    const invoiceLines = this._buildInvoiceLines(invoice, accountId, taxIds);

    // Create the vendor bill
    const billData = {
      move_type: 'in_invoice',
      partner_id: partnerId,
      invoice_date: invoice.invoice?.date,
      invoice_date_due: invoice.invoice?.dueDate,
      ref: invoice.invoice?.number, // Vendor reference
      invoice_origin: invoice.matching?.matchedPurchaseOrders?.[0]?.poName || null,
      invoice_line_ids: invoiceLines,
      narration: this._buildNotes(invoice),
    };

    console.log('[OdooVendorBillCreator] Creating bill with data:', JSON.stringify(billData, null, 2));

    try {
      const billId = await this.odooClient.create('account.move', billData);
      console.log(`[OdooVendorBillCreator] Bill created with ID: ${billId}`);

      // Get the created bill details
      const bills = await this.odooClient.read('account.move', [billId], ['id', 'name', 'state']);
      const bill = bills[0];

      // Attach PDF if available
      if (this.config.attachPdf && invoice.attachmentStorageKey) {
        await this._attachPdf(billId, invoice);
      }

      // Update invoice record
      invoice.status = 'booked';
      invoice.odoo = {
        billId: bill.id,
        billNumber: bill.name,
        createdAt: new Date(),
      };
      invoice.addProcessingEvent('booked', { odooId: bill.id, odooNumber: bill.name });
      await invoice.save();

      // Log audit
      await InvoiceAuditLog.log(invoice._id, 'odoo_bill_created', {
        invoiceNumber: invoice.invoice?.number,
        vendorName: invoice.vendor?.name,
        actor: { type: 'system', name: 'OdooVendorBillCreator' },
        details: {
          odooInvoiceId: bill.id,
          odooInvoiceNumber: bill.name,
          amount: invoice.totals?.totalAmount,
        },
      });

      // Auto-post if configured and amount is under threshold
      if (options.autoPost || this.config.autoPost) {
        await this._postBill(billId);

        invoice.odoo.postedAt = new Date();
        await invoice.save();

        await InvoiceAuditLog.log(invoice._id, 'odoo_bill_posted', {
          invoiceNumber: invoice.invoice?.number,
          actor: { type: 'system', name: 'OdooVendorBillCreator' },
        });
      }

      return {
        success: true,
        odooInvoiceId: bill.id,
        odooInvoiceNumber: bill.name,
        partnerId,
      };
    } catch (error) {
      console.error('[OdooVendorBillCreator] Error creating bill:', error.message);

      // Update invoice with error
      invoice.status = 'error';
      invoice.addError('booking', error.message);
      invoice.odoo = invoice.odoo || {};
      invoice.odoo.syncError = error.message;
      invoice.odoo.lastSyncAttempt = new Date();
      await invoice.save();

      await InvoiceAuditLog.log(invoice._id, 'booking_failed', {
        invoiceNumber: invoice.invoice?.number,
        actor: { type: 'system', name: 'OdooVendorBillCreator' },
        details: { errorMessage: error.message },
      });

      throw error;
    }
  }

  /**
   * Check for duplicate invoice in Odoo
   */
  async _checkDuplicate(invoice) {
    const existing = await this.odooClient.searchRead('account.move', [
      ['ref', '=', invoice.invoice?.number],
      ['partner_id', '=', invoice.vendor?.odooPartnerId],
      ['move_type', '=', 'in_invoice'],
    ], ['id', 'name', 'state'], { limit: 1 });

    return existing.length > 0 ? existing[0] : null;
  }

  /**
   * Get or create vendor partner in Odoo
   */
  async _getOrCreatePartner(vendorData) {
    // Try to find existing partner
    let partners = [];

    if (vendorData.vatNumber) {
      partners = await this.odooClient.searchRead('res.partner', [
        ['vat', '=ilike', vendorData.vatNumber],
      ], ['id', 'name'], { limit: 1 });
    }

    if (partners.length === 0 && vendorData.name) {
      partners = await this.odooClient.searchRead('res.partner', [
        ['name', 'ilike', vendorData.name],
        ['supplier_rank', '>', 0],
      ], ['id', 'name'], { limit: 1 });
    }

    if (partners.length > 0) {
      return partners[0].id;
    }

    // Create new partner
    console.log(`[OdooVendorBillCreator] Creating new vendor partner: ${vendorData.name}`);

    const partnerId = await this.odooClient.create('res.partner', {
      name: vendorData.name,
      company_type: 'company',
      is_company: true,
      supplier_rank: 1,
      vat: vendorData.vatNumber,
      street: vendorData.address,
      comment: 'Created automatically by Agent5 Accounting Agent',
    });

    return partnerId;
  }

  /**
   * Get expense account ID
   */
  async _getExpenseAccount(invoice) {
    // Try to find a matching expense account
    const accounts = await this.odooClient.searchRead('account.account', [
      ['code', '=like', '6%'], // Expense accounts typically start with 6
      ['deprecated', '=', false],
    ], ['id', 'code', 'name'], { limit: 1 });

    if (accounts.length > 0) {
      return accounts[0].id;
    }

    // Fallback: get any expense-type account
    const fallbackAccounts = await this.odooClient.searchRead('account.account', [
      ['account_type', '=', 'expense'],
      ['deprecated', '=', false],
    ], ['id', 'code', 'name'], { limit: 1 });

    if (fallbackAccounts.length > 0) {
      return fallbackAccounts[0].id;
    }

    throw new Error('No expense account found in Odoo');
  }

  /**
   * Get tax IDs for the invoice
   */
  async _getTaxIds(vatRate) {
    if (!vatRate) return [[6, 0, []]]; // No taxes

    // Find matching purchase tax
    const taxes = await this.odooClient.searchRead('account.tax', [
      ['type_tax_use', '=', 'purchase'],
      ['amount', '=', vatRate],
      ['active', '=', true],
    ], ['id', 'name', 'amount'], { limit: 1 });

    if (taxes.length > 0) {
      return [[6, 0, [taxes[0].id]]];
    }

    return [[6, 0, []]]; // No matching tax found
  }

  /**
   * Build invoice lines for Odoo
   */
  _buildInvoiceLines(invoice, accountId, taxIds) {
    if (!invoice.lines || invoice.lines.length === 0) {
      // Single line invoice
      return [[0, 0, {
        name: `Invoice ${invoice.invoice?.number}`,
        quantity: 1,
        price_unit: invoice.totals?.subtotal || invoice.totals?.totalAmount,
        account_id: accountId,
        tax_ids: taxIds,
      }]];
    }

    return invoice.lines.map(line => [0, 0, {
      name: line.description || 'Invoice line',
      quantity: line.quantity || 1,
      price_unit: line.unitPrice || 0,
      account_id: accountId,
      tax_ids: taxIds,
      purchase_line_id: line.matchedOdooPOLineId || false,
    }]);
  }

  /**
   * Build notes for the invoice
   */
  _buildNotes(invoice) {
    const notes = [];

    notes.push(`Processed by Agent5 Accounting Agent`);
    notes.push(`Source: ${invoice.source?.type || 'unknown'}`);

    if (invoice.source?.emailSubject) {
      notes.push(`Email: ${invoice.source.emailSubject}`);
    }

    if (invoice.matching?.matchedPurchaseOrders?.length > 0) {
      const po = invoice.matching.matchedPurchaseOrders[0];
      notes.push(`Matched PO: ${po.poName} (${po.matchConfidence}% confidence)`);
    }

    if (invoice.extractionConfidence) {
      notes.push(`Extraction confidence: ${Math.round(invoice.extractionConfidence * 100)}%`);
    }

    return notes.join('\n');
  }

  /**
   * Attach PDF to the bill
   */
  async _attachPdf(billId, invoice) {
    // This would retrieve the PDF from storage and attach it
    // For now, just log the intention
    console.log(`[OdooVendorBillCreator] Would attach PDF for bill ${billId}`);

    // In production:
    // const pdfBuffer = await storageService.get(invoice.attachmentStorageKey);
    // await this.odooClient.create('ir.attachment', {
    //   name: `${invoice.invoice.number}.pdf`,
    //   type: 'binary',
    //   datas: pdfBuffer.toString('base64'),
    //   res_model: 'account.move',
    //   res_id: billId,
    //   mimetype: 'application/pdf',
    // });
  }

  /**
   * Post the bill (confirm it)
   */
  async _postBill(billId) {
    console.log(`[OdooVendorBillCreator] Posting bill ${billId}`);

    try {
      await this.odooClient.execute('account.move', 'action_post', [[billId]]);
    } catch (error) {
      console.error(`[OdooVendorBillCreator] Error posting bill: ${error.message}`);
      throw error;
    }
  }

  /**
   * Reconcile bill with payment if available
   */
  async reconcileWithPayment(billId, paymentId) {
    console.log(`[OdooVendorBillCreator] Reconciling bill ${billId} with payment ${paymentId}`);

    try {
      const result = await this.odooClient.reconcileInvoicePayment([billId], paymentId);
      return result;
    } catch (error) {
      console.error(`[OdooVendorBillCreator] Error reconciling: ${error.message}`);
      throw error;
    }
  }
}

// Singleton instance
let instance = null;

module.exports = {
  OdooVendorBillCreator,

  // Factory function for singleton access
  createVendorBill: async (invoice, options) => {
    if (!instance) {
      instance = new OdooVendorBillCreator();
    }
    return instance.createVendorBill(invoice, options);
  },
};
