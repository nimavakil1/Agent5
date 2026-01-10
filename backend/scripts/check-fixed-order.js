require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Check an order we just fixed
  const orderName = 'FBA028-5212820-4676324';
  
  console.log('=== CHECKING FIXED ORDER: ' + orderName + ' ===\n');

  const orders = await odoo.searchRead('sale.order',
    [['name', '=', orderName]],
    ['id', 'name', 'invoice_status', 'amount_total']
  );
  
  if (orders.length === 0) {
    console.log('Order not found');
    return;
  }
  
  const order = orders[0];
  console.log('Order ID: ' + order.id);
  console.log('Invoice Status: ' + order.invoice_status);
  console.log('Amount: EUR ' + order.amount_total);

  // Get order lines
  console.log('\n=== ORDER LINES ===');
  const orderLines = await odoo.searchRead('sale.order.line',
    [['order_id', '=', order.id]],
    ['id', 'product_id', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines']
  );

  for (const line of orderLines) {
    console.log('Line ' + line.id + ':');
    console.log('  Product: ' + (line.product_id ? line.product_id[1] : 'N/A'));
    console.log('  Delivered: ' + line.qty_delivered + ', Invoiced: ' + line.qty_invoiced + ', To Invoice: ' + line.qty_to_invoice);
    console.log('  invoice_lines: ' + JSON.stringify(line.invoice_lines));
  }

  // Check invoice lines
  console.log('\n=== INVOICE LINE LINKAGE ===');
  for (const line of orderLines) {
    if (line.invoice_lines && line.invoice_lines.length > 0) {
      const invLines = await odoo.searchRead('account.move.line',
        [['id', 'in', line.invoice_lines]],
        ['id', 'sale_line_ids', 'quantity']
      );
      for (const il of invLines) {
        console.log('Invoice line ' + il.id + ' qty=' + il.quantity + ' -> sale_line_ids: ' + JSON.stringify(il.sale_line_ids));
      }
    }
  }
}

main().catch(e => console.error(e));
