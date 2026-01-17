require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkFbmInvoices() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // The 19 invoices we created - search by the Amazon order references
  // They were created with invoice_origin = amazonOrderId

  console.log('========================================');
  console.log('CHECKING FBM INVOICES CREATED');
  console.log('========================================\n');

  // Search for recent draft invoices that might be ours
  const invoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'draft'],
      ['create_date', '>=', '2025-01-13']
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'partner_id', 'amount_total', 'invoice_date', 'state', 'create_date'],
    { limit: 100 }
  );

  console.log('Recent draft invoices found:', invoices.length);

  // Filter to FBM invoices (those with Amazon order ID pattern in origin/ref)
  const fbmInvoices = invoices.filter(inv => {
    const origin = inv.invoice_origin || '';
    const ref = inv.ref || '';
    return origin.match(/\d{3}-\d{7}-\d{7}/) || ref.match(/\d{3}-\d{7}-\d{7}/);
  });

  console.log('FBM invoices (Amazon order pattern):', fbmInvoices.length);
  console.log('');

  if (fbmInvoices.length > 0) {
    console.log('Invoice Details:');
    console.log('-'.repeat(100));

    let totalAmount = 0;
    for (const inv of fbmInvoices) {
      console.log('ID:', inv.id, '| Name:', inv.name);
      console.log('  Origin:', inv.invoice_origin);
      console.log('  Partner:', inv.partner_id ? inv.partner_id[1] : 'N/A');
      console.log('  Amount:', inv.amount_total, '| Date:', inv.invoice_date);
      console.log('  State:', inv.state);
      console.log('');
      totalAmount += inv.amount_total;
    }

    console.log('-'.repeat(100));
    console.log('TOTAL AMOUNT:', totalAmount.toFixed(2));
  }

  // Also check if any were already posted
  console.log('\n========================================');
  console.log('CHECKING FOR POSTED FBM INVOICES');
  console.log('========================================\n');

  const postedInvoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['create_date', '>=', '2025-01-13'],
      ['invoice_origin', '!=', false]
    ],
    ['id', 'name', 'invoice_origin', 'amount_total', 'invoice_date', 'state'],
    { limit: 100 }
  );

  const postedFbm = postedInvoices.filter(inv => {
    const origin = inv.invoice_origin || '';
    return origin.match(/\d{3}-\d{7}-\d{7}/);
  });

  console.log('Posted FBM invoices:', postedFbm.length);
  for (const inv of postedFbm) {
    console.log('  ', inv.name, '|', inv.invoice_origin, '| €', inv.amount_total);
  }
}

checkFbmInvoices().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
