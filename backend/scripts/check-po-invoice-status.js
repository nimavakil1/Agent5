require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Check amazon.vendor.sale.requisition fields
  console.log('=== Requisition Fields Related to Invoice ===');
  const reqFields = await odoo.execute('amazon.vendor.sale.requisition', 'fields_get', [], {attributes: ['string', 'type']});
  const invoiceRelated = Object.entries(reqFields).filter(([name]) =>
    name.includes('invoice') || name.includes('payment') || name.includes('status') || name.includes('state')
  );
  invoiceRelated.forEach(([name, info]) => {
    console.log(`  ${name} (${info.type}): ${info.string}`);
  });

  // Get requisitions with invoice status
  console.log('\n=== Sample Requisitions ===');
  const reqs = await odoo.searchRead('amazon.vendor.sale.requisition',
    [],
    ['name', 'purchase_order_number', 'state', 'is_invoice_exists', 'invoice_partner_id'],
    { limit: 20, order: 'create_date desc' }
  );

  reqs.forEach(r => {
    console.log(`${r.name} | PO: ${r.purchase_order_number} | State: ${r.state} | Invoice Exists: ${r.is_invoice_exists}`);
  });

  // Count by state
  console.log('\n=== Requisition State Counts ===');
  const allReqs = await odoo.searchRead('amazon.vendor.sale.requisition',
    [],
    ['state'],
    { limit: 5000 }
  );

  const byState = {};
  allReqs.forEach(r => {
    byState[r.state] = (byState[r.state] || 0) + 1;
  });
  Object.entries(byState).sort((a,b) => b[1] - a[1]).forEach(([state, count]) => {
    console.log(`  ${state}: ${count}`);
  });

  // Check invoice exists count
  const withInvoice = allReqs.filter(r => r.is_invoice_exists === true).length;
  const withoutInvoice = allReqs.filter(r => r.is_invoice_exists !== true).length;
  console.log(`\n  with invoice: ${withInvoice}`);
  console.log(`  without invoice: ${withoutInvoice}`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
