/**
 * VcsReconciliationService - Reconcile VCS invoices with settlement data
 *
 * When a settlement is processed, Amazon deposits a lump sum for all orders.
 * VCS invoices are created individually per order. Both sides post to the same
 * marketplace-specific receivable account (400102XX).
 *
 * This service matches settlement order IDs to VCS invoices in Odoo,
 * then uses Odoo's native account.move.line.reconcile() to mark invoices as paid.
 *
 * Flow:
 * 1. Load unreconciled settlement orders from MongoDB (amazon_settlement_orders)
 * 2. For each order_id, find matching VCS invoice in Odoo (by ref or invoice_origin)
 * 3. Post draft invoices if needed
 * 4. Collect receivable (400102XX) move lines from both sides
 * 5. Call account.move.line.reconcile() to let Odoo handle partial/full reconciliation
 * 6. Update MongoDB reconciliation status
 */

const { MARKETPLACE_RECEIVABLE_ACCOUNTS } = require('../amazon/VcsOdooInvoicer');

class VcsReconciliationService {
  constructor(odooClient) {
    this.odoo = odooClient;
  }

  /**
   * Reconcile VCS invoices for a single settlement.
   *
   * @param {object} db - MongoDB database instance
   * @param {string} settlementId - Settlement ID to reconcile
   * @param {object} options
   * @param {boolean} options.dryRun - If true, only report what would happen (default: true)
   * @returns {object} Reconciliation results
   */
  async reconcileSettlement(db, settlementId, options = {}) {
    const { dryRun = true } = options;

    console.log(`\n[VcsReconciliation] Processing settlement ${settlementId} (${dryRun ? 'DRY RUN' : 'EXECUTE'})...`);

    // Get unreconciled orders for this settlement
    const orders = await db.collection('amazon_settlement_orders')
      .find({ settlementId, reconciled: { $ne: true } })
      .toArray();

    if (orders.length === 0) {
      // Try to extract from the settlement's transactions array (older upload format)
      const settlement = await db.collection('amazon_settlements').findOne({ settlementId });
      if (settlement && settlement.transactions) {
        return this._reconcileFromTransactions(db, settlement, options);
      }

      console.log(`[VcsReconciliation] No unreconciled orders found for settlement ${settlementId}`);
      return { settlementId, matched: 0, reconciled: 0, unmatched: 0, errors: [] };
    }

    console.log(`[VcsReconciliation] Found ${orders.length} unreconciled orders`);

    const result = {
      settlementId,
      totalOrders: orders.length,
      matched: 0,
      reconciled: 0,
      unmatched: 0,
      alreadyReconciled: 0,
      posted: 0,
      errors: [],
      details: [],
    };

    for (const order of orders) {
      try {
        const detail = await this._reconcileOrder(db, order, dryRun);
        result.details.push(detail);

        if (detail.status === 'reconciled') {
          result.reconciled++;
          result.matched++;
        } else if (detail.status === 'matched') {
          result.matched++;
        } else if (detail.status === 'already_reconciled') {
          result.alreadyReconciled++;
        } else {
          result.unmatched++;
        }

        if (detail.posted) result.posted++;
      } catch (error) {
        result.errors.push({ orderId: order.orderId, error: error.message });
        result.details.push({ orderId: order.orderId, status: 'error', error: error.message });
      }
    }

    console.log(`[VcsReconciliation] Settlement ${settlementId}: ${result.matched} matched, ${result.reconciled} reconciled, ${result.unmatched} unmatched, ${result.errors.length} errors`);

    return result;
  }

  /**
   * Handle older settlements that have transactions stored inline
   */
  async _reconcileFromTransactions(db, settlement, options) {
    const { dryRun = true } = options;
    const orderTransactionTypes = ['Order', 'Refund', 'Chargeback'];

    // Extract unique order IDs from transactions
    const orderIds = new Set();
    for (const tx of (settlement.transactions || [])) {
      const txType = tx.transactionType || '';
      const orderId = tx.orderId;
      if (orderId && orderTransactionTypes.some(t => txType.includes(t))) {
        orderIds.add(orderId);
      }
    }

    if (orderIds.size === 0) {
      console.log(`[VcsReconciliation] No order IDs found in settlement ${settlement.settlementId} transactions`);
      return { settlementId: settlement.settlementId, matched: 0, reconciled: 0, unmatched: 0, errors: [] };
    }

    // Backfill amazon_settlement_orders for future runs
    if (!dryRun) {
      const bulkOps = [...orderIds].map(orderId => ({
        updateOne: {
          filter: { settlementId: settlement.settlementId, orderId },
          update: {
            $set: { settlementId: settlement.settlementId, orderId, updatedAt: new Date() },
            $setOnInsert: { reconciled: false, odooInvoiceId: null, createdAt: new Date() },
          },
          upsert: true,
        },
      }));
      await db.collection('amazon_settlement_orders').bulkWrite(bulkOps);
    }

    // Now reconcile using the standard path
    return this.reconcileSettlement(db, settlement.settlementId, options);
  }

