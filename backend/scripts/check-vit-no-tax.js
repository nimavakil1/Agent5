/**
 * Check VIT journal for lines without taxes in December 2025
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get VIT journal
  const vitJournal = await odoo.searchRead('account.journal', [['code', '=', 'VIT']], ['id', 'name'], { limit: 1 });
  console.log('VIT Journal:', vitJournal[0]);
  const vitJournalId = vitJournal[0].id;

  // Find product lines with no taxes on VIT in December
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

  console.log('\nVIT product lines with NO taxes in December:', linesNoTax.length);

  // Group by invoice
  const byInvoice = {};
  for (const line of linesNoTax) {
    const moveId = line.move_id ? line.move_id[0] : 0;
    const moveName = line.move_id ? line.move_id[1] : 'Unknown';
    if (!byInvoice[moveId]) byInvoice[moveId] = { name: moveName, lines: [], total: 0 };
    byInvoice[moveId].lines.push(line);
    byInvoice[moveId].total += Math.abs(line.price_subtotal || 0);
  }

  console.log('Invoices:', Object.keys(byInvoice).length);

  // Get invoice details
  const invoiceIds = Object.keys(byInvoice).map(id => parseInt(id));
  const invoices = await odoo.searchRead('account.move',
    [['id', 'in', invoiceIds]],
    ['id', 'name', 'partner_id', 'amount_total', 'payment_state'],
    { limit: 500 }
  );

  console.log('\nInvoices with lines without tax:');
  for (const inv of invoices) {
    const data = byInvoice[inv.id];
    console.log('  ' + inv.name + ' - ' + inv.payment_state + ' - EUR ' + inv.amount_total + ' - ' + (inv.partner_id ? inv.partner_id[1] : 'Unknown'));
    console.log('    Lines without tax: ' + data.lines.length + ' (EUR ' + data.total.toFixed(2) + ')');
  }

  // Count paid vs not_paid
  const notPaid = invoices.filter(i => i.payment_state === 'not_paid');
  const paid = invoices.filter(i => i.payment_state !== 'not_paid');
  console.log('\nNot paid:', notPaid.length);
  console.log('Paid:', paid.length);
}

main().catch(console.error);
