require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Check a specific case: FBA404-2475217-9286712 with invoice VFR/2025/11/01108
  const orderName = 'FBA404-2475217-9286712';
  const invoiceName = 'VFR/2025/11/01108';

  console.log('=== CHECKING ORDER: ' + orderName + ' ===\n');

  // Get order
  const orders = await odoo.searchRead('sale.order',
    [['name', '=', orderName]],
    ['id', 'name', 'invoice_ids', 'order_line']
  );
  const order = orders[0];
  console.log('Order ID: ' + order.id);
  console.log('Invoice IDs linked to order: ' + JSON.stringify(order.invoice_ids));

  // Get order lines
  console.log('\n=== ORDER LINES ===');
  const orderLines = await odoo.searchRead('sale.order.line',
    [['order_id', '=', order.id]],
    ['id', 'name', 'product_id', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines']
  );
  for (const line of orderLines) {
    console.log('Line ID: ' + line.id);
    console.log('  Product: ' + (line.product_id ? line.product_id[1] : 'N/A'));
    console.log('  Qty delivered: ' + line.qty_delivered + ', invoiced: ' + line.qty_invoiced + ', to_invoice: ' + line.qty_to_invoice);
    console.log('  invoice_lines (linked account.move.line IDs): ' + JSON.stringify(line.invoice_lines));
  }

  // Get invoice
  console.log('\n=== INVOICE: ' + invoiceName + ' ===');
  const invoices = await odoo.searchRead('account.move',
    [['name', '=', invoiceName]],
    ['id', 'name', 'state', 'invoice_origin', 'amount_total', 'invoice_line_ids']
  );
  const invoice = invoices[0];
  console.log('Invoice ID: ' + invoice.id);
  console.log('Invoice Origin: ' + invoice.invoice_origin);
  console.log('Amount: EUR ' + invoice.amount_total);
  console.log('State: ' + invoice.state);

  // Get invoice lines
  console.log('\n=== INVOICE LINES ===');
  const invoiceLines = await odoo.searchRead('account.move.line',
    [['move_id', '=', invoice.id], ['display_type', '=', 'product']],
    ['id', 'name', 'product_id', 'quantity', 'price_unit', 'sale_line_ids']
  );
  for (const line of invoiceLines) {
    console.log('Invoice Line ID: ' + line.id);
    console.log('  Product: ' + (line.product_id ? line.product_id[1] : 'N/A'));
    console.log('  Qty: ' + line.quantity + ', Price: ' + line.price_unit);
    console.log('  sale_line_ids (linked sale.order.line IDs): ' + JSON.stringify(line.sale_line_ids));
  }

  console.log('\n=== DIAGNOSIS ===');
  if (invoiceLines.length > 0 && invoiceLines.every(l => !l.sale_line_ids || l.sale_line_ids.length === 0)) {
    console.log('PROBLEM: Invoice lines exist but are NOT linked to sale order lines');
    console.log('SOLUTION: Need to set sale_line_ids on invoice lines to connect them');
  }
}

main().catch(e => console.error(e));
