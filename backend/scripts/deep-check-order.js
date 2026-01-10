require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const orderName = 'FBA028-5212820-4676324';
  
  console.log('=== DEEP CHECK: ' + orderName + ' ===\n');

  const orders = await odoo.searchRead('sale.order',
    [['name', '=', orderName]],
    ['id', 'name', 'invoice_status', 'invoice_ids']
  );
  const order = orders[0];
  
  console.log('Order invoice_ids:', order.invoice_ids);

  // Get all invoices
  console.log('\n=== ALL INVOICES ===');
  const invoices = await odoo.searchRead('account.move',
    [['id', 'in', order.invoice_ids]],
    ['id', 'name', 'move_type', 'state', 'amount_total']
  );
  for (const inv of invoices) {
    console.log('Invoice ' + inv.id + ': ' + inv.name);
    console.log('  Type: ' + inv.move_type + ', State: ' + inv.state + ', Amount: EUR ' + inv.amount_total);
  }

  // Get ALL invoice lines from all invoices
  console.log('\n=== ALL INVOICE LINES ===');
  const invLines = await odoo.searchRead('account.move.line',
    [
      ['move_id', 'in', order.invoice_ids],
      ['display_type', '=', 'product']
    ],
    ['id', 'move_id', 'product_id', 'quantity', 'price_unit', 'sale_line_ids']
  );
  for (const il of invLines) {
    const inv = invoices.find(i => i.id === il.move_id[0]);
    console.log('Line ' + il.id + ' (Invoice ' + inv.name + ' ' + inv.move_type + '):');
    console.log('  Product: ' + (il.product_id ? il.product_id[1] : 'N/A'));
    console.log('  Qty: ' + il.quantity + ', Price: EUR ' + il.price_unit);
    console.log('  sale_line_ids: ' + JSON.stringify(il.sale_line_ids));
  }

  // Show order line summary
  console.log('\n=== ORDER LINE SUMMARY ===');
  const orderLines = await odoo.searchRead('sale.order.line',
    [['order_id', '=', order.id]],
    ['id', 'product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice']
  );
  for (const line of orderLines) {
    console.log('Line ' + line.id + ' (' + (line.product_id ? line.product_id[1] : 'N/A') + '):');
    console.log('  Ordered: ' + line.product_uom_qty + ', Delivered: ' + line.qty_delivered);
    console.log('  Invoiced: ' + line.qty_invoiced + ', To Invoice: ' + line.qty_to_invoice);
  }
}

main().catch(e => console.error(e));
