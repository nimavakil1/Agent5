#!/usr/bin/env node
/**
 * Clean up draft invoices with "/" name that are blocking VCS processing
 *
 * Usage:
 *   node scripts/cleanup-draft-invoices.js --dry-run    # Preview what would be deleted
 *   node scripts/cleanup-draft-invoices.js --execute    # Actually delete the drafts
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');

  if (!dryRun && !execute) {
    console.log('Usage:');
    console.log('  node scripts/cleanup-draft-invoices.js --dry-run    # Preview');
    console.log('  node scripts/cleanup-draft-invoices.js --execute    # Delete drafts');
    process.exit(1);
  }

  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}\n`);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  // Find all draft invoices with "/" name
  const draftInvoices = await odoo.searchRead('account.move', [
    ['state', '=', 'draft'],
    ['name', '=', '/'],
    ['move_type', 'in', ['out_invoice', 'out_refund']]
  ], ['id', 'name', 'move_type', 'invoice_origin', 'amount_total', 'create_date', 'partner_id']);

  console.log(`Found ${draftInvoices.length} draft invoices/credit notes with "/" name\n`);

  if (draftInvoices.length === 0) {
    console.log('Nothing to clean up!');
    process.exit(0);
  }

  // Group by type
  const invoices = draftInvoices.filter(d => d.move_type === 'out_invoice');
  const creditNotes = draftInvoices.filter(d => d.move_type === 'out_refund');

  console.log(`  Invoices: ${invoices.length}`);
  console.log(`  Credit Notes: ${creditNotes.length}\n`);

  // Show some samples
  console.log('Sample invoices:');
  for (const inv of invoices.slice(0, 5)) {
    console.log(`  ID: ${inv.id}, origin: ${inv.invoice_origin || 'none'}, total: ${inv.amount_total}, created: ${inv.create_date}`);
  }
  if (invoices.length > 5) console.log(`  ... and ${invoices.length - 5} more`);

  console.log('\nSample credit notes:');
  for (const cn of creditNotes.slice(0, 5)) {
    console.log(`  ID: ${cn.id}, origin: ${cn.invoice_origin || 'none'}, total: ${cn.amount_total}, created: ${cn.create_date}`);
  }
  if (creditNotes.length > 5) console.log(`  ... and ${creditNotes.length - 5} more`);

  if (dryRun) {
    console.log(`\n[DRY RUN] Would delete ${draftInvoices.length} draft documents`);
    process.exit(0);
  }

  // Execute deletion
  console.log(`\nDeleting ${draftInvoices.length} draft documents...`);

  let deleted = 0;
  let errors = 0;

  // Delete in batches for efficiency
  const batchSize = 20;
  for (let i = 0; i < draftInvoices.length; i += batchSize) {
    const batch = draftInvoices.slice(i, i + batchSize);
    const ids = batch.map(d => d.id);
    try {
      await odoo.execute('account.move', 'unlink', [ids]);
      deleted += ids.length;
      console.log(`  Deleted batch ${Math.floor(i / batchSize) + 1}: ${ids.length} documents (total: ${deleted})`);
    } catch (err) {
      console.error(`  Error deleting batch: ${err.message}`);
      // Try one by one
      for (const doc of batch) {
        try {
          await odoo.execute('account.move', 'unlink', [[doc.id]]);
          deleted++;
        } catch (err2) {
          console.error(`    Error deleting ID ${doc.id}: ${err2.message}`);
          errors++;
        }
      }
    }
  }

  console.log(`\nDone! Deleted: ${deleted}, Errors: ${errors}`);
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
