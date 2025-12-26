require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Check transaction types
  console.log('=== All Transaction Types ===');
  const allHistory = await odoo.searchRead('amazon.vendor.transaction.history',
    [],
    ['transaction_type'],
    {limit: 1000}
  );

  const types = {};
  allHistory.forEach(h => {
    const t = h.transaction_type || 'unknown';
    types[t] = (types[t] || 0) + 1;
  });
  console.log(types);

  // Get invoice transactions
  console.log('\n=== Invoice Transactions ===');
  const invoiceTx = await odoo.searchRead('amazon.vendor.transaction.history',
    [['transaction_type', '=', 'invoice']],
    ['transaction_id', 'account_move_id', 'amazon_vendor_sale_requisition_id', 'request_data', 'response_data', 'create_date'],
    {limit: 20, order: 'create_date desc'}
  );

  if (invoiceTx.length === 0) {
    console.log('No invoice transactions found. Checking for similar types...');
    const types = ['invoice', 'inv', 'billing', 'remittance'];
    for (const t of types) {
      const tx = await odoo.searchRead('amazon.vendor.transaction.history',
        [['transaction_type', 'ilike', t]],
        ['transaction_type', 'create_date'],
        {limit: 5}
      );
      if (tx.length > 0) console.log('Found type: ' + t, tx);
    }
  } else {
    invoiceTx.forEach((tx, i) => {
      console.log('\n--- Invoice TX ' + (i+1) + ' ---');
      console.log('Date:', tx.create_date);
      console.log('Invoice:', tx.account_move_id ? tx.account_move_id[1] : 'N/A');
      console.log('Requisition:', tx.amazon_vendor_sale_requisition_id ? tx.amazon_vendor_sale_requisition_id[1] : 'N/A');
      if (tx.response_data) {
        try {
          const resp = JSON.parse(tx.response_data);
          console.log('Response:', JSON.stringify(resp).substring(0, 200));
        } catch(e) {
          console.log('Response:', tx.response_data.substring(0, 200));
        }
      }
    });
  }

  // Check sale requisition for invoice links
  console.log('\n=== Requisition Invoice Links ===');
  const fields = await odoo.execute('amazon.vendor.sale.requisition', 'fields_get', [], {attributes: ['string', 'type']});
  const invoiceFields = Object.entries(fields).filter(([name]) =>
    name.includes('invoice') || name.includes('move') || name.includes('account')
  );
  console.log('Invoice-related fields on requisition:', invoiceFields.map(f => f[0] + ' (' + f[1].type + ')').join(', '));

  // Get a requisition with invoice
  const reqs = await odoo.searchRead('amazon.vendor.sale.requisition',
    [['invoice_ids', '!=', false]],
    ['name', 'invoice_ids', 'purchase_order_number', 'order_date'],
    {limit: 10, order: 'order_date desc'}
  );
  console.log('\nRequisitions with invoices:', reqs.length);
  reqs.forEach(r => {
    console.log(r.name + ' (PO: ' + r.purchase_order_number + ') - Invoice IDs: ' + JSON.stringify(r.invoice_ids));
  });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
