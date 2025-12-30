/**
 * PaymentReconciliationEngine - Match payment advices with open invoices
 *
 * Automatically reconciles payment advices with vendor invoices in Odoo.
 * Supports multiple matching strategies and tolerance thresholds.
 */

const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const PaymentAdvice = require('../../models/PaymentAdvice');
const VendorInvoice = require('../../models/VendorInvoice');
const InvoiceAuditLog = require('../../models/InvoiceAuditLog');

// Maximum tolerance for amount matching (€0.02)
const AMOUNT_TOLERANCE = 0.02;

class PaymentReconciliationEngine {
  constructor(odooClient = null) {
    this.odooClient = odooClient;
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
   * Reconcile a payment advice with invoices
   * @param {ObjectId|string} paymentAdviceId - PaymentAdvice MongoDB ID
   */
  async reconcilePayment(paymentAdviceId) {
    await this._ensureClient();

    const paymentAdvice = await PaymentAdvice.findById(paymentAdviceId);
    if (!paymentAdvice) {
      throw new Error(`Payment advice not found: ${paymentAdviceId}`);
    }

    console.log(`[PaymentReconciliation] Reconciling payment: ${paymentAdvice.payment?.reference || paymentAdvice._id}`);

    paymentAdvice.status = 'matching';
    await paymentAdvice.save();

    const result = {
      paymentAdviceId: paymentAdvice._id.toString(),
      success: false,
      matchedLines: 0,
      unmatchedLines: 0,
      totalMatched: 0,
      totalUnmatched: 0,
      actions: [],
    };

    try {
      // Step 1: Identify the vendor in Odoo
      const vendorId = await this._identifyVendor(paymentAdvice);
      if (vendorId) {
        paymentAdvice.payer.odooPartnerId = vendorId;
      }

      // Step 2: Get open invoices for this vendor from Odoo
      const openInvoices = await this._getOpenInvoices(vendorId);
      console.log(`[PaymentReconciliation] Found ${openInvoices.length} open invoices for vendor`);

      // Step 3: Match payment lines to invoices
      if (paymentAdvice.lines && paymentAdvice.lines.length > 0) {
        // Payment has line items - match each line
        for (const line of paymentAdvice.lines) {
          const match = await this._matchPaymentLine(line, openInvoices, paymentAdvice.payment.currency);
          if (match) {
            line.matchedOdooBillId = match.invoiceId;
            line.matchConfidence = match.confidence;
            line.matchStatus = 'matched';
            result.matchedLines++;
            result.totalMatched += line.paidAmount || 0;
          } else {
            line.matchStatus = 'unmatched';
            result.unmatchedLines++;
            result.totalUnmatched += line.paidAmount || 0;
          }
        }
      } else {
        // Single payment - try to match to one or more invoices
        const matches = await this._matchSinglePayment(
          paymentAdvice.payment.totalAmount,
          openInvoices,
          paymentAdvice.payment.reference
        );

        for (const match of matches) {
          paymentAdvice.lines.push({
            invoiceReference: match.invoiceName,
            invoiceAmount: match.invoiceAmount,
            paidAmount: match.paidAmount,
            matchedOdooBillId: match.invoiceId,
            matchConfidence: match.confidence,
            matchStatus: 'matched',
          });
          result.matchedLines++;
          result.totalMatched += match.paidAmount;
        }

        // If there's remaining unmatched amount
        const unmatchedAmount = paymentAdvice.payment.totalAmount - result.totalMatched;
        if (Math.abs(unmatchedAmount) > AMOUNT_TOLERANCE) {
          paymentAdvice.lines.push({
            invoiceReference: 'UNMATCHED',
            paidAmount: unmatchedAmount,
            matchStatus: 'unmatched',
          });
          result.unmatchedLines++;
          result.totalUnmatched = unmatchedAmount;
        }
      }

      // Step 4: Calculate reconciliation summary
      paymentAdvice.calculateReconciliationSummary();

      // Step 5: Update status
      if (result.unmatchedLines === 0) {
        paymentAdvice.status = 'matched';
        result.actions.push('fully_matched');
      } else if (result.matchedLines > 0) {
        paymentAdvice.status = 'matched';
        result.actions.push('partially_matched');
      } else {
        paymentAdvice.status = 'matched';
        paymentAdvice.reconciliation.status = 'unmatched';
        result.actions.push('no_matches_found');
      }

      paymentAdvice.addProcessingEvent('matching_completed', {
        matchedLines: result.matchedLines,
        unmatchedLines: result.unmatchedLines,
        totalMatched: result.totalMatched,
      });

      await paymentAdvice.save();

      // Log audit
      await InvoiceAuditLog.log(paymentAdvice._id, 'payment_matching_completed', {
        paymentReference: paymentAdvice.payment?.reference,
        actor: { type: 'system', name: 'PaymentReconciliationEngine' },
        details: result,
      });

      result.success = true;

    } catch (error) {
      console.error(`[PaymentReconciliation] Error:`, error.message);

      paymentAdvice.status = 'error';
      paymentAdvice.addError('matching', error.message);
      await paymentAdvice.save();

      result.error = error.message;
    }

    return result;
  }

  /**
   * Identify vendor in Odoo
   */
  async _identifyVendor(paymentAdvice) {
    // Try by VAT number
    if (paymentAdvice.payer?.vatNumber) {
      const partners = await this.odooClient.searchRead('res.partner', [
        ['vat', '=ilike', paymentAdvice.payer.vatNumber],
        ['supplier_rank', '>', 0],
      ], ['id', 'name'], { limit: 1 });

      if (partners.length > 0) {
        return partners[0].id;
      }
    }

    // Try by bank account
    if (paymentAdvice.payer?.bankAccount) {
      const banks = await this.odooClient.searchRead('res.partner.bank', [
        ['acc_number', 'ilike', paymentAdvice.payer.bankAccount],
      ], ['partner_id'], { limit: 1 });

      if (banks.length > 0 && banks[0].partner_id) {
        return banks[0].partner_id[0];
      }
    }

    // Try by name
    if (paymentAdvice.payer?.name) {
      const partners = await this.odooClient.searchRead('res.partner', [
        ['name', 'ilike', paymentAdvice.payer.name],
        ['supplier_rank', '>', 0],
      ], ['id', 'name'], { limit: 1 });

      if (partners.length > 0) {
        return partners[0].id;
      }
    }

    return null;
  }

  /**
   * Get open invoices for a vendor
   */
  async _getOpenInvoices(vendorId) {
    const domain = [
      ['move_type', '=', 'in_invoice'],
      ['state', '=', 'posted'],
      ['payment_state', 'in', ['not_paid', 'partial']],
    ];

    if (vendorId) {
      domain.push(['partner_id', '=', vendorId]);
    }

    const invoices = await this.odooClient.searchRead('account.move', domain, [
      'id', 'name', 'ref', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual', 'currency_id',
    ], { limit: 100, order: 'invoice_date desc' });

    return invoices;
  }

  /**
   * Match a payment line to an invoice
   */
  async _matchPaymentLine(line, openInvoices, currency) {
    const candidates = [];

    for (const invoice of openInvoices) {
      let confidence = 0;
      const reasons = [];

      // Match by invoice reference
      if (line.invoiceReference) {
        const invoiceRef = (invoice.ref || '').toLowerCase();
        const invoiceName = (invoice.name || '').toLowerCase();
        const lineRef = line.invoiceReference.toLowerCase();

        if (invoiceRef === lineRef || invoiceName === lineRef) {
          confidence += 60;
          reasons.push('exact_ref_match');
        } else if (invoiceRef.includes(lineRef) || lineRef.includes(invoiceRef) ||
                   invoiceName.includes(lineRef) || lineRef.includes(invoiceName)) {
          confidence += 40;
          reasons.push('partial_ref_match');
        }
      }

      // Match by amount (with tolerance)
      const invoiceAmount = invoice.amount_residual || invoice.amount_total;
      const paidAmount = line.paidAmount || line.invoiceAmount;

      if (paidAmount) {
        const diff = Math.abs(invoiceAmount - paidAmount);
        if (diff <= AMOUNT_TOLERANCE) {
          confidence += 40;
          reasons.push('exact_amount_match');
        } else if (diff <= invoiceAmount * 0.01) {
          // Within 1%
          confidence += 25;
          reasons.push('close_amount_match');
        }
      }

      // Match by date
      if (line.invoiceDate && invoice.invoice_date) {
        const lineDate = new Date(line.invoiceDate).toISOString().split('T')[0];
        if (invoice.invoice_date === lineDate) {
          confidence += 10;
          reasons.push('date_match');
        }
      }

      if (confidence > 0) {
        candidates.push({
          invoiceId: invoice.id,
          invoiceName: invoice.name,
          invoiceAmount,
          confidence: Math.min(100, confidence),
          reasons,
        });
      }
    }

    // Sort by confidence and return best match
    candidates.sort((a, b) => b.confidence - a.confidence);

    // Require at least 50% confidence for a match
    if (candidates.length > 0 && candidates[0].confidence >= 50) {
      return candidates[0];
    }

    return null;
  }

  /**
   * Match a single payment to one or more invoices
   */
  async _matchSinglePayment(totalAmount, openInvoices, paymentReference) {
    const matches = [];
    let remainingAmount = totalAmount;

    // First, try exact match by reference
    if (paymentReference) {
      const refMatch = openInvoices.find(inv => {
        const ref = (inv.ref || '').toLowerCase();
        const name = (inv.name || '').toLowerCase();
        const payRef = paymentReference.toLowerCase();
        return ref === payRef || name === payRef || ref.includes(payRef) || payRef.includes(ref);
      });

      if (refMatch) {
        const amount = Math.min(refMatch.amount_residual, remainingAmount);
        if (Math.abs(refMatch.amount_residual - amount) <= AMOUNT_TOLERANCE) {
          matches.push({
            invoiceId: refMatch.id,
            invoiceName: refMatch.name,
            invoiceAmount: refMatch.amount_residual,
            paidAmount: amount,
            confidence: 95,
          });
          remainingAmount -= amount;
        }
      }
    }

    // Then, try exact amount match (with €0.02 tolerance)
    if (remainingAmount > AMOUNT_TOLERANCE) {
      for (const invoice of openInvoices) {
        if (matches.some(m => m.invoiceId === invoice.id)) continue;

        const diff = Math.abs(invoice.amount_residual - remainingAmount);
        if (diff <= AMOUNT_TOLERANCE) {
          matches.push({
            invoiceId: invoice.id,
            invoiceName: invoice.name,
            invoiceAmount: invoice.amount_residual,
            paidAmount: remainingAmount,
            confidence: 90,
          });
          remainingAmount = 0;
          break;
        }
      }
    }

    // If still unmatched, try to find combination of invoices
    if (remainingAmount > AMOUNT_TOLERANCE) {
      const combinationMatch = this._findInvoiceCombination(
        openInvoices.filter(inv => !matches.some(m => m.invoiceId === inv.id)),
        remainingAmount
      );

      if (combinationMatch) {
        for (const inv of combinationMatch.invoices) {
          matches.push({
            invoiceId: inv.id,
            invoiceName: inv.name,
            invoiceAmount: inv.amount_residual,
            paidAmount: inv.amount_residual,
            confidence: 80,
          });
        }
        remainingAmount = combinationMatch.remaining;
      }
    }

    return matches;
  }

  /**
   * Find a combination of invoices that sum to the target amount
   */
  _findInvoiceCombination(invoices, targetAmount, maxInvoices = 5) {
    // Sort by amount descending
    const sorted = [...invoices].sort((a, b) => b.amount_residual - a.amount_residual);

    // Try combinations of up to maxInvoices
    for (let count = 1; count <= Math.min(maxInvoices, sorted.length); count++) {
      const result = this._findCombinationOfSize(sorted, targetAmount, count);
      if (result) {
        return result;
      }
    }

    return null;
  }

  /**
   * Find a combination of exactly 'size' invoices
   */
  _findCombinationOfSize(invoices, targetAmount, size, startIdx = 0, current = [], currentSum = 0) {
    if (current.length === size) {
      const diff = Math.abs(currentSum - targetAmount);
      if (diff <= AMOUNT_TOLERANCE) {
        return {
          invoices: current,
          total: currentSum,
          remaining: targetAmount - currentSum,
        };
      }
      return null;
    }

    for (let i = startIdx; i < invoices.length; i++) {
      const inv = invoices[i];
      const newSum = currentSum + inv.amount_residual;

      // Prune if sum already exceeds target by more than tolerance
      if (newSum > targetAmount + AMOUNT_TOLERANCE) continue;

      const result = this._findCombinationOfSize(
        invoices, targetAmount, size, i + 1,
        [...current, inv], newSum
      );

      if (result) return result;
    }

    return null;
  }

  /**
   * Execute reconciliation in Odoo
   * Creates payment and reconciles with matched invoices
   */
  async executeReconciliation(paymentAdviceId) {
    await this._ensureClient();

    const paymentAdvice = await PaymentAdvice.findById(paymentAdviceId);
    if (!paymentAdvice) {
      throw new Error(`Payment advice not found: ${paymentAdviceId}`);
    }

    // Only proceed if we have matched lines
    const matchedLines = paymentAdvice.lines.filter(l => l.matchStatus === 'matched' && l.matchedOdooBillId);
    if (matchedLines.length === 0) {
      throw new Error('No matched invoices to reconcile');
    }

    console.log(`[PaymentReconciliation] Executing reconciliation for ${matchedLines.length} invoices`);

    paymentAdvice.status = 'reconciling';
    await paymentAdvice.save();

    try {
      // Get vendor partner ID
      const vendorId = paymentAdvice.payer?.odooPartnerId;
      if (!vendorId) {
        throw new Error('Vendor not identified in Odoo');
      }

      // Find purchase payment journal
      const journals = await this.odooClient.searchRead('account.journal', [
        ['type', '=', 'bank'],
      ], ['id', 'name'], { limit: 1 });

      if (journals.length === 0) {
        throw new Error('No bank journal found');
      }

      const journalId = journals[0].id;

      // Create payment in Odoo
      const paymentData = {
        payment_type: 'outbound',
        partner_type: 'supplier',
        partner_id: vendorId,
        amount: paymentAdvice.reconciliation.matchedAmount,
        currency_id: await this._getCurrencyId(paymentAdvice.payment.currency),
        journal_id: journalId,
        date: paymentAdvice.payment.date || new Date(),
        ref: paymentAdvice.payment.reference || `Payment ${paymentAdvice._id}`,
      };

      const paymentId = await this.odooClient.create('account.payment', paymentData);
      console.log(`[PaymentReconciliation] Created payment: ${paymentId}`);

      // Post the payment
      await this.odooClient.execute('account.payment', 'action_post', [[paymentId]]);

      // Get payment move lines for reconciliation
      const payment = await this.odooClient.searchRead('account.payment', [
        ['id', '=', paymentId],
      ], ['move_id'], { limit: 1 });

      if (!payment.length || !payment[0].move_id) {
        throw new Error('Payment move not found');
      }

      const moveId = payment[0].move_id[0];
      const paymentLines = await this.odooClient.searchRead('account.move.line', [
        ['move_id', '=', moveId],
        ['account_id.account_type', '=', 'liability_payable'],
      ], ['id'], { limit: 1 });

      if (paymentLines.length > 0) {
        const paymentLineId = paymentLines[0].id;

        // Get invoice lines to reconcile
        const invoiceIds = matchedLines.map(l => l.matchedOdooBillId);
        const invoiceLines = await this.odooClient.searchRead('account.move.line', [
          ['move_id', 'in', invoiceIds],
          ['account_id.account_type', '=', 'liability_payable'],
          ['reconciled', '=', false],
        ], ['id']);

        if (invoiceLines.length > 0) {
          // Reconcile lines
          const lineIds = [paymentLineId, ...invoiceLines.map(l => l.id)];
          await this.odooClient.execute('account.move.line', 'reconcile', [lineIds]);
          console.log(`[PaymentReconciliation] Reconciled ${lineIds.length} lines`);
        }
      }

      // Update payment advice
      paymentAdvice.status = 'reconciled';
      paymentAdvice.reconciliation.status = 'reconciled';
      paymentAdvice.reconciliation.reconciledAt = new Date();
      paymentAdvice.odoo = {
        paymentId,
        paymentName: paymentAdvice.payment.reference,
        journalId,
        createdAt: new Date(),
        reconciledInvoices: matchedLines.map(l => l.matchedOdooBillId),
      };

      paymentAdvice.addProcessingEvent('reconciliation_completed', {
        odooPaymentId: paymentId,
        invoicesReconciled: matchedLines.length,
      });

      await paymentAdvice.save();

      await InvoiceAuditLog.log(paymentAdvice._id, 'payment_reconciled', {
        paymentReference: paymentAdvice.payment?.reference,
        actor: { type: 'system', name: 'PaymentReconciliationEngine' },
        details: {
          odooPaymentId: paymentId,
          amount: paymentAdvice.reconciliation.matchedAmount,
          invoicesReconciled: matchedLines.map(l => l.matchedOdooBillId),
        },
      });

      return {
        success: true,
        odooPaymentId: paymentId,
        invoicesReconciled: matchedLines.length,
      };

    } catch (error) {
      console.error(`[PaymentReconciliation] Reconciliation error:`, error.message);

      paymentAdvice.status = 'error';
      paymentAdvice.addError('reconciliation', error.message);
      await paymentAdvice.save();

      throw error;
    }
  }

  /**
   * Get currency ID from Odoo
   */
  async _getCurrencyId(currencyCode = 'EUR') {
    const currencies = await this.odooClient.searchRead('res.currency', [
      ['name', '=', currencyCode],
    ], ['id'], { limit: 1 });

    if (currencies.length > 0) {
      return currencies[0].id;
    }

    // Default to EUR
    const eurCurrencies = await this.odooClient.searchRead('res.currency', [
      ['name', '=', 'EUR'],
    ], ['id'], { limit: 1 });

    return eurCurrencies[0]?.id;
  }

  /**
   * Get pending payment advices for reconciliation
   */
  async getPendingReconciliations() {
    return PaymentAdvice.findPendingReconciliation();
  }

  /**
   * Process all pending payment advices
   */
  async processQueue() {
    const pending = await this.getPendingReconciliations();
    console.log(`[PaymentReconciliation] Processing ${pending.length} pending payment advices`);

    const results = [];

    for (const paymentAdvice of pending) {
      try {
        const result = await this.reconcilePayment(paymentAdvice._id);
        results.push(result);
      } catch (error) {
        results.push({
          paymentAdviceId: paymentAdvice._id.toString(),
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
}

// Singleton instance
let instance = null;

module.exports = {
  PaymentReconciliationEngine,

  // Factory functions
  reconcilePayment: async (paymentAdviceId) => {
    if (!instance) instance = new PaymentReconciliationEngine();
    return instance.reconcilePayment(paymentAdviceId);
  },

  executeReconciliation: async (paymentAdviceId) => {
    if (!instance) instance = new PaymentReconciliationEngine();
    return instance.executeReconciliation(paymentAdviceId);
  },

  processReconciliationQueue: async () => {
    if (!instance) instance = new PaymentReconciliationEngine();
    return instance.processQueue();
  },
};