  /**
   * Reconcile a single order: find its Odoo invoice and reconcile.
   */
  async _reconcileOrder(db, order, dryRun) {
    const { orderId, marketplace } = order;

    // Step 1: Find the VCS invoice in Odoo by Amazon order ID
    const invoice = await this._findVcsInvoice(orderId);

    if (!invoice) {
      return { orderId, status: 'unmatched', reason: 'No invoice found in Odoo' };
    }

    // Step 2: Check if invoice's receivable line is already reconciled
    const receivableAccountId = MARKETPLACE_RECEIVABLE_ACCOUNTS[marketplace] ||
                                 MARKETPLACE_RECEIVABLE_ACCOUNTS['BE'];

    const invoiceLines = await this.odoo.searchRead('account.move.line', [
      ['move_id', '=', invoice.id],
      ['account_id', '=', receivableAccountId],
      ['reconciled', '=', false],
    ], ['id', 'debit', 'credit', 'amount_residual'], { limit: 5 });

    if (invoiceLines.length === 0) {
      // Check if already reconciled
      const allLines = await this.odoo.searchRead('account.move.line', [
        ['move_id', '=', invoice.id],
        ['account_id', '=', receivableAccountId],
      ], ['id', 'reconciled'], { limit: 5 });

      if (allLines.length > 0 && allLines.every(l => l.reconciled)) {
        if (!dryRun) {
          await db.collection('amazon_settlement_orders').updateOne(
            { settlementId: order.settlementId, orderId },
            { $set: { reconciled: true, odooInvoiceId: invoice.id, reconciledAt: new Date() } }
          );
        }
        return { orderId, invoiceId: invoice.id, invoiceName: invoice.name, status: 'already_reconciled' };
      }

      // No receivable line found at all — try without account filter
      return { orderId, invoiceId: invoice.id, invoiceName: invoice.name, status: 'unmatched', reason: `No unreconciled receivable line on account ${receivableAccountId}` };
    }

    // Step 3: Post the invoice if still draft
    let posted = false;
    if (invoice.state === 'draft') {
      if (dryRun) {
        return {
          orderId,
          invoiceId: invoice.id,
          invoiceName: invoice.name,
          status: 'matched',
          wouldPost: true,
          invoiceTotal: invoice.amount_total,
        };
      }

      try {
        await this.odoo.execute('account.move', 'action_post', [[invoice.id]]);
        posted = true;
        console.log(`[VcsReconciliation] Posted draft invoice ${invoice.name} (ID: ${invoice.id})`);
      } catch (postError) {
        return {
          orderId,
          invoiceId: invoice.id,
          invoiceName: invoice.name,
          status: 'error',
          error: `Failed to post invoice: ${postError.message}`,
        };
      }
    }

    if (dryRun) {
      return {
        orderId,
        invoiceId: invoice.id,
        invoiceName: invoice.name,
        status: 'matched',
        invoiceTotal: invoice.amount_total,
        receivableLines: invoiceLines.length,
      };
    }

    // Step 4: Find counterpart lines to reconcile with
    // Look for other unreconciled lines on the same receivable account
    // that are NOT from this invoice (settlement entry, payment, etc.)
    const counterpartLines = await this.odoo.searchRead('account.move.line', [
      ['move_id', '!=', invoice.id],
      ['account_id', '=', receivableAccountId],
      ['reconciled', '=', false],
      ['credit', '>', 0], // Settlement entries credit the receivable
    ], ['id', 'credit', 'amount_residual', 'move_id'], { limit: 100 });

    if (counterpartLines.length === 0) {
      return {
        orderId,
        invoiceId: invoice.id,
        invoiceName: invoice.name,
        status: 'matched',
        posted,
        reason: 'No counterpart (credit) lines found on receivable account — settlement entry may not exist yet',
      };
    }

    // Step 5: Reconcile the invoice's receivable debit line(s) with available credit lines
    // Odoo handles partial reconciliation natively
    const invoiceLineIds = invoiceLines.map(l => l.id);
    const counterpartLineIds = counterpartLines.map(l => l.id);
    const allLineIds = [...invoiceLineIds, ...counterpartLineIds];

    try {
      await this.odoo.execute('account.move.line', 'reconcile', [allLineIds]);
      console.log(`[VcsReconciliation] Reconciled order ${orderId}: invoice ${invoice.name} (${allLineIds.length} lines)`);

      // Update MongoDB
      await db.collection('amazon_settlement_orders').updateOne(
        { settlementId: order.settlementId, orderId },
        { $set: { reconciled: true, odooInvoiceId: invoice.id, reconciledAt: new Date() } }
      );

      return {
        orderId,
        invoiceId: invoice.id,
        invoiceName: invoice.name,
        status: 'reconciled',
        posted,
        linesReconciled: allLineIds.length,
      };
    } catch (reconcileError) {
      return {
        orderId,
        invoiceId: invoice.id,
        invoiceName: invoice.name,
        status: 'error',
        posted,
        error: `Reconciliation failed: ${reconcileError.message}`,
      };
    }
  }

