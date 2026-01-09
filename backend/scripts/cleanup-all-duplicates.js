/**
 * Comprehensive cleanup of duplicate invoices
 *
 * Handles:
 * 1. Draft duplicates (name="/") - Delete directly
 * 2. Posted duplicates (same origin+amount+date) - Reset to draft, then cancel
 *
 * Usage:
 *   node scripts/cleanup-all-duplicates.js              # Dry run
 *   node scripts/cleanup-all-duplicates.js --execute    # Actually clean up
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const dryRun = !process.argv.includes('--execute');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Comprehensive Duplicate Invoice Cleanup ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : '⚠️  LIVE - WILL MODIFY INVOICES'}\n`);

  const stats = {
    draftDeleted: 0,
    postedCanceled: 0,
    errors: []
  };

  // ==================== PART 1: Draft Duplicates ====================
  console.log('=== PART 1: Draft Duplicate Invoices ===\n');

  const draftInvoices = await odoo.searchRead('account.move',
    [
      ['state', '=', 'draft'],
      ['name', '=', '/'],
      ['move_type', '=', 'out_invoice'],
      ['invoice_origin', '!=', false]
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'amount_total'],
    { limit: 10000 }
  );

  console.log(`Found ${draftInvoices.length} draft invoices with "/" name`);

  // Get origins and check for posted counterparts
  const draftOrigins = [...new Set(draftInvoices.map(d => d.invoice_origin).filter(Boolean))];
  const postedForDrafts = await odoo.searchRead('account.move',
    [
      ['invoice_origin', 'in', draftOrigins],
      ['state', '=', 'posted'],
      ['move_type', '=', 'out_invoice']
    ],
    ['id', 'invoice_origin'],
    { limit: 100000 }
  );

  const postedOriginsSet = new Set(postedForDrafts.map(p => p.invoice_origin));
  const draftsToDelete = draftInvoices.filter(d => postedOriginsSet.has(d.invoice_origin));

  console.log(`Drafts with existing posted invoice: ${draftsToDelete.length}`);

  if (!dryRun && draftsToDelete.length > 0) {
    console.log('Deleting draft duplicates...');
    for (const draft of draftsToDelete) {
      try {
        await odoo.execute('account.move', 'unlink', [[draft.id]]);
        stats.draftDeleted++;
        if (stats.draftDeleted % 10 === 0) {
          console.log(`  Deleted ${stats.draftDeleted}/${draftsToDelete.length} drafts`);
        }
      } catch (error) {
        stats.errors.push({ type: 'draft', id: draft.id, error: error.message });
      }
    }
    console.log(`✓ Deleted ${stats.draftDeleted} draft duplicates\n`);
  } else if (draftsToDelete.length > 0) {
    console.log(`Would delete ${draftsToDelete.length} draft duplicates\n`);
  }

  // ==================== PART 2: Posted Duplicates ====================
  console.log('=== PART 2: Posted Duplicate Invoices ===\n');

  const allPostedInvoices = await odoo.searchRead('account.move',
    [
      ['state', '=', 'posted'],
      ['move_type', '=', 'out_invoice'],
      ['invoice_origin', '!=', false]
    ],
    ['id', 'name', 'invoice_origin', 'amount_total', 'invoice_date'],
    { limit: 200000 }
  );

  console.log(`Total posted invoices: ${allPostedInvoices.length}`);

  // Group by origin+amount+date to find TRUE duplicates
  const byKey = {};
  for (const inv of allPostedInvoices) {
    const key = `${inv.invoice_origin}|${inv.amount_total?.toFixed(2)}|${inv.invoice_date}`;
    if (!byKey[key]) {
      byKey[key] = [];
    }
    byKey[key].push(inv);
  }

  // Find groups with duplicates
  const duplicateGroups = Object.entries(byKey)
    .filter(([_, invs]) => invs.length > 1);

  // Collect all invoices to cancel (keep first, cancel the rest)
  const invoicesToCancel = [];
  for (const [_, invs] of duplicateGroups) {
    // Sort by ID (oldest first) and keep the first
    invs.sort((a, b) => a.id - b.id);
    for (const inv of invs.slice(1)) {
      invoicesToCancel.push(inv);
    }
  }

  console.log(`Duplicate groups found: ${duplicateGroups.length}`);
  console.log(`Posted invoices to cancel: ${invoicesToCancel.length}`);

  // Calculate over-invoiced value
  const totalOverValue = invoicesToCancel.reduce((sum, inv) => sum + (inv.amount_total || 0), 0);
  console.log(`Total over-invoiced value: €${totalOverValue.toFixed(2)}\n`);

  if (!dryRun && invoicesToCancel.length > 0) {
    console.log('Canceling posted duplicates...');
    console.log('(This resets to draft, then cancels the invoice)\n');

    for (const inv of invoicesToCancel) {
      try {
        // Step 1: Reset to draft
        await odoo.execute('account.move', 'button_draft', [[inv.id]]);

        // Step 2: Cancel
        await odoo.execute('account.move', 'button_cancel', [[inv.id]]);

        stats.postedCanceled++;
        if (stats.postedCanceled % 20 === 0) {
          console.log(`  Canceled ${stats.postedCanceled}/${invoicesToCancel.length}: ${inv.name}`);
        }
      } catch (error) {
        stats.errors.push({ type: 'posted', id: inv.id, name: inv.name, error: error.message });
        // Try alternative approach
        try {
          // Some Odoo configs don't allow button_draft, try creating credit note instead
          console.log(`  Warning: Could not cancel ${inv.name}, skipping: ${error.message}`);
        } catch (e2) {
          // Skip
        }
      }
    }
    console.log(`✓ Canceled ${stats.postedCanceled} posted duplicates\n`);
  } else if (invoicesToCancel.length > 0) {
    console.log(`Would cancel ${invoicesToCancel.length} posted duplicates`);
    console.log('\nFirst 10 examples:');
    for (const inv of invoicesToCancel.slice(0, 10)) {
      console.log(`  ${inv.name} | Origin: ${inv.invoice_origin} | €${inv.amount_total?.toFixed(2)}`);
    }
    console.log('');
  }

  // ==================== SUMMARY ====================
  console.log('='.repeat(60));
  console.log('=== SUMMARY ===\n');

  if (dryRun) {
    console.log('DRY RUN - No changes made\n');
    console.log(`Would delete: ${draftsToDelete.length} draft duplicates`);
    console.log(`Would cancel: ${invoicesToCancel.length} posted duplicates`);
    console.log(`Would correct: €${totalOverValue.toFixed(2)} in over-invoicing`);
    console.log('\nRun with --execute flag to apply changes:');
    console.log('  node scripts/cleanup-all-duplicates.js --execute');
  } else {
    console.log(`Draft duplicates deleted: ${stats.draftDeleted}`);
    console.log(`Posted duplicates canceled: ${stats.postedCanceled}`);
    console.log(`Errors: ${stats.errors.length}`);

    if (stats.errors.length > 0) {
      console.log('\nErrors encountered:');
      for (const err of stats.errors.slice(0, 20)) {
        console.log(`  ${err.type} ID ${err.id} (${err.name || 'draft'}): ${err.error}`);
      }
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
