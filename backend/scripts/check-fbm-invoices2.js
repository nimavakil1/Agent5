require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkFbmInvoices() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('========================================');
  console.log('SEARCHING ALL RECENT INVOICES');
  console.log('========================================\n');

  // Get ALL invoices created recently
  const allInvoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['create_date', '>=', '2025-01-10']
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'partner_id', 'amount_total', 'invoice_date', 'state', 'create_date'],
    { limit: 500, order: 'create_date desc' }
  );

  console.log('Total invoices since Jan 10:', allInvoices.length);

  // Group by state
  const byState = {};
  for (const inv of allInvoices) {
    byState[inv.state] = (byState[inv.state] || 0) + 1;
  }
  console.log('By state:', byState);

  // Look for invoices with dates we set (01/12/2025 or 31/12/2025)
  console.log('\n========================================');
  console.log('INVOICES WITH OUR DATE PATTERN');
  console.log('========================================\n');

  const ourInvoices = allInvoices.filter(inv => {
    const date = inv.invoice_date;
    return date === '2025-12-01' || date === '2025-12-31';
  });

  console.log('Invoices with date 2025-12-01 or 2025-12-31:', ourInvoices.length);

  for (const inv of ourInvoices) {
    console.log('ID:', inv.id, '| Name:', inv.name, '| State:', inv.state);
    console.log('  Origin:', inv.invoice_origin || 'N/A');
    console.log('  Ref:', inv.ref || 'N/A');
    console.log('  Partner:', inv.partner_id ? inv.partner_id[1] : 'N/A');
    console.log('  Amount:', inv.amount_total, '| Date:', inv.invoice_date);
    console.log('');
  }

  // Also check for draft invoices without standard name
  console.log('\n========================================');
  console.log('DRAFT INVOICES (first 20)');
  console.log('========================================\n');

  const drafts = allInvoices.filter(inv => inv.state === 'draft').slice(0, 20);
  for (const inv of drafts) {
    console.log(inv.id, '|', inv.name, '| €', inv.amount_total, '|', inv.invoice_date);
    console.log('  Origin:', inv.invoice_origin || '-', '| Ref:', inv.ref || '-');
  }
}

checkFbmInvoices().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
