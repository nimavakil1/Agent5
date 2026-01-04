/**
 * InvoiceProcessor - Main orchestration for invoice processing pipeline
 *
 * Coordinates: Email polling -> Parsing -> Matching -> Booking
 */

const VendorInvoice = require('../../models/VendorInvoice');
const _AccountingTask = require('../../models/AccountingTask');
const InvoiceAuditLog = require('../../models/InvoiceAuditLog');
const InvoiceParser = require('./InvoiceParser');
const POMatchingEngine = require('./POMatchingEngine');
const { OdooVendorBillCreator } = require('./OdooVendorBillCreator');

class InvoiceProcessor {
  constructor() {
    this.parser = new InvoiceParser();
    this.matcher = new POMatchingEngine();
    this.booker = new OdooVendorBillCreator();

    // Processing configuration
    this.config = {
      autoMatchThreshold: 95, // Auto-book if confidence >= 95%
      approvalAmountThreshold: 5000, // EUR
      maxRetries: 3,
      batchSize: 10,
    };
  }

  /**
   * Process a single invoice through the pipeline
   * @param {ObjectId|string} invoiceId - MongoDB invoice ID
   */
  async processInvoice(invoiceId) {
    const invoice = await VendorInvoice.findById(invoiceId);

    if (!invoice) {
      throw new Error(`Invoice not found: ${invoiceId}`);
    }

    console.log(`[InvoiceProcessor] Processing invoice: ${invoice._id} (${invoice.invoice?.number || 'unknown'})`);

    const result = {
      invoiceId: invoice._id.toString(),
      success: false,
      status: invoice.status,
      actions: [],
    };

    try {
      // Step 1: Parse if not already parsed
      if (invoice.status === 'received' || !invoice.vendor?.name) {
        await this._parseInvoice(invoice);
        result.actions.push('parsed');
      }

      // Step 2: Match to PO
      if (invoice.status === 'parsed' || invoice.matching?.status === 'pending') {
        await this._matchInvoice(invoice);
        result.actions.push('matched');
      }

      // Step 3: Auto-book if criteria met
      if (this._canAutoBook(invoice)) {
        await this._bookInvoice(invoice);
        result.actions.push('booked');
      }

      result.success = true;
      result.status = invoice.status;
      result.matchConfidence = invoice.matching?.matchedPurchaseOrders?.[0]?.matchConfidence;

    } catch (error) {
      console.error(`[InvoiceProcessor] Error processing ${invoiceId}:`, error.message);

      invoice.addError('processing', error.message);
      invoice.status = 'error';
      await invoice.save();

      result.error = error.message;
    }

    return result;
  }

