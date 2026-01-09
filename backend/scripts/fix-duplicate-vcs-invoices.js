#!/usr/bin/env node
/**
 * Fix Duplicate VCS Invoices
 *
 * This script identifies and cleans up duplicate Amazon VCS invoices in Odoo.
 *
 * Strategy:
 * 1. Find all Amazon order IDs with multiple invoices
 * 2. For each duplicate set:
 *    - Keep the oldest posted invoice (or oldest if no posted)
 *    - Delete draft duplicates
 *    - Cancel posted duplicates (creates reversal entries)
 *
 * Usage:
 *   node scripts/fix-duplicate-vcs-invoices.js [--dry-run] [--limit N]
 *
 * Options:
 *   --dry-run    Show what would be done without making changes
 *   --limit N    Only process first N duplicate sets
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) || 100 : null;

// Only process invoices from 2025 onwards (2024 is locked)
const CUTOFF_DATE = '2025-01-01';

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  console.log('=== DUPLICATE VCS INVOICE CLEANUP ===');
  console.log('Mode:', dryRun ? 'DRY RUN (no changes)' : 'LIVE (making changes!)');
  console.log('Cutoff Date:', CUTOFF_DATE, '(skipping 2024 - locked period)');
  if (limit) console.log('Limit:', limit, 'duplicate sets');
  console.log('');

  // Step 1: Find all Amazon invoices (VFR, VDE, VIT, VBE, VNL, VES, VPL journals)
  console.log('Step 1: Fetching all Amazon VCS invoices...');

  let allInvoices = [];
  let offset = 0;
  const batchSize = 1000;

  while (true) {
    const batch = await odoo.searchRead('account.move',
      [
        ['move_type', '=', 'out_invoice'],
        ['ref', '!=', false],
        ['ref', 'like', '%-%-%'],
        '|', '|', '|', '|', '|', '|',
        ['journal_id.code', '=', 'VFR'],
        ['journal_id.code', '=', 'VDE'],
        ['journal_id.code', '=', 'VIT'],
        ['journal_id.code', '=', 'VBE'],
        ['journal_id.code', '=', 'VNL'],
        ['journal_id.code', '=', 'VES'],
        ['journal_id.code', '=', 'VPL'],
      ],
      ['id', 'name', 'ref', 'state', 'amount_total', 'create_date'],
      { limit: batchSize, offset, order: 'id asc' }
    );

    if (batch.length === 0) break;
    allInvoices = allInvoices.concat(batch);
    offset += batchSize;

    if (batch.length < batchSize) break;
  }

  console.log('Total VCS invoices found:', allInvoices.length);

  // Step 2: Group by Amazon order ID (ref field)
  console.log('\nStep 2: Grouping by Amazon order ID...');

  // Valid Amazon order ID pattern: XXX-XXXXXXX-XXXXXXX (e.g., 305-1901951-5970703)
  const amazonOrderIdPattern = /^\d{3}-\d{7}-\d{7}$/;

  const byRef = {};
  let skippedNonAmazon = 0;
  for (const inv of allInvoices) {
    if (!inv.ref) continue;
    // Only process valid Amazon order IDs
    if (!amazonOrderIdPattern.test(inv.ref)) {
      skippedNonAmazon++;
      continue;
    }
    byRef[inv.ref] = byRef[inv.ref] || [];
    byRef[inv.ref].push(inv);
  }
  console.log('Skipped non-Amazon order ID refs:', skippedNonAmazon);

  // Find duplicates (more than 1 invoice per ref)
  const duplicateSets = Object.entries(byRef)
    .filter(([ref, invoices]) => invoices.length > 1)
    .map(([ref, invoices]) => ({
      ref,
      invoices: invoices.sort((a, b) => new Date(a.create_date) - new Date(b.create_date))
    }));

  console.log('Order IDs with duplicates:', duplicateSets.length);

  if (duplicateSets.length === 0) {
    console.log('\nNo duplicates found. All clean!');
    return;
  }

  // Step 3: Process duplicates
  console.log('\nStep 3: Processing duplicates...\n');

  const toProcess = limit ? duplicateSets.slice(0, limit) : duplicateSets;

  let stats = {
    processed: 0,
    draftsDeleted: 0,
    postedCancelled: 0,
    kept: 0,
    errors: 0
  };

  for (const { ref, invoices } of toProcess) {
    try {
      stats.processed++;

      // Determine which to keep: first posted, or first if no posted
      const posted = invoices.filter(inv => inv.state === 'posted');
      const drafts = invoices.filter(inv => inv.state === 'draft');
      const cancelled = invoices.filter(inv => inv.state === 'cancel');

      // Keep the oldest posted invoice, or oldest draft if no posted
      const toKeep = posted[0] || drafts[0];

      // Filter: only delete/cancel invoices from 2025 onwards (skip 2024 - locked period)
      const toDelete = drafts.filter(inv => inv.id !== toKeep.id && inv.create_date >= CUTOFF_DATE);
      const toCancel = posted.filter(inv => inv.id !== toKeep.id && inv.create_date >= CUTOFF_DATE);
      const skipped2024 = invoices.filter(inv => inv.id !== toKeep.id && inv.create_date < CUTOFF_DATE);

      // Skip if nothing to clean up (all duplicates are in 2024)
      if (toDelete.length === 0 && toCancel.length === 0) {
        console.log(`[${stats.processed}/${toProcess.length}] ${ref} - SKIPPED (all duplicates in locked 2024 period)`);
        continue;
      }

      console.log(`[${stats.processed}/${toProcess.length}] ${ref}`);
      console.log(`  Total: ${invoices.length} | Posted: ${posted.length} | Draft: ${drafts.length} | Cancelled: ${cancelled.length}`);
      console.log(`  KEEP: ${toKeep.name || 'DRAFT'} (ID: ${toKeep.id}, €${toKeep.amount_total.toFixed(2)})`);

      // Delete draft duplicates
      for (const inv of toDelete) {
        console.log(`  DELETE: ${inv.name || 'DRAFT'} (ID: ${inv.id})`);
        if (!dryRun) {
          await odoo.unlink('account.move', [inv.id]);
        }
        stats.draftsDeleted++;
      }

      // Cancel posted duplicates (this creates reversal entries in Odoo)
      for (const inv of toCancel) {
        console.log(`  CANCEL: ${inv.name} (ID: ${inv.id}, €${inv.amount_total.toFixed(2)})`);
        if (!dryRun) {
          try {
            // Use button_cancel to properly cancel
            await odoo.execute('account.move', 'button_cancel', [[inv.id]]);
          } catch (cancelErr) {
            // If cancel fails (e.g., already reconciled), try draft then cancel
            console.log(`    Warning: Direct cancel failed, trying reset to draft first...`);
            try {
              await odoo.execute('account.move', 'button_draft', [[inv.id]]);
              await odoo.execute('account.move', 'button_cancel', [[inv.id]]);
            } catch (draftErr) {
              console.log(`    Error: Could not cancel invoice ${inv.name}: ${draftErr.message}`);
              stats.errors++;
              continue;
            }
          }
        }
        stats.postedCancelled++;
      }

      stats.kept++;
      console.log('');

    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      stats.errors++;
    }
  }

  // Summary
  console.log('=== SUMMARY ===');
  console.log('Duplicate sets processed:', stats.processed);
  console.log('Invoices kept:', stats.kept);
  console.log('Draft invoices deleted:', stats.draftsDeleted);
  console.log('Posted invoices cancelled:', stats.postedCancelled);
  console.log('Errors:', stats.errors);

  if (dryRun) {
    console.log('\n** DRY RUN - No changes were made **');
    console.log('Run without --dry-run to apply changes');
  }

  // Remaining duplicates
  const remaining = duplicateSets.length - toProcess.length;
  if (remaining > 0) {
    console.log(`\n${remaining} more duplicate sets to process. Run again or increase --limit`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
