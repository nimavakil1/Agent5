/**
 * Duplicate Invoice Cleanup Script
 *
 * Step 1: Backup all duplicate invoices from Odoo
 * Step 2: Delete draft duplicates (name="/")
 * Step 3: Cancel posted duplicates (create credit note reversals)
 *
 * Usage:
 *   node scripts/cleanup-duplicate-invoices.js --backup     # Step 1: Backup only
 *   node scripts/cleanup-duplicate-invoices.js --verify     # Verify a few duplicates
 *   node scripts/cleanup-duplicate-invoices.js --delete-drafts  # Step 2: Delete drafts
 *   node scripts/cleanup-duplicate-invoices.js --cancel-posted --limit 10  # Step 3: Test cancel 10
 *   node scripts/cleanup-duplicate-invoices.js --cancel-posted --execute   # Step 3: Cancel all posted
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Read the CSV file to get invoice IDs
const CSV_PATH = '/Users/nimavakil/Downloads/duplicate_invoices_cleanup_report.csv';

function parseCSV() {
  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.trim().split('\n');

  const drafts = [];
  const posted = [];

  for (let i = 1; i < lines.length; i++) {
    // Parse CSV properly (handle quoted fields)
    const row = parseCSVLine(lines[i]);
    if (row.length < 10) continue;

    const record = {
      type: row[0],
      action: row[1],
      invoiceId: parseInt(row[2]),
      invoiceName: row[3].replace(/"/g, ''),
      state: row[4],
      saleOrder: row[5].replace(/"/g, ''),
      amazonOrderId: row[6].replace(/"/g, ''),
      invoiceDate: row[7],
      amount: parseFloat(row[8]),
      keepInvoiceName: row[9].replace(/"/g, ''),
      keepInvoiceId: parseInt(row[10]),
      groupSize: parseInt(row[11])
    };

    if (record.type === 'Draft Duplicate') {
      drafts.push(record);
    } else if (record.type === 'Posted Duplicate') {
      posted.push(record);
    }
  }

  return { drafts, posted };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);

  return result;
}

async function backupInvoices(odoo, invoiceIds) {
  console.log('\nBacking up ' + invoiceIds.length + ' invoices from Odoo...');

  const backup = [];
  const batchSize = 100;

  for (let i = 0; i < invoiceIds.length; i += batchSize) {
    const batch = invoiceIds.slice(i, i + batchSize);
    console.log('  Fetching batch ' + (Math.floor(i/batchSize) + 1) + '/' + Math.ceil(invoiceIds.length/batchSize) + '...');

    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', batch]],
      ['id', 'name', 'state', 'move_type', 'invoice_origin', 'ref', 'invoice_date',
       'amount_total', 'amount_untaxed', 'amount_tax', 'partner_id', 'journal_id',
       'invoice_line_ids', 'create_date', 'write_date']
    );

    backup.push(...invoices);
  }

  return backup;
}

async function verifyDuplicates(odoo, drafts, posted) {
  console.log('\n=== VERIFICATION ===\n');

  // Verify 3 draft duplicates
  console.log('Verifying 3 draft duplicates:');
  for (let i = 0; i < Math.min(3, drafts.length); i++) {
    const draft = drafts[i];
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', [draft.invoiceId, draft.keepInvoiceId]]],
      ['id', 'name', 'state', 'invoice_origin', 'amount_total']
    );

    console.log('\n  Order: ' + draft.saleOrder);
    for (const inv of invoices) {
      const isDuplicate = inv.id === draft.invoiceId;
      console.log('    ' + (isDuplicate ? 'DUPLICATE' : 'KEEP     ') + ': ID=' + inv.id + ', Name=' + inv.name + ', State=' + inv.state + ', Amount=' + inv.amount_total);
    }
  }

  // Verify 3 posted duplicates
  console.log('\n\nVerifying 3 posted duplicates:');
  for (let i = 0; i < Math.min(3, posted.length); i++) {
    const dup = posted[i];
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', [dup.invoiceId, dup.keepInvoiceId]]],
      ['id', 'name', 'state', 'invoice_origin', 'amount_total']
    );

    console.log('\n  Order: ' + dup.saleOrder);
    for (const inv of invoices) {
      const isDuplicate = inv.id === dup.invoiceId;
      console.log('    ' + (isDuplicate ? 'DUPLICATE' : 'KEEP     ') + ': ID=' + inv.id + ', Name=' + inv.name + ', State=' + inv.state + ', Amount=' + inv.amount_total);
    }
  }
}

async function deleteDraftInvoices(odoo, drafts, dryRun = true) {
  console.log('\n=== ' + (dryRun ? 'DRY RUN: ' : '') + 'DELETING DRAFT DUPLICATES ===\n');
  console.log('Total draft duplicates to delete: ' + drafts.length);
  console.log('Total value: EUR ' + drafts.reduce((sum, d) => sum + d.amount, 0).toFixed(2) + '\n');

  if (dryRun) {
    console.log('DRY RUN - No changes will be made.');
    console.log('Run with --delete-drafts --execute to actually delete.\n');
    return { deleted: 0, errors: [] };
  }

  const results = {
    deleted: 0,
    skipped: 0,
    errors: []
  };

  for (const draft of drafts) {
    try {
      // Verify it's still a draft
      const invoice = await odoo.searchRead('account.move',
        [['id', '=', draft.invoiceId]],
        ['id', 'name', 'state']
      );

      if (invoice.length === 0) {
        console.log('  SKIP: Invoice ID ' + draft.invoiceId + ' not found (already deleted?)');
        results.skipped++;
        continue;
      }

      if (invoice[0].state !== 'draft') {
        console.log('  SKIP: Invoice ID ' + draft.invoiceId + ' is no longer draft (state=' + invoice[0].state + ')');
        results.skipped++;
        continue;
      }

      // Delete the draft invoice
      await odoo.execute('account.move', 'unlink', [[draft.invoiceId]]);
      results.deleted++;
      console.log('  DELETED: ID=' + draft.invoiceId + ' (' + draft.saleOrder + ') - EUR ' + draft.amount);

    } catch (error) {
      console.error('  ERROR: ID=' + draft.invoiceId + ' - ' + error.message);
      results.errors.push({ invoiceId: draft.invoiceId, error: error.message });
    }
  }

  console.log('\nDeletion complete: ' + results.deleted + ' deleted, ' + results.skipped + ' skipped, ' + results.errors.length + ' errors');
  return results;
}

/**
 * Cancel posted invoices by creating credit note reversals
 * Uses December 2025 date for closed accounting periods
 */
