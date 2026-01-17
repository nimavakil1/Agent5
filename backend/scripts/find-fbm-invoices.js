require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function findFbmInvoices() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('========================================');
  console.log('SEARCHING FOR FBM INVOICES BY SALE ORDER LINK');
  console.log('========================================\n');

  // Find sale orders that are FBM (name starts with F but not FBA)
  // and check their linked invoices
  const fbmOrders = await odoo.searchRead('sale.order',
    [
      ['name', '=like', 'F%-%-%'],
      ['name', 'not like', 'FBA%'],
      ['invoice_ids', '!=', false]
    ],
    ['id', 'name', 'client_order_ref', 'invoice_ids', 'amount_total'],
    { limit: 100 }
  );

  console.log('FBM orders with invoices:', fbmOrders.length);

  // Get details of their invoices
  const allInvoiceIds = [];
  for (const o of fbmOrders) {
    if (o.invoice_ids) {
      allInvoiceIds.push(...o.invoice_ids);
    }
  }

  if (allInvoiceIds.length > 0) {
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', allInvoiceIds]],
      ['id', 'name', 'state', 'invoice_date', 'amount_total', 'create_date', 'invoice_origin'],
      { limit: 100 }
    );

    console.log('\nInvoices linked to FBM orders:');
    for (const inv of invoices) {
      console.log('  ID:', inv.id, '| Name:', inv.name, '| State:', inv.state);
      console.log('    Date:', inv.invoice_date, '| Amount:', inv.amount_total);
      console.log('    Created:', inv.create_date);
      console.log('');
    }
  }

  // Also search for any invoice with Amazon-like ref pattern in last month
  console.log('\n========================================');
  console.log('INVOICES WITH AMAZON ORDER REF (last month)');
  console.log('========================================\n');

  const recentInvoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['create_date', '>=', '2024-12-01']
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'state', 'invoice_date', 'amount_total'],
    { limit: 1000 }
  );

  // Filter for Amazon order pattern in origin or ref
  const amazonPattern = /\d{3}-\d{7}-\d{7}/;
  const amazonInvoices = recentInvoices.filter(inv => {
    return amazonPattern.test(inv.invoice_origin || '') || amazonPattern.test(inv.ref || '');
  });

  console.log('Invoices with Amazon order pattern:', amazonInvoices.length);

  // Group by state
  const byState = {};
  for (const inv of amazonInvoices) {
    byState[inv.state] = (byState[inv.state] || 0) + 1;
  }
  console.log('By state:', byState);

  // Show draft ones
  const drafts = amazonInvoices.filter(i => i.state === 'draft');
  if (drafts.length > 0) {
    console.log('\nDraft invoices with Amazon ref:');
    for (const inv of drafts) {
      console.log('  ID:', inv.id, '| Origin:', inv.invoice_origin);
      console.log('    Date:', inv.invoice_date, '| Amount:', inv.amount_total);
    }
  }
}

findFbmInvoices().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