  /**
   * Find VCS invoice in Odoo by Amazon order ID.
   * Searches ref field (primary) and invoice_origin field (fallback).
   */
  async _findVcsInvoice(orderId) {
    // Primary: search by ref (Amazon order ID stored in ref field)
    let invoices = await this.odoo.searchRead('account.move', [
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['ref', '=', orderId],
    ], ['id', 'name', 'state', 'amount_total', 'payment_state', 'ref', 'invoice_origin'], { limit: 5 });

    // Prefer posted invoices
    if (invoices.length > 1) {
      const posted = invoices.find(inv => inv.state === 'posted');
      if (posted) return posted;
    }

    if (invoices.length > 0) {
      return invoices[0];
    }

    // Fallback: search by invoice_origin (some invoices may have order ID there)
    invoices = await this.odoo.searchRead('account.move', [
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['invoice_origin', '=', orderId],
    ], ['id', 'name', 'state', 'amount_total', 'payment_state', 'ref', 'invoice_origin'], { limit: 5 });

    if (invoices.length > 1) {
      const posted = invoices.find(inv => inv.state === 'posted');
      if (posted) return posted;
    }

    return invoices[0] || null;
  }

  /**
   * Reconcile all unreconciled settlements.
   *
   * @param {object} db - MongoDB database instance
   * @param {object} options
   * @param {boolean} options.dryRun - Dry run mode (default: true)
   * @returns {object} Summary of all reconciliation results
   */
  async reconcileAll(db, options = {}) {
    const { dryRun = true } = options;

    // Find all settlements that have unreconciled orders
    const unreconciled = await db.collection('amazon_settlement_orders').aggregate([
      { $match: { reconciled: { $ne: true } } },
      { $group: { _id: '$settlementId', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();

    if (unreconciled.length === 0) {
      // Check for settlements with inline transactions that haven't been processed
      const settlements = await db.collection('amazon_settlements')
        .find({ transactions: { $exists: true, $ne: [] } })
        .project({ settlementId: 1 })
        .toArray();

      if (settlements.length > 0) {
        console.log(`[VcsReconciliation] Found ${settlements.length} settlements with inline transactions to process`);
        const results = [];
        for (const s of settlements) {
          const result = await this.reconcileSettlement(db, s.settlementId, { dryRun });
          results.push(result);
        }
        return this._summarizeResults(results);
      }

      console.log('[VcsReconciliation] No unreconciled settlement orders found');
      return { settlements: 0, totalOrders: 0, matched: 0, reconciled: 0, unmatched: 0, errors: 0 };
    }

    console.log(`[VcsReconciliation] Found ${unreconciled.length} settlements with unreconciled orders`);

    const results = [];
    for (const { _id: settlementId, count } of unreconciled) {
      console.log(`\n--- Settlement ${settlementId} (${count} unreconciled orders) ---`);
      const result = await this.reconcileSettlement(db, settlementId, { dryRun });
      results.push(result);
    }

    return this._summarizeResults(results);
  }

  /**
   * Summarize results from multiple settlement reconciliations
   */
  _summarizeResults(results) {
    const summary = {
      settlements: results.length,
      totalOrders: 0,
      matched: 0,
      reconciled: 0,
      unmatched: 0,
      alreadyReconciled: 0,
      posted: 0,
      errors: 0,
      results,
    };

    for (const r of results) {
      summary.totalOrders += r.totalOrders || 0;
      summary.matched += r.matched || 0;
      summary.reconciled += r.reconciled || 0;
      summary.unmatched += r.unmatched || 0;
      summary.alreadyReconciled += r.alreadyReconciled || 0;
      summary.posted += r.posted || 0;
      summary.errors += (r.errors || []).length;
    }

    return summary;
  }
}

module.exports = { VcsReconciliationService };
