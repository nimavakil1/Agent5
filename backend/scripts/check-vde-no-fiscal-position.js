/**
 * Check VDE invoices without fiscal position in December 2025
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get VDE journal
  const vdeJournal = await odoo.searchRead('account.journal', [['code', '=', 'VDE']], ['id', 'name'], { limit: 1 });
  const vdeJournalId = vdeJournal[0].id;
  console.log('VDE Journal:', vdeJournal[0]);

  // Get DE*VAT fiscal position
  const deFiscalPositions = await odoo.searchRead('account.fiscal.position',
    [['name', 'like', 'DE*VAT%']],
    ['id', 'name'],
    { limit: 10 }
  );
  console.log('DE fiscal positions:', deFiscalPositions.map(fp => fp.name + ' (ID:' + fp.id + ')').join(', '));

  // Find VDE invoices without fiscal position in December
  const invoices = await odoo.searchRead('account.move',
    [
      ['journal_id', '=', vdeJournalId],
      ['state', '=', 'posted'],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['invoice_date', '>=', '2025-12-01'],
      ['invoice_date', '<=', '2025-12-31'],
      ['fiscal_position_id', '=', false]
    ],
    ['id', 'name', 'partner_id', 'amount_total', 'amount_tax', 'payment_state'],
    { limit: 200 }
  );

  console.log('\nVDE invoices WITHOUT fiscal position in December:', invoices.length);

  // Count paid vs not_paid
  const notPaid = invoices.filter(i => i.payment_state === 'not_paid');
  const paid = invoices.filter(i => i.payment_state !== 'not_paid');
  console.log('Not paid:', notPaid.length);
  console.log('Paid:', paid.length);

  // Total tax amount
  const totalTax = invoices.reduce((sum, i) => sum + (i.amount_tax || 0), 0);
  console.log('Total tax amount: EUR', totalTax.toFixed(2));

  // Show sample
  console.log('\nSample invoices:');
  for (const inv of invoices.slice(0, 15)) {
    console.log('  ' + inv.name + ' - ' + inv.payment_state + ' - EUR ' + inv.amount_total + ' (tax: ' + inv.amount_tax + ') - ' + (inv.partner_id ? inv.partner_id[1] : 'Unknown'));
  }

  // Check if these are credit notes (refunds)
  const creditNotes = invoices.filter(i => i.name.startsWith('RVDE'));
  console.log('\nCredit notes (RVDE):', creditNotes.length);
}

main().catch(console.error);
