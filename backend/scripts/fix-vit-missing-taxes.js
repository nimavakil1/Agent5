/**
 * Fix VIT invoices with missing taxes
 * Add IT*VAT tax to lines that have no tax
 * December 2025
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function safeExecute(odoo, model, method, args) {
  try {
    return await odoo.execute(model, method, args);
  } catch (err) {
    if (err.message && err.message.includes('cannot marshal None')) {
      return true;
    }
    throw err;
  }
}

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('='.repeat(100));
  console.log('Fix: VIT invoices with missing taxes - Add IT*VAT');
  console.log('='.repeat(100));

  // Get VIT journal
  const vitJournal = await odoo.searchRead('account.journal', [['code', '=', 'VIT']], ['id', 'name'], { limit: 1 });
  const vitJournalId = vitJournal[0].id;
  console.log('VIT Journal:', vitJournal[0]);

  // Get IT*VAT tax (22%)
  const itVatTaxes = await odoo.searchRead('account.tax',
    [['type_tax_use', '=', 'sale'], ['name', 'like', 'IT*VAT%']],
    ['id', 'name', 'amount'],
    { limit: 10 }
  );
  console.log('IT*VAT taxes found:', itVatTaxes.map(t => t.name + ' (' + t.id + ')').join(', '));

  // Use IT*VAT 22% as default
  const itVat22 = itVatTaxes.find(t => t.name.includes('22'));
  if (!itVat22) {
    console.error('ERROR: Could not find IT*VAT 22% tax');
    process.exit(1);
  }
  console.log('Using tax:', itVat22.name, '(ID:', itVat22.id + ')');

  // Find VIT invoices with lines that have no tax
  const linesNoTax = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', '=', vitJournalId],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['display_type', '=', 'product'],
      ['tax_ids', '=', false]
    ],
    ['id', 'move_id', 'name', 'price_subtotal'],
    { limit: 500 }
  );

  console.log('\nLines without tax:', linesNoTax.length);

  // Group by invoice
  const byInvoice = {};
  for (const line of linesNoTax) {
    const moveId = line.move_id ? line.move_id[0] : 0;
    const moveName = line.move_id ? line.move_id[1] : 'Unknown';
    if (!byInvoice[moveId]) byInvoice[moveId] = { name: moveName, lines: [] };
    byInvoice[moveId].lines.push(line);
  }

  const invoiceIds = Object.keys(byInvoice).map(id => parseInt(id));
  console.log('Invoices to fix:', invoiceIds.length);

  // Get invoice details to check payment_state
  const invoices = await odoo.searchRead('account.move',
    [['id', 'in', invoiceIds]],
    ['id', 'name', 'payment_state'],
    { limit: 500 }
  );

  const results = { fixed: 0, skipped: 0, errors: [] };

  for (const inv of invoices) {
    if (inv.payment_state !== 'not_paid') {
      console.log('\n  SKIP: ' + inv.name + ' - ' + inv.payment_state + ' (not unpaid)');
      results.skipped++;
      continue;
    }

    const data = byInvoice[inv.id];
    console.log('\n  Processing: ' + inv.name + ' (' + data.lines.length + ' lines without tax)');

    try {
      // Step 1: Reset to draft
      console.log('    1. Reset to draft...');
      await safeExecute(odoo, 'account.move', 'button_draft', [[inv.id]]);
      await sleep(200);

      // Step 2: Update lines with missing tax
      console.log('    2. Adding IT*VAT 22% to ' + data.lines.length + ' lines...');
      for (const line of data.lines) {
        await odoo.execute('account.move.line', 'write', [[line.id], {
          tax_ids: [[6, 0, [itVat22.id]]]
        }]);
      }
      await sleep(200);

      // Step 3: Post again
      console.log('    3. Post invoice...');
      await safeExecute(odoo, 'account.move', 'action_post', [[inv.id]]);
      await sleep(200);

      console.log('    SUCCESS: Fixed ' + inv.name);
      results.fixed++;

    } catch (err) {
      console.log('    ERROR: ' + err.message);
      results.errors.push({ invoice: inv.name, error: err.message });
    }

    await sleep(100);
  }

  // Summary
  console.log('\n\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));
  console.log('Fixed: ' + results.fixed);
  console.log('Skipped (paid): ' + results.skipped);
  console.log('Errors: ' + results.errors.length);

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    for (const err of results.errors) {
      console.log('  - ' + err.invoice + ': ' + err.error);
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
