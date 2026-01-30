#!/usr/bin/env node
/**
 * Fix VAT Issue Invoices
 *
 * Deletes invoices that incorrectly added VAT when VCS showed 0% tax
 * and resets the orders for reprocessing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { MongoClient } = require('mongodb');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const db = mongo.db(process.env.MONGO_DB_NAME || 'agent5');

  try {
    // Read the analysis results
    const results = JSON.parse(fs.readFileSync('/tmp/vcs-mismatch-analysis.json'));

    // Get all VAT issue invoice IDs
    const vatIssueOrders = [
      ...results.amazonInvoicedWithVat,
      ...results.odooHigher.filter(r => r.vatAddedWhenVcsSaysZero)
    ];

    const allIds = vatIssueOrders.map(o => o.odooInvoiceId);

    // Get existing invoices
    const existing = await odoo.searchRead('account.move',
      [['id', 'in', allIds]],
      ['id', 'name', 'state', 'ref']
    );

    console.log('Found', existing.length, 'existing invoices');

    // Separate by state
    const draft = existing.filter(i => i.state === 'draft');
    const posted = existing.filter(i => i.state === 'posted');
    const cancelled = existing.filter(i => i.state === 'cancel');

    console.log('Draft:', draft.length, '| Posted:', posted.length, '| Cancelled:', cancelled.length);

    // Delete draft invoices
    if (draft.length > 0) {
      console.log('\nDeleting', draft.length, 'draft invoices...');
      const draftIds = draft.map(i => i.id);
      await odoo.execute('account.move', 'unlink', [draftIds]);
      console.log('Deleted draft invoices');

      // Reset MongoDB status for these orders
      const draftRefs = draft.map(i => i.ref).filter(r => r);
      console.log('Resetting', draftRefs.length, 'orders in MongoDB...');
      await db.collection('amazon_vcs_orders').updateMany(
        { orderId: { $in: draftRefs } },
        { $unset: { odooInvoiceId: '', odooInvoiceName: '', invoicedAt: '' }, $set: { status: 'pending' } }
      );
      console.log('Reset MongoDB records');
    }

    // Cancel then delete posted invoices
    if (posted.length > 0) {
      console.log('\nTrying to cancel', posted.length, 'posted invoices...');
      const postedIds = posted.map(i => i.id);

      try {
        // First, reset to draft
        await odoo.execute('account.move', 'button_draft', [postedIds]);
        console.log('Reset to draft');

        // Then delete
        await odoo.execute('account.move', 'unlink', [postedIds]);
        console.log('Deleted former posted invoices');

        // Reset MongoDB
        const postedRefs = posted.map(i => i.ref).filter(r => r);
        await db.collection('amazon_vcs_orders').updateMany(
          { orderId: { $in: postedRefs } },
          { $unset: { odooInvoiceId: '', odooInvoiceName: '', invoicedAt: '' }, $set: { status: 'pending' } }
        );
        console.log('Reset MongoDB records');
      } catch (error) {
        if (error.message.includes('tax statement') || error.message.includes('tax lock')) {
          console.log('⚠️  Posted invoices are tax-locked and cannot be cancelled.');
          console.log('   These invoices are from before the tax lock date (31/12/2025).');
        } else {
          throw error;
        }
      }
    }

    // Delete cancelled invoices FIRST (before trying to cancel posted)
    if (cancelled.length > 0) {
      console.log('\nDeleting', cancelled.length, 'cancelled invoices...');
      const cancelledIds = cancelled.map(i => i.id);
      await odoo.execute('account.move', 'unlink', [cancelledIds]);
      console.log('Deleted cancelled invoices');

      // Reset MongoDB
      const cancelledRefs = cancelled.map(i => i.ref).filter(r => r);
      await db.collection('amazon_vcs_orders').updateMany(
        { orderId: { $in: cancelledRefs } },
        { $unset: { odooInvoiceId: '', odooInvoiceName: '', invoicedAt: '' }, $set: { status: 'pending' } }
      );
      // Remove cancelled from existing for later counting
      cancelled.forEach(c => existing.splice(existing.findIndex(e => e.id === c.id), 1));
    }

    // Also reset the orders that were already deleted from Odoo
    const existingIds = new Set(existing.map(e => e.id));
    const deletedFromOdoo = vatIssueOrders.filter(o => {
      return existingIds.has(o.odooInvoiceId) === false;
    });
    console.log('\nResetting', deletedFromOdoo.length, 'orders whose invoices were already deleted...');
    const deletedRefs = deletedFromOdoo.map(o => o.orderId);
    await db.collection('amazon_vcs_orders').updateMany(
      { orderId: { $in: deletedRefs } },
      { $unset: { odooInvoiceId: '', odooInvoiceName: '', invoicedAt: '' }, $set: { status: 'pending' } }
    );

    // Count how many orders are now pending
    const pendingCount = await db.collection('amazon_vcs_orders').countDocuments({ status: 'pending' });
    console.log('Total orders now pending for processing:', pendingCount);

    // Summary of what's left (tax-locked posted invoices)
    const remainingPosted = existing.filter(i => i.state === 'posted').length;
    if (remainingPosted > 0) {
      console.log('\n=== TAX-LOCKED INVOICES ===');
      console.log('Posted invoices still remaining:', remainingPosted);
      console.log('These are dated before the tax lock date and cannot be deleted.');
      console.log('Options:');
      console.log('1. Create credit notes to reverse the incorrect amounts');
      console.log('2. Change the tax lock date in Odoo Settings > Accounting > Lock Dates');
    } else {
      console.log('\nDone! All VAT issue invoices deleted and orders reset for reprocessing.');
    }

  } finally {
    await mongo.close();
  }
}

main().catch(console.error);
