require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get requisitions with invoice info
  console.log('=== Requisitions with Invoices ===');
  const reqs = await odoo.searchRead('amazon.vendor.sale.requisition',
    [['is_invoice_exists', '=', true]],
    ['name', 'purchase_order_number', 'is_invoice_exists', 'state', 'sale_order_id', 'create_date'],
    {limit: 30, order: 'create_date desc'}
  );

  console.log('Found ' + reqs.length + ' requisitions with invoices');
  reqs.slice(0, 15).forEach(r => {
    const so = r.sale_order_id ? r.sale_order_id[1] : 'No SO';
    console.log(r.name + ' | PO: ' + r.purchase_order_number + ' | SO: ' + so + ' | State: ' + r.state);
  });

  // Get the invoice transaction history to understand submission status
  console.log('\n=== Invoice Submission History (account_move_id linked) ===');
  const invoiceTx = await odoo.searchRead('amazon.vendor.transaction.history',
    [['transaction_type', '=', 'invoice'], ['account_move_id', '!=', false]],
    ['transaction_id', 'account_move_id', 'response_data', 'create_date'],
    {limit: 50, order: 'create_date desc'}
  );

  console.log('Invoice submissions with response:', invoiceTx.length);
  invoiceTx.forEach(tx => {
    const invoice = tx.account_move_id ? tx.account_move_id[1] : 'N/A';
    let status = 'Unknown';
    if (tx.response_data) {
      try {
        const resp = JSON.parse(tx.response_data);
        status = resp.transactionStatus?.status || 'Unknown';
      } catch (e) {}
    }
    console.log(invoice + ' | Status: ' + status + ' | Date: ' + tx.create_date);
  });

  // Get VBE Amazon invoices with their origin (which contains sale order info)
  console.log('\n=== VBE Amazon Invoices (last 30) ===');
  // First get partner IDs for Amazon
  const amazonPartners = await odoo.searchRead('res.partner',
    [['name', 'ilike', 'amazon eu']],
    ['id', 'name'],
    {limit: 20}
  );
  const amazonPartnerIds = amazonPartners.map(p => p.id);
  console.log('Amazon partner IDs:', amazonPartnerIds.join(', '));

  const vbeInvoices = await odoo.searchRead('account.move',
    [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['name', 'like', 'VBE%'], ['partner_id', 'in', amazonPartnerIds]],
    ['name', 'partner_id', 'amount_total', 'invoice_date', 'invoice_origin', 'ref'],
    {limit: 30, order: 'invoice_date desc'}
  );

  console.log('\nVBE Invoices to Amazon:', vbeInvoices.length);
  vbeInvoices.forEach(inv => {
    const partner = inv.partner_id ? inv.partner_id[1].replace('Amazon EU SARL ', '').substring(0, 12) : '-';
    console.log(inv.name + ' | ' + partner.padEnd(12) + ' | EUR ' + inv.amount_total.toFixed(2).padStart(10) + ' | ' + inv.invoice_date + ' | Origin: ' + (inv.invoice_origin || '-').substring(0, 30));
  });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
