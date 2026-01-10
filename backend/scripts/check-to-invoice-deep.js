require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get total count first
  const totalCount = await odoo.execute('sale.order', 'search_count', [[['invoice_status', '=', 'to invoice']]]);
  console.log('TOTAL "to invoice" orders in Odoo: ' + totalCount + '\n');

  // Get orders with invoice_ids linked but still "to invoice"
  console.log('=== ORDERS WITH INVOICES LINKED BUT STILL "TO INVOICE" ===\n');
  
  const withInvoices = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false]
    ],
    ['id', 'name', 'state', 'date_order', 'amount_total', 'invoice_ids'],
    { limit: 10, order: 'date_order desc' }
  );

  console.log('Sample of orders with invoices linked but still "to invoice":');
  for (const order of withInvoices) {
    console.log('\n' + order.name + ' | ' + (order.date_order || '').substring(0,10) + ' | EUR ' + (order.amount_total || 0).toFixed(2));
    
    // Get the linked invoices
    if (order.invoice_ids && order.invoice_ids.length > 0) {
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', order.invoice_ids]],
        ['id', 'name', 'state', 'amount_total', 'payment_state']
      );
      for (const inv of invoices) {
        console.log('  Invoice: ' + inv.name + ' | state: ' + inv.state + ' | EUR ' + inv.amount_total + ' | payment: ' + inv.payment_state);
      }
    }
    
    // Get order lines to see qty_to_invoice
    const lines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['name', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice']
    );
    for (const line of lines) {
      if (line.qty_to_invoice > 0) {
        console.log('  Line with qty_to_invoice > 0: ' + line.name.substring(0, 40) + ' | to_invoice: ' + line.qty_to_invoice);
      }
    }
  }

  // Break down by age
  console.log('\n\n=== AGE BREAKDOWN OF "TO INVOICE" ORDERS ===\n');
  
  const now = new Date();
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
  const oneMonthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
  const threeMonthsAgo = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
  
  const lastWeek = await odoo.execute('sale.order', 'search_count', [[['invoice_status', '=', 'to invoice'], ['date_order', '>=', oneWeekAgo]]]);
  const lastMonth = await odoo.execute('sale.order', 'search_count', [[['invoice_status', '=', 'to invoice'], ['date_order', '>=', oneMonthAgo]]]);
  const last3Months = await odoo.execute('sale.order', 'search_count', [[['invoice_status', '=', 'to invoice'], ['date_order', '>=', threeMonthsAgo]]]);
  
  console.log('Last 7 days: ' + lastWeek);
  console.log('Last 30 days: ' + lastMonth);
  console.log('Last 90 days: ' + last3Months);
  console.log('Older than 90 days: ' + (totalCount - last3Months));

  // Check if these are FBA orders that should be invoiced via VCS
  console.log('\n\n=== FBA vs FBM BREAKDOWN ===\n');
  
  const fbaCount = await odoo.execute('sale.order', 'search_count', [[['invoice_status', '=', 'to invoice'], ['name', 'like', 'FBA%']]]);
  const fbmCount = await odoo.execute('sale.order', 'search_count', [[['invoice_status', '=', 'to invoice'], ['name', 'like', 'FBM%']]]);
  const fbbCount = await odoo.execute('sale.order', 'search_count', [[['invoice_status', '=', 'to invoice'], ['name', 'like', 'FBB%']]]);
  
  console.log('FBA orders (Amazon fulfills): ' + fbaCount);
  console.log('FBM orders (Merchant fulfills): ' + fbmCount);
  console.log('FBB orders (Bol.com): ' + fbbCount);
  console.log('Other: ' + (totalCount - fbaCount - fbmCount - fbbCount));
}

main().catch(e => console.error(e));