  /**
   * Process the queue of pending invoices
   */
  async processQueue() {
    console.log('[InvoiceProcessor] Processing invoice queue...');

    const pendingInvoices = await VendorInvoice.find({
      status: { $in: ['received', 'parsed'] },
    })
      .sort({ createdAt: 1 })
      .limit(this.config.batchSize);

    console.log(`[InvoiceProcessor] Found ${pendingInvoices.length} invoices to process`);

    const results = [];

    for (const invoice of pendingInvoices) {
      try {
        const result = await this.processInvoice(invoice._id);
        results.push(result);
      } catch (error) {
        console.error(`[InvoiceProcessor] Error in queue processing: ${error.message}`);
        results.push({
          invoiceId: invoice._id.toString(),
          success: false,
          error: error.message,
        });
      }
    }

    return {
      processed: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  }

  /**
   * Parse an invoice (extract data from attachment)
   */
  async _parseInvoice(invoice) {
    console.log(`[InvoiceProcessor] Parsing invoice: ${invoice._id}`);

    invoice.status = 'parsing';
    await invoice.save();

    await InvoiceAuditLog.log(invoice._id, 'parsing_started', {
      actor: { type: 'system', name: 'InvoiceProcessor' },
    });

    try {
      // For now, we'll assume the invoice already has some data from email extraction
      // In production, this would retrieve the attachment and parse it

      if (!invoice.vendor?.name || !invoice.totals?.totalAmount) {
        // If we have raw data, use that
        if (invoice.rawExtraction) {
          const normalized = this.parser._normalizeInvoiceData(invoice.rawExtraction);
          invoice.vendor = normalized.vendor;
          invoice.invoice = { ...invoice.invoice, ...normalized.invoice };
          invoice.lines = normalized.lines;
          invoice.totals = normalized.totals;
          invoice.extractionConfidence = this.parser._calculateConfidence(normalized);
        }
      }

      invoice.status = 'parsed';
      invoice.addProcessingEvent('parsed', {
        confidence: invoice.extractionConfidence,
        vendorName: invoice.vendor?.name,
        amount: invoice.totals?.totalAmount,
      });
      await invoice.save();

      await InvoiceAuditLog.log(invoice._id, 'parsing_completed', {
        invoiceNumber: invoice.invoice?.number,
        vendorName: invoice.vendor?.name,
        actor: { type: 'system', name: 'InvoiceProcessor' },
        details: {
          confidence: invoice.extractionConfidence,
          fieldsExtracted: Object.keys(invoice.toObject()).filter(k => invoice[k] != null),
        },
      });

    } catch (error) {
      invoice.status = 'error';
      invoice.addError('parsing', error.message);
      await invoice.save();

      await InvoiceAuditLog.log(invoice._id, 'parsing_failed', {
        actor: { type: 'system', name: 'InvoiceProcessor' },
        details: { errorMessage: error.message },
      });

      throw error;
    }
  }

  /**
   * Match invoice to Purchase Orders
   */
  async _matchInvoice(invoice) {
    console.log(`[InvoiceProcessor] Matching invoice: ${invoice._id}`);

    invoice.status = 'matching';
    await invoice.save();

    await InvoiceAuditLog.log(invoice._id, 'matching_started', {
      invoiceNumber: invoice.invoice?.number,
      actor: { type: 'system', name: 'InvoiceProcessor' },
    });

    try {
      const matchResult = await this.matcher.matchInvoice({
        vendor: invoice.vendor,
        invoice: invoice.invoice,
        lines: invoice.lines,
        totals: invoice.totals,
      });

      // Update vendor with Odoo partner ID if found
      if (matchResult.vendor?.id) {
        invoice.vendor.odooPartnerId = matchResult.vendor.id;
      }

      // Update matching info
      invoice.matching = {
        status: matchResult.matchType === 'none' ? 'unmatched' :
                matchResult.confidence >= this.config.autoMatchThreshold ? 'matched' : 'partial_match',
        matchedPurchaseOrders: matchResult.matchedPOs.map(po => ({
          odooPoId: po.id,
          poName: po.name,
          matchConfidence: po.matchConfidence,
          matchedLines: [],
        })),
        matchAttemptedAt: new Date(),
        matchNotes: matchResult.recommendations?.map(r => r.message).join('; '),
      };

      // Determine final status
      if (matchResult.confidence >= this.config.autoMatchThreshold) {
        invoice.status = 'matched';
      } else if (matchResult.confidence >= 50) {
        invoice.status = 'manual_review';
        invoice.matching.status = 'partial_match';
      } else {
        invoice.status = 'manual_review';
        invoice.matching.status = 'unmatched';
      }

      invoice.addProcessingEvent('matched', {
        confidence: matchResult.confidence,
        matchType: matchResult.matchType,
        matchedPOs: matchResult.matchedPOs.map(po => po.name),
      });

      await invoice.save();

      await InvoiceAuditLog.log(invoice._id, 'matching_completed', {
        invoiceNumber: invoice.invoice?.number,
        vendorName: invoice.vendor?.name,
        actor: { type: 'system', name: 'InvoiceProcessor' },
        details: {
          matchConfidence: matchResult.confidence,
          matchedPoId: matchResult.matchedPOs[0]?.id,
          matchedPoName: matchResult.matchedPOs[0]?.name,
        },
        newState: invoice.status,
      });

    } catch (error) {
      invoice.status = 'error';
      invoice.addError('matching', error.message);
      await invoice.save();

      await InvoiceAuditLog.log(invoice._id, 'matching_failed', {
        actor: { type: 'system', name: 'InvoiceProcessor' },
        details: { errorMessage: error.message },
      });

      throw error;
    }
  }

  /**
   * Check if invoice can be auto-booked
   */
  _canAutoBook(invoice) {
    // Must be matched with high confidence
    if (invoice.status !== 'matched') return false;
    if (!invoice.matching?.matchedPurchaseOrders?.length) return false;

    const confidence = invoice.matching.matchedPurchaseOrders[0].matchConfidence;
    if (confidence < this.config.autoMatchThreshold) return false;

    // Amount check
    const amount = invoice.totals?.totalAmount || 0;
    if (amount > this.config.approvalAmountThreshold) {
      // Requires approval
      if (!invoice.approval?.approvedAt) {
        console.log(`[InvoiceProcessor] Invoice ${invoice._id} requires approval (amount: €${amount})`);
        return false;
      }
    }

    return true;
  }

  /**
   * Book invoice to Odoo
   */
  async _bookInvoice(invoice) {
    console.log(`[InvoiceProcessor] Booking invoice: ${invoice._id}`);

    invoice.status = 'booking';
    await invoice.save();

    await InvoiceAuditLog.log(invoice._id, 'booking_started', {
      invoiceNumber: invoice.invoice?.number,
      vendorName: invoice.vendor?.name,
      actor: { type: 'system', name: 'InvoiceProcessor' },
    });

    const result = await this.booker.createVendorBill(invoice, {
      autoPost: false, // Don't auto-post, let human review
    });

    if (result.alreadyExists) {
      console.log(`[InvoiceProcessor] Invoice already exists in Odoo: ${result.odooInvoiceNumber}`);
      invoice.status = 'booked';
      invoice.odoo = {
        billId: result.odooInvoiceId,
        billNumber: result.odooInvoiceNumber,
        createdAt: new Date(),
      };
    }
    // Status is updated by booker
  }

  /**
   * Retry failed invoices
   */
  async retryFailed() {
    const failedInvoices = await VendorInvoice.find({
      status: 'error',
      'errors.retryCount': { $lt: this.config.maxRetries },
    })
      .sort({ 'errors.timestamp': 1 })
      .limit(this.config.batchSize);

    console.log(`[InvoiceProcessor] Retrying ${failedInvoices.length} failed invoices`);

    const results = [];

    for (const invoice of failedInvoices) {
      // Reset status based on last successful stage
      if (invoice.vendor?.name && invoice.totals?.totalAmount) {
        invoice.status = 'parsed';
      } else {
        invoice.status = 'received';
      }
      await invoice.save();

      try {
        const result = await this.processInvoice(invoice._id);
        results.push(result);
      } catch (error) {
        results.push({
          invoiceId: invoice._id.toString(),
          success: false,
          error: error.message,
        });
      }
    }

    return {
      retried: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  }
}

// Singleton instance
let instance = null;

module.exports = {
  InvoiceProcessor,

  // Factory functions for singleton access
  processInvoice: async (invoiceId) => {
    if (!instance) instance = new InvoiceProcessor();
    return instance.processInvoice(invoiceId);
  },

  processQueue: async () => {
    if (!instance) instance = new InvoiceProcessor();
    return instance.processQueue();
  },

  retryFailed: async () => {
    if (!instance) instance = new InvoiceProcessor();
    return instance.retryFailed();
  },
};
