/**
 * Move VEX invoices to VBE journal
 * Export invoices from Belgium should be on VBE
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
  console.log('Fix: Move VEX invoices to VBE (exports from Belgium)');
  console.log('='.repeat(100));

  // Get journals
  const journals = await odoo.searchRead('account.journal',
    [['code', 'in', ['VEX', 'VBE']]],
    ['id', 'code', 'name'],
    { limit: 10 }
  );

  const journalMap = {};
  for (const j of journals) {
    journalMap[j.code] = { id: j.id, name: j.name };
  }
  console.log('VEX Journal:', journalMap['VEX']);
  console.log('VBE Journal:', journalMap['VBE']);

  const vexJournalId = journalMap['VEX'].id;
  const vbeJournalId = journalMap['VBE'].id;

  // Get NOT PAID December invoices from VEX
  const invoices = await odoo.searchRead('account.move',
    [
      ['journal_id', '=', vexJournalId],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['state', '=', 'posted'],
      ['payment_state', '=', 'not_paid'],
      ['invoice_date', '>=', '2025-12-01'],
      ['invoice_date', '<=', '2025-12-31']
    ],
    ['id', 'name', 'move_type', 'invoice_date', 'partner_id', 'amount_total', 'currency_id',
     'invoice_origin', 'narration', 'ref', 'invoice_payment_term_id', 'fiscal_position_id'],
    { limit: 100 }
  );

  console.log('\nVEX not-paid December invoices:', invoices.length);

  if (invoices.length === 0) {
    console.log('No invoices to move.');
    return;
  }

  // Get lines for these invoices
  const invoiceIds = invoices.map(inv => inv.id);
  const allLines = await odoo.searchRead('account.move.line',
    [['move_id', 'in', invoiceIds], ['display_type', '=', 'product']],
    ['id', 'name', 'move_id', 'product_id', 'quantity', 'price_unit', 'discount',
     'tax_ids', 'price_subtotal', 'account_id', 'analytic_distribution'],
    { limit: 5000 }
  );

  // Group lines by invoice
  const linesByInvoice = {};
  for (const line of allLines) {
    const invId = Array.isArray(line.move_id) ? line.move_id[0] : line.move_id;
    if (!linesByInvoice[invId]) linesByInvoice[invId] = [];
    linesByInvoice[invId].push(line);
  }

  const results = { fixed: 0, errors: [] };

  for (const inv of invoices) {
    const lines = linesByInvoice[inv.id] || [];
    console.log('\n  Processing: ' + inv.name + ' -> VBE');

    try {
      // Step 1: Reset to draft
      console.log('    1. Reset to draft...');
      await safeExecute(odoo, 'account.move', 'button_draft', [[inv.id]]);
      await sleep(200);

      // Step 2: Cancel
      console.log('    2. Cancel invoice...');
      await odoo.write('account.move', [inv.id], { state: 'cancel' });
      await sleep(200);

      // Step 3: Create new invoice on VBE
      console.log('    3. Create new invoice on VBE...');

      const invoiceLines = [];
      for (const line of lines) {
        invoiceLines.push([0, 0, {
          product_id: line.product_id ? line.product_id[0] : false,
          name: line.name,
          quantity: line.quantity,
          price_unit: line.price_unit,
          discount: line.discount || 0,
          tax_ids: [[6, 0, line.tax_ids || []]],
          account_id: line.account_id ? line.account_id[0] : false,
          analytic_distribution: line.analytic_distribution || false
        }]);
      }

      const newInvoiceData = {
        move_type: inv.move_type,
        journal_id: vbeJournalId,
        partner_id: inv.partner_id ? inv.partner_id[0] : false,
        invoice_date: inv.invoice_date,
        date: inv.invoice_date,
        currency_id: inv.currency_id ? inv.currency_id[0] : false,
        invoice_origin: inv.invoice_origin || false,
        narration: inv.narration || false,
        ref: inv.ref || false,
        invoice_payment_term_id: inv.invoice_payment_term_id ? inv.invoice_payment_term_id[0] : false,
        fiscal_position_id: inv.fiscal_position_id ? inv.fiscal_position_id[0] : false,
        invoice_line_ids: invoiceLines
      };

      const newInvoiceId = await odoo.create('account.move', newInvoiceData);
      await sleep(200);

      // Step 4: Post
      console.log('    4. Post new invoice...');
      await safeExecute(odoo, 'account.move', 'action_post', [[newInvoiceId]]);
      await sleep(200);

      const newInvoice = await odoo.searchRead('account.move', [['id', '=', newInvoiceId]], ['name'], { limit: 1 });
      console.log('    SUCCESS: ' + inv.name + ' (cancelled) -> ' + (newInvoice[0]?.name || newInvoiceId));
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
  console.log('Moved to VBE: ' + results.fixed);
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
