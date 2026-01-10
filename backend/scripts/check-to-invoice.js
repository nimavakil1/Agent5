require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== SALE ORDERS WITH STATUS "TO INVOICE" ===\n');

  const orders = await odoo.searchRead('sale.order',
    [['invoice_status', '=', 'to invoice']],
    ['id', 'name', 'state', 'date_order', 'amount_total', 'invoice_status', 'partner_id', 'origin', 'invoice_ids'],
    { limit: 2000, order: 'date_order desc' }
  );

  console.log('Total orders with "to invoice" status: ' + orders.length);

  const byPrefix = {};
  const byYear = {};
  
  for (const order of orders) {
    let prefix = 'OTHER';
    if (/^\d{3}-\d{7}-\d{7}/.test(order.name)) {
      prefix = 'AMAZON';
    } else if (order.name.startsWith('FBA')) {
      prefix = 'FBA';
    } else if (order.name.startsWith('FBM')) {
      prefix = 'FBM';
    } else if (order.name.startsWith('FBB')) {
      prefix = 'BOL.COM';
    } else if (order.name.startsWith('S0')) {
      prefix = 'MANUAL';
    }
    
    byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;

    const year = order.date_order ? order.date_order.substring(0, 4) : 'UNKNOWN';
    byYear[year] = (byYear[year] || 0) + 1;
  }

  console.log('\nBy source:');
  Object.entries(byPrefix).sort((a,b) => b[1] - a[1]).forEach(([k,v]) => console.log('  ' + k + ': ' + v));

  console.log('\nBy year:');
  Object.entries(byYear).sort((a,b) => b[0].localeCompare(a[0])).forEach(([k,v]) => console.log('  ' + k + ': ' + v));

  console.log('\n=== SAMPLE OF RECENT "TO INVOICE" ORDERS ===\n');
  for (const order of orders.slice(0, 20)) {
    const hasInvoices = order.invoice_ids && order.invoice_ids.length > 0;
    console.log(order.name + ' | ' + (order.date_order || '').substring(0,10) + ' | EUR ' + (order.amount_total || 0).toFixed(2) + ' | state: ' + order.state + ' | invoices: ' + (hasInvoices ? order.invoice_ids.length : 'NONE'));
  }

  const withInvoices = orders.filter(o => o.invoice_ids && o.invoice_ids.length > 0);
  const withoutInvoices = orders.filter(o => !(o.invoice_ids && o.invoice_ids.length > 0));
  
  console.log('\n=== INVOICE LINK STATUS ===');
  console.log('Have invoice_ids linked: ' + withInvoices.length);
  console.log('NO invoice_ids linked: ' + withoutInvoices.length);

  // Deep dive: check the order lines for those without invoices
  console.log('\n=== DEEP DIVE: WHY NO INVOICES? ===\n');
  
  const sampleWithout = withoutInvoices.slice(0, 5);
  for (const order of sampleWithout) {
    console.log('Order: ' + order.name + ' (ID: ' + order.id + ')');
    console.log('  Date: ' + order.date_order);
    console.log('  Amount: EUR ' + (order.amount_total || 0).toFixed(2));
    console.log('  State: ' + order.state);
    
    // Get order lines
    const lines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'name', 'product_id', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_status']
    );
    
    console.log('  Lines (' + lines.length + '):');
    for (const line of lines) {
      console.log('    - ' + (line.product_id ? line.product_id[1] : 'No product').substring(0, 40));
      console.log('      Delivered: ' + line.qty_delivered + ' | Invoiced: ' + line.qty_invoiced + ' | To Invoice: ' + line.qty_to_invoice);
    }
    console.log('');
  }
}

main().catch(e => console.error(e));
