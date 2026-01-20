/**
 * Check VEX journal invoices for December 2025
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get VEX journal
  const vexJournal = await odoo.searchRead('account.journal', [['code', '=', 'VEX']], ['id', 'name'], { limit: 1 });
  console.log('VEX Journal:', vexJournal[0]);
  const vexJournalId = vexJournal[0].id;

  // Get December invoices from VEX
  const invoices = await odoo.searchRead('account.move',
    [
      ['journal_id', '=', vexJournalId],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['state', '=', 'posted'],
      ['invoice_date', '>=', '2025-12-01'],
      ['invoice_date', '<=', '2025-12-31']
    ],
    ['id', 'name', 'partner_id', 'amount_total', 'payment_state'],
    { limit: 500 }
  );

  console.log('\nVEX December posted invoices:', invoices.length);

  const notPaid = invoices.filter(i => i.payment_state === 'not_paid');
  const paid = invoices.filter(i => i.payment_state !== 'not_paid');

  console.log('Not paid:', notPaid.length);
  console.log('Paid:', paid.length);

  // Get taxes used on these invoices
  const invoiceIds = invoices.map(i => i.id);
  const taxLines = await odoo.searchRead('account.move.line',
    [['move_id', 'in', invoiceIds], ['tax_line_id', '!=', false]],
    ['id', 'move_id', 'tax_line_id', 'balance'],
    { limit: 5000 }
  );

  const taxCounts = {};
  for (const line of taxLines) {
    const taxName = line.tax_line_id ? line.tax_line_id[1] : 'Unknown';
    if (!taxCounts[taxName]) taxCounts[taxName] = { count: 0, balance: 0 };
    taxCounts[taxName].count++;
    taxCounts[taxName].balance += Math.abs(line.balance || 0);
  }

  console.log('\nTaxes used on VEX December:');
  for (const [tax, data] of Object.entries(taxCounts)) {
    console.log('  ' + tax + ': ' + data.count + ' lines, EUR ' + data.balance.toFixed(2));
  }

  console.log('\nSample invoices:');
  for (const inv of invoices.slice(0, 10)) {
    console.log('  ' + inv.name + ' - ' + inv.payment_state + ' - EUR ' + inv.amount_total + ' - ' + (inv.partner_id ? inv.partner_id[1] : 'Unknown'));
  }

  // Show paid ones separately
  if (paid.length > 0) {
    console.log('\nPAID invoices (cannot auto-fix):');
    for (const inv of paid) {
      console.log('  ' + inv.name + ' - ' + inv.payment_state + ' - EUR ' + inv.amount_total);
    }
  }
}

main().catch(console.error);
