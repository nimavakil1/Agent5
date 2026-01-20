/**
 * Fix OSS invoices - Cancel on VBE and recreate on VOS journal
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Invoice IDs from the analysis (all unpaid)
const INVOICE_IDS = [
  365463, 365469, 365464, 357555, 357570, 357569, 357422,
  353985, 353984, 353835, 351921, 346372, 363187, 364843,
  364845, 364846, 364866, 364869, 364870, 364871, 344714,
  358775
];

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('='.repeat(100));
  console.log('Fix OSS Invoices: Cancel on VBE and Recreate on VOS');
  console.log('='.repeat(100));
  console.log('Mode: ' + (DRY_RUN ? 'DRY RUN' : 'LIVE'));

  // Get VOS journal ID
  const vosJournals = await odoo.searchRead('account.journal',
    [['code', '=', 'VOS']],
    ['id', 'name'],
    { limit: 1 }
  );

  if (vosJournals.length === 0) {
    console.log('ERROR: VOS journal not found!');
    process.exit(1);
  }

  const vosJournalId = vosJournals[0].id;
  console.log('VOS Journal: ' + vosJournals[0].name + ' (ID: ' + vosJournalId + ')');

  // Get full invoice details including lines
  const invoices = await odoo.searchRead('account.move',
    [['id', 'in', INVOICE_IDS]],
    ['id', 'name', 'state', 'payment_state', 'journal_id', 'partner_id', 'invoice_date',
     'invoice_date_due', 'ref', 'narration', 'fiscal_position_id', 'currency_id',
     'invoice_origin', 'invoice_payment_term_id', 'amount_total'],
    { limit: 100 }
  );

  console.log('\nFound ' + invoices.length + ' invoices to process\n');

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  const results = [];

  for (const inv of invoices) {
    const num = fixed + skipped + failed + 1;
    console.log('[' + num + '/' + invoices.length + '] ' + inv.name);

    // Verify it's not paid
    if (inv.payment_state !== 'not_paid') {
      console.log('  SKIPPED - payment state is: ' + inv.payment_state);
      skipped++;
      continue;
    }

    // Get invoice lines
    const lines = await odoo.searchRead('account.move.line',
      [['move_id', '=', inv.id], ['display_type', '=', 'product']],
      ['product_id', 'name', 'quantity', 'price_unit', 'discount', 'tax_ids',
       'account_id', 'analytic_distribution'],
      { limit: 100 }
    );

    if (lines.length === 0) {
      console.log('  SKIPPED - no product lines found');
      skipped++;
      continue;
    }

    console.log('  Lines: ' + lines.length + ' | Amount: EUR ' + inv.amount_total.toFixed(2));

    if (DRY_RUN) {
      console.log('  [DRY RUN] Would cancel ' + inv.name + ' and recreate on VOS');
      fixed++;
      results.push({ old: inv.name, new: 'VOS/XXXX (dry run)', amount: inv.amount_total });
      continue;
    }

    try {
      // Step 1: Reset to draft
      try {
        await odoo.execute('account.move', 'button_draft', [[inv.id]]);
      } catch (e) {
        if (!e.message.includes('cannot marshal None')) throw e;
      }

      // Step 2: Cancel the invoice
      try {
        await odoo.execute('account.move', 'button_cancel', [[inv.id]]);
      } catch (e) {
        if (!e.message.includes('cannot marshal None')) throw e;
      }

      // Verify cancelled
      const cancelled = await odoo.searchRead('account.move',
        [['id', '=', inv.id]],
        ['state'],
        { limit: 1 }
      );

      if (cancelled.length === 0 || cancelled[0].state !== 'cancel') {
        throw new Error('Failed to cancel invoice');
      }

      console.log('  Cancelled original invoice');

      // Step 3: Create new invoice on VOS
      const newInvoiceData = {
        move_type: 'out_invoice',
        journal_id: vosJournalId,
        partner_id: inv.partner_id ? inv.partner_id[0] : false,
        invoice_date: inv.invoice_date,
        invoice_date_due: inv.invoice_date_due,
        ref: inv.ref || false,
        narration: inv.narration || false,
        fiscal_position_id: inv.fiscal_position_id ? inv.fiscal_position_id[0] : false,
        currency_id: inv.currency_id ? inv.currency_id[0] : false,
        invoice_origin: inv.invoice_origin || false,
        invoice_payment_term_id: inv.invoice_payment_term_id ? inv.invoice_payment_term_id[0] : false,
        invoice_line_ids: lines.map(line => [0, 0, {
          product_id: line.product_id ? line.product_id[0] : false,
          name: line.name,
          quantity: line.quantity,
          price_unit: line.price_unit,
          discount: line.discount || 0,
          tax_ids: line.tax_ids ? [[6, 0, line.tax_ids]] : false,
          account_id: line.account_id ? line.account_id[0] : false,
          analytic_distribution: line.analytic_distribution || false
        }])
      };

      const newInvoiceId = await odoo.create('account.move', newInvoiceData);
      console.log('  Created new invoice ID: ' + newInvoiceId);

      // Step 4: Post the new invoice
      try {
        await odoo.execute('account.move', 'action_post', [[newInvoiceId]]);
      } catch (e) {
        if (!e.message.includes('cannot marshal None')) throw e;
      }

      // Verify new invoice
      const newInv = await odoo.searchRead('account.move',
        [['id', '=', newInvoiceId]],
        ['name', 'state', 'amount_total', 'journal_id'],
        { limit: 1 }
      );

      if (newInv.length > 0 && newInv[0].state === 'posted') {
        console.log('  SUCCESS: ' + inv.name + ' -> ' + newInv[0].name);
        fixed++;
        results.push({ old: inv.name, new: newInv[0].name, amount: newInv[0].amount_total });
      } else {
        console.log('  WARNING: New invoice created but state is: ' + (newInv[0]?.state || 'unknown'));
        fixed++;
        results.push({ old: inv.name, new: newInv[0]?.name || 'ID:' + newInvoiceId, amount: inv.amount_total });
      }

    } catch (err) {
      console.log('  ERROR - ' + err.message);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));
  console.log('Fixed: ' + fixed);
  console.log('Skipped: ' + skipped);
  console.log('Failed: ' + failed);

  if (results.length > 0) {
    console.log('\nInvoice Mapping:');
    console.log('-'.repeat(80));
    for (const r of results) {
      console.log('  ' + r.old + ' -> ' + r.new + ' (EUR ' + r.amount.toFixed(2) + ')');
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
