require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Checking Payment Status on Vendor Invoices ===');

  // Get vendor team
  const vendorTeams = await odoo.searchRead('crm.team', [['name', 'ilike', 'vendor']], ['id'], { limit: 5 });
  const vendorTeamIds = vendorTeams.map(t => t.id);

  // Get all vendor invoices with payment info
  const allInvoices = await odoo.searchRead('account.move',
    [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['team_id', 'in', vendorTeamIds]],
    ['name', 'partner_id', 'amount_total', 'amount_residual', 'payment_state', 'invoice_date'],
    { limit: 5000, order: 'invoice_date desc' }
  );

  console.log(`Total vendor invoices: ${allInvoices.length}`);

  // Count by payment state
  const byPaymentState = {};
  let totalPaid = 0;
  let totalUnpaid = 0;

  allInvoices.forEach(inv => {
    const state = inv.payment_state || 'unknown';
    byPaymentState[state] = (byPaymentState[state] || 0) + 1;

    if (state === 'paid' || state === 'in_payment') {
      totalPaid += inv.amount_total;
    } else {
      totalUnpaid += inv.amount_residual || inv.amount_total;
    }
  });

  console.log('\n=== Payment Status Summary ===');
  Object.entries(byPaymentState).sort((a, b) => b[1] - a[1]).forEach(([state, count]) => {
    const pct = ((count / allInvoices.length) * 100).toFixed(1);
    console.log(`  ${state}: ${count} (${pct}%)`);
  });

  console.log(`\nTotal amount paid: EUR ${totalPaid.toFixed(2)}`);
  console.log(`Total amount outstanding: EUR ${totalUnpaid.toFixed(2)}`);

  // Show recent paid invoices
  const paidInvoices = allInvoices.filter(i => i.payment_state === 'paid').slice(0, 10);
  console.log('\n=== Recent Paid Invoices (sample) ===');
  paidInvoices.forEach(inv => {
    const partner = inv.partner_id ? inv.partner_id[1].replace('Amazon EU SARL ', '').substring(0, 15) : '-';
    console.log(`  ${inv.name} | ${partner.padEnd(15)} | EUR ${inv.amount_total.toFixed(2).padStart(10)} | ${inv.invoice_date}`);
  });

  // Show recent unpaid invoices
  const unpaidInvoices = allInvoices.filter(i => i.payment_state === 'not_paid').slice(0, 10);
  console.log('\n=== Recent Unpaid Invoices (sample) ===');
  unpaidInvoices.forEach(inv => {
    const partner = inv.partner_id ? inv.partner_id[1].replace('Amazon EU SARL ', '').substring(0, 15) : '-';
    console.log(`  ${inv.name} | ${partner.padEnd(15)} | EUR ${inv.amount_total.toFixed(2).padStart(10)} | ${inv.invoice_date}`);
  });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