async function cancelPostedInvoices(odoo, posted, options = {}) {
  const { dryRun = true, limit = null } = options;
  const CANCELLATION_DATE = '2025-12-31';  // December 2025 for closed periods

  const toProcess = limit ? posted.slice(0, limit) : posted;

  console.log('\n=== ' + (dryRun ? 'DRY RUN: ' : '') + 'CANCELING POSTED DUPLICATES ===\n');
  console.log('Total posted duplicates to cancel: ' + toProcess.length + ' of ' + posted.length);
  console.log('Total value: EUR ' + toProcess.reduce((sum, d) => sum + d.amount, 0).toFixed(2));
  console.log('Cancellation date: ' + CANCELLATION_DATE + ' (December 2025)\n');

  if (dryRun) {
    console.log('DRY RUN - No changes will be made.');
    console.log('Run with --cancel-posted --execute to actually cancel.');
    if (limit) {
      console.log('Use --limit N to process only N invoices (default: all).\n');
    }

    // Show preview of invoices to be cancelled
    console.log('\nInvoices to be cancelled:');
    for (let i = 0; i < Math.min(10, toProcess.length); i++) {
      const inv = toProcess[i];
      console.log('  ' + (i + 1) + '. ' + inv.invoiceName + ' - EUR ' + inv.amount.toFixed(2) + ' (' + inv.invoiceDate + ') - ' + inv.saleOrder);
    }
    if (toProcess.length > 10) {
      console.log('  ... and ' + (toProcess.length - 10) + ' more');
    }

    return { cancelled: 0, skipped: 0, errors: [] };
  }

  const results = {
    cancelled: 0,
    skipped: 0,
    errors: [],
    creditNotes: []
  };

  for (let i = 0; i < toProcess.length; i++) {
    const dup = toProcess[i];
    const progress = '[' + (i + 1) + '/' + toProcess.length + ']';

    try {
      // Verify invoice still exists and is posted
      const invoice = await odoo.searchRead('account.move',
        [['id', '=', dup.invoiceId]],
        ['id', 'name', 'state', 'payment_state', 'amount_total', 'journal_id']
      );

      if (invoice.length === 0) {
        console.log(progress + '  SKIP: Invoice ID ' + dup.invoiceId + ' not found');
        results.skipped++;
        continue;
      }

      const inv = invoice[0];

      if (inv.state === 'cancel') {
        console.log(progress + '  SKIP: ' + inv.name + ' already cancelled');
        results.skipped++;
        continue;
      }

      if (inv.state !== 'posted') {
        console.log(progress + '  SKIP: ' + inv.name + ' state is ' + inv.state + ' (expected posted)');
        results.skipped++;
        continue;
      }

      if (inv.payment_state === 'paid' || inv.payment_state === 'in_payment') {
        console.log(progress + '  SKIP: ' + inv.name + ' has payment (payment_state=' + inv.payment_state + ')');
        results.skipped++;
        continue;
      }

      // Get journal ID from invoice
      const journalId = inv.journal_id ? inv.journal_id[0] : null;
      if (!journalId) {
        console.log(progress + '  SKIP: ' + inv.name + ' has no journal_id');
        results.skipped++;
        continue;
      }

      // Create reversal (credit note) using account.move.reversal wizard
      const reversalWizardId = await odoo.execute('account.move.reversal', 'create', [{
        move_ids: [[6, 0, [dup.invoiceId]]],
        date: CANCELLATION_DATE,
        reason: 'Duplicate invoice cleanup - ' + new Date().toISOString().split('T')[0],
        refund_method: 'cancel',  // 'cancel' = create reversal and reconcile
        journal_id: journalId
      }]);

      // Execute the reversal wizard
      const reversalResult = await odoo.execute('account.move.reversal', 'reverse_moves', [[reversalWizardId]]);

      // Get the created credit note ID from result
      let creditNoteId = null;
      if (reversalResult && reversalResult.res_id) {
        creditNoteId = reversalResult.res_id;
      }

      results.cancelled++;
      results.creditNotes.push({
        originalInvoiceId: dup.invoiceId,
        originalInvoiceName: inv.name,
        creditNoteId: creditNoteId,
        amount: inv.amount_total
      });

      console.log(progress + '  CANCELLED: ' + inv.name + ' - EUR ' + inv.amount_total + ' (CN: ' + creditNoteId + ')');

    } catch (error) {
      console.error(progress + '  ERROR: ID=' + dup.invoiceId + ' - ' + error.message);
      results.errors.push({
        invoiceId: dup.invoiceId,
        invoiceName: dup.invoiceName,
        error: error.message
      });
    }
  }

  console.log('\nCancellation complete:');
  console.log('  Cancelled: ' + results.cancelled);
  console.log('  Skipped: ' + results.skipped);
  console.log('  Errors: ' + results.errors.length);

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const doBackup = args.includes('--backup');
  const doVerify = args.includes('--verify');
  const doDeleteDrafts = args.includes('--delete-drafts');
  const doCancelPosted = args.includes('--cancel-posted');
  const execute = args.includes('--execute');

  // Parse --limit N
  let limit = null;
  const limitIndex = args.indexOf('--limit');
  if (limitIndex !== -1 && args[limitIndex + 1]) {
    limit = parseInt(args[limitIndex + 1]);
  }

  if (!doBackup && !doVerify && !doDeleteDrafts && !doCancelPosted) {
    console.log('Duplicate Invoice Cleanup Script');
    console.log('================================\n');
    console.log('Usage:');
    console.log('  node scripts/cleanup-duplicate-invoices.js --backup           # Backup all duplicates');
    console.log('  node scripts/cleanup-duplicate-invoices.js --verify           # Verify duplicates in Odoo');
    console.log('  node scripts/cleanup-duplicate-invoices.js --delete-drafts    # Dry run delete drafts');
    console.log('  node scripts/cleanup-duplicate-invoices.js --delete-drafts --execute  # Actually delete drafts');
    console.log('  node scripts/cleanup-duplicate-invoices.js --cancel-posted --limit 10 # Dry run cancel 10 posted');
    console.log('  node scripts/cleanup-duplicate-invoices.js --cancel-posted --limit 10 --execute  # Cancel 10 posted');
    console.log('  node scripts/cleanup-duplicate-invoices.js --cancel-posted --execute  # Cancel ALL posted');
    process.exit(0);
  }

  // Parse the CSV
  console.log('Parsing CSV file...');
  const { drafts, posted } = parseCSV();
  console.log('Found ' + drafts.length + ' draft duplicates and ' + posted.length + ' posted duplicates');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Step 1: Backup
  if (doBackup) {
    const allInvoiceIds = [
      ...drafts.map(d => d.invoiceId),
      ...drafts.map(d => d.keepInvoiceId),
      ...posted.map(p => p.invoiceId),
      ...posted.map(p => p.keepInvoiceId)
    ];
    const uniqueIds = [...new Set(allInvoiceIds)];

    const backup = await backupInvoices(odoo, uniqueIds);

    const backupPath = '/Users/nimavakil/Downloads/duplicate_invoices_backup_' + new Date().toISOString().split('T')[0] + '.json';
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log('\nBackup saved to: ' + backupPath);
    console.log('Backed up ' + backup.length + ' invoices');
  }

  // Verify
  if (doVerify) {
    await verifyDuplicates(odoo, drafts, posted);
  }

  // Step 2: Delete drafts
  if (doDeleteDrafts) {
    const results = await deleteDraftInvoices(odoo, drafts, !execute);

    if (execute) {
      // Save deletion results
      const resultsPath = '/Users/nimavakil/Downloads/draft_deletion_results_' + new Date().toISOString().split('T')[0] + '.json';
      fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
      console.log('\nResults saved to: ' + resultsPath);
    }
  }

  // Step 3: Cancel posted duplicates
  if (doCancelPosted) {
    const results = await cancelPostedInvoices(odoo, posted, {
      dryRun: !execute,
      limit: limit
    });

    if (execute) {
      // Save cancellation results
      const resultsPath = '/Users/nimavakil/Downloads/posted_cancellation_results_' + new Date().toISOString().split('T')[0] + '.json';
      fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
      console.log('\nResults saved to: ' + resultsPath);
    }
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
