require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== INVESTIGATING ORDERS WITH NEGATIVE DELIVERED QTY ===\n');

  // Find a few examples
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      ['name', '=', 'FBA304-4666105-5680330']
    ],
    ['id', 'name', 'invoice_ids', 'amount_total', 'state', 'date_order']
  );

  for (const order of orders) {
    console.log('=== Order: ' + order.name + ' ===');
    console.log('State: ' + order.state);
    console.log('Date: ' + order.date_order);
    console.log('Amount: EUR ' + order.amount_total);

    // Get all order lines
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines', 'invoice_status']
    );

    console.log('\nOrder Lines:');
    for (const line of orderLines) {
      const name = (line.product_id ? line.product_id[1] : 'N/A').substring(0, 30);
      console.log('  ' + name);
      console.log('    qty=' + line.product_uom_qty + ', delivered=' + line.qty_delivered + ', invoiced=' + line.qty_invoiced + ', to_inv=' + line.qty_to_invoice);
      console.log('    status=' + line.invoice_status + ', inv_lines=' + JSON.stringify(line.invoice_lines));
    }

    // Get invoices
    console.log('\nInvoices:');
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'name', 'move_type', 'state', 'amount_total', 'invoice_date']
    );
    for (const inv of invoices) {
      console.log('  ' + inv.name + ' (' + inv.move_type + '): EUR ' + inv.amount_total + ' [' + inv.state + '] ' + inv.invoice_date);
    }

    // Get invoice lines
    console.log('\nInvoice Lines:');
    for (const inv of invoices) {
      const invLines = await odoo.searchRead('account.move.line',
        [['move_id', '=', inv.id], ['display_type', '=', 'product']],
        ['id', 'product_id', 'quantity', 'price_unit', 'sale_line_ids']
      );
      console.log('  Invoice ' + inv.name + ':');
      for (const il of invLines) {
        console.log('    qty=' + il.quantity + ', price=' + il.price_unit + ', sale_lines=' + JSON.stringify(il.sale_line_ids));
      }
    }

    // Check for stock moves (returns)
    console.log('\nStock Moves (deliveries/returns):');
    const pickings = await odoo.searchRead('stock.picking',
      [['sale_id', '=', order.id]],
      ['id', 'name', 'state', 'picking_type_id', 'date_done']
    );
    for (const pick of pickings) {
      const pickType = pick.picking_type_id ? pick.picking_type_id[1] : 'N/A';
      console.log('  ' + pick.name + ' (' + pickType + '): ' + pick.state + ' ' + (pick.date_done || ''));
    }
  }
}

main().catch(e => console.error(e));
