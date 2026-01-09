/**
 * Cleanup duplicate draft invoices
 *
 * Root cause: Each over-invoiced order has:
 * 1. A posted VCS invoice (VIT/xxxx)
 * 2. A draft invoice ("/") - likely created by Odoo's native invoice wizard
 *
 * Both are linked to the same sale order lines, doubling qty_invoiced.
 *
 * Solution: Delete the draft "/" invoices where a posted invoice already exists.
 *
 * Usage:
 *   node scripts/cleanup-duplicate-invoices.js          # Dry run
 *   node scripts/cleanup-duplicate-invoices.js --delete # Actually delete
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const dryRun = !process.argv.includes('--delete');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Cleanup Duplicate Draft Invoices ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : '⚠️  LIVE - WILL DELETE'}\n`);

  // Find all draft invoices with "/" name
  const draftInvoices = await odoo.searchRead('account.move',
    [
      ['state', '=', 'draft'],
      ['name', '=', '/'],
      ['move_type', '=', 'out_invoice'],
      ['invoice_origin', '!=', false]  // Has an origin (linked to sale order)
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'amount_total', 'partner_id', 'invoice_line_ids'],
    { limit: 10000 }
  );

  console.log(`Found ${draftInvoices.length} draft invoices with "/" name\n`);

  if (draftInvoices.length === 0) {
    console.log('No draft invoices to clean up.');
    return;
  }

  // Get all unique origins from draft invoices
  const origins = [...new Set(draftInvoices.map(d => d.invoice_origin).filter(Boolean))];
  const refs = [...new Set(draftInvoices.map(d => d.ref).filter(Boolean))];

  console.log(`Fetching posted invoices for ${origins.length} unique origins...`);

  // Fetch all posted invoices with matching origins in batch
  const postedInvoices = await odoo.searchRead('account.move',
    [
      '|',
      ['invoice_origin', 'in', origins],
      ['ref', 'in', refs],
      ['state', '=', 'posted'],
      ['move_type', '=', 'out_invoice']
    ],
    ['id', 'name', 'state', 'amount_total', 'invoice_origin', 'ref'],
    { limit: 100000 }
  );

  console.log(`Found ${postedInvoices.length} posted invoices\n`);

  // Create lookup maps for fast matching
  const postedByOrigin = {};
  const postedByRef = {};
  for (const inv of postedInvoices) {
    if (inv.invoice_origin) postedByOrigin[inv.invoice_origin] = inv;
    if (inv.ref) postedByRef[inv.ref] = inv;
  }

  // Match drafts with posted invoices
  let toDelete = [];
  let alreadyOnly = [];

  for (const draft of draftInvoices) {
    const postedByOrig = draft.invoice_origin && postedByOrigin[draft.invoice_origin];
    const postedByR = draft.ref && postedByRef[draft.ref];
    const matchedPosted = postedByOrig || postedByR;

    if (matchedPosted) {
      toDelete.push({
        draft,
        postedInvoice: matchedPosted
      });
    } else {
      alreadyOnly.push(draft);
    }
  }

  console.log(`Drafts with existing posted invoice (WILL DELETE): ${toDelete.length}`);
  console.log(`Drafts without posted invoice (WILL KEEP): ${alreadyOnly.length}\n`);

  if (toDelete.length === 0) {
    console.log('No duplicate drafts to delete.');
    return;
  }

  // Show first 20 examples
  console.log('=== Examples of drafts to delete ===\n');
  for (const item of toDelete.slice(0, 20)) {
    console.log(`Draft ID ${item.draft.id}:`);
    console.log(`  Origin: ${item.draft.invoice_origin}`);
    console.log(`  Amount: €${item.draft.amount_total?.toFixed(2)}`);
    console.log(`  Posted invoice: ${item.postedInvoice.name} (€${item.postedInvoice.amount_total?.toFixed(2)})`);
    console.log('');
  }

  if (dryRun) {
    console.log('=== DRY RUN - No changes made ===');
    console.log(`Would delete ${toDelete.length} draft invoices`);
    console.log('\nRun with --delete flag to actually delete:');
    console.log('  node scripts/cleanup-duplicate-invoices.js --delete');
    return;
  }

  // Actually delete the drafts
  console.log('=== DELETING DRAFT INVOICES ===\n');

  let deleted = 0;
  let errors = [];

  for (const item of toDelete) {
    try {
      // Odoo requires draft moves to be unlinked (not canceled)
      // Use the unlink method
      await odoo.execute('account.move', 'unlink', [[item.draft.id]]);
      deleted++;
      console.log(`✓ Deleted draft ${item.draft.id} (origin: ${item.draft.invoice_origin})`);
    } catch (error) {
      // If unlink fails, try button_cancel first
      try {
        await odoo.execute('account.move', 'button_cancel', [[item.draft.id]]);
        await odoo.execute('account.move', 'unlink', [[item.draft.id]]);
        deleted++;
        console.log(`✓ Canceled and deleted draft ${item.draft.id}`);
      } catch (error2) {
        errors.push({ id: item.draft.id, origin: item.draft.invoice_origin, error: error2.message });
        console.log(`✗ Failed to delete draft ${item.draft.id}: ${error2.message}`);
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Deleted: ${deleted}`);
  console.log(`Errors: ${errors.length}`);

  if (errors.length > 0) {
    console.log('\nFailed deletions:');
    for (const err of errors.slice(0, 10)) {
      console.log(`  ID ${err.id} (${err.origin}): ${err.error}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
