require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get all invoice transactions
  console.log('=== Invoice Submission Transactions ===');
  const invoiceTx = await odoo.searchRead('amazon.vendor.transaction.history',
    [['transaction_type', '=', 'invoice']],
    ['account_move_id', 'amazon_vendor_sale_requisition_id', 'response_data', 'create_date'],
    { limit: 100 }
  );

  console.log(`Total invoice submission transactions: ${invoiceTx.length}`);

  // Analyze responses
  let successful = 0;
  let failed = 0;
  let unknown = 0;

  invoiceTx.forEach(tx => {
    if (tx.response_data) {
      try {
        const resp = JSON.parse(tx.response_data);
        if (resp.transactionStatus?.status === 'Failure') {
          failed++;
        } else if (resp.transactionStatus?.status === 'Success' || resp.transactionId) {
          successful++;
        } else {
          unknown++;
        }
      } catch (e) {
        unknown++;
      }
    } else {
      unknown++;
    }
  });

  console.log(`  Successful: ${successful}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Unknown: ${unknown}`);

  // Get unique invoices that were submitted
  const submittedInvoiceIds = new Set();
  invoiceTx.forEach(tx => {
    if (tx.account_move_id) {
      submittedInvoiceIds.add(tx.account_move_id[0]);
    }
  });
  console.log(`\nUnique invoices submitted via API: ${submittedInvoiceIds.size}`);

  // Get vendor team and count total vendor invoices
  const vendorTeams = await odoo.searchRead('crm.team', [['name', 'ilike', 'vendor']], ['id'], { limit: 5 });
  const vendorTeamIds = vendorTeams.map(t => t.id);

  const totalVendorInvoices = await odoo.execute('account.move', 'search_count', [
    [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['team_id', 'in', vendorTeamIds]]
  ]);

  console.log(`Total vendor invoices in Odoo: ${totalVendorInvoices}`);
  console.log(`Invoices NOT submitted via API: ${totalVendorInvoices - submittedInvoiceIds.size}`);

  // Show which invoices were submitted
  if (submittedInvoiceIds.size > 0) {
    console.log('\n=== Invoices Submitted via API ===');
    const submittedInvoices = await odoo.searchRead('account.move',
      [['id', 'in', Array.from(submittedInvoiceIds)]],
      ['name', 'partner_id', 'amount_total', 'invoice_date'],
      { order: 'invoice_date desc' }
    );
    submittedInvoices.forEach(inv => {
      const partner = inv.partner_id ? inv.partner_id[1].substring(0, 25) : '-';
      console.log(`  ${inv.name} | ${partner.padEnd(25)} | EUR ${inv.amount_total.toFixed(2)} | ${inv.invoice_date}`);
    });
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
