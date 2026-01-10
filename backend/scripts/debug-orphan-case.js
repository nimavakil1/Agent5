require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Check one specific case
  const orderName = 'FBA302-3618922-3977949';

  console.log('=== DEBUGGING ORDER: ' + orderName + ' ===\n');

  const orders = await odoo.searchRead('sale.order',
    [['name', '=', orderName]],
    ['id', 'name', 'invoice_ids', 'amount_total']
  );
  const order = orders[0];

  console.log('Order ID: ' + order.id);
  console.log('Invoice IDs: ' + JSON.stringify(order.invoice_ids));
  console.log('Amount: EUR ' + order.amount_total);

  // Get ALL order lines
  console.log('\n=== ORDER LINES ===');
  const orderLines = await odoo.searchRead('sale.order.line',
    [['order_id', '=', order.id]],
    ['id', 'product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines']
  );

  for (const line of orderLines) {
    console.log('Line ' + line.id + ':');
    console.log('  Product: ' + (line.product_id ? line.product_id[1] : 'N/A'));
    console.log('  Product ID: ' + (line.product_id ? line.product_id[0] : 'N/A'));
    console.log('  Qty: ordered=' + line.product_uom_qty + ', delivered=' + line.qty_delivered + ', invoiced=' + line.qty_invoiced + ', to_invoice=' + line.qty_to_invoice);
    console.log('  invoice_lines: ' + JSON.stringify(line.invoice_lines));
  }

  // Get ALL invoice lines from the linked invoices
  console.log('\n=== INVOICE LINES ===');
  if (order.invoice_ids && order.invoice_ids.length > 0) {
    const invoiceLines = await odoo.searchRead('account.move.line',
      [
        ['move_id', 'in', order.invoice_ids],
        ['display_type', '=', 'product']
      ],
      ['id', 'product_id', 'quantity', 'price_unit', 'sale_line_ids', 'move_id', 'name']
    );

    for (const il of invoiceLines) {
      console.log('Invoice Line ' + il.id + ':');
      console.log('  Product: ' + (il.product_id ? il.product_id[1] : 'N/A'));
      console.log('  Product ID: ' + (il.product_id ? il.product_id[0] : 'N/A'));
      console.log('  Qty: ' + il.quantity);
      console.log('  sale_line_ids: ' + JSON.stringify(il.sale_line_ids));
      console.log('  Name: ' + (il.name || '').substring(0, 50));
    }

    // Get invoice info
    console.log('\n=== INVOICES ===');
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'name', 'state', 'amount_total', 'invoice_origin']
    );
    for (const inv of invoices) {
      console.log('Invoice ' + inv.name + ' (ID: ' + inv.id + ')');
      console.log('  State: ' + inv.state + ', Amount: EUR ' + inv.amount_total);
      console.log('  Origin: ' + inv.invoice_origin);
    }
  }
}

main().catch(e => console.error(e));
