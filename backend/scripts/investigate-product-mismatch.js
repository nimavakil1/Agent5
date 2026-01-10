require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Check what product 16404 is
  console.log('=== INVESTIGATING PRODUCT MISMATCH ===\n');

  const product16404 = await odoo.searchRead('product.product',
    [['id', '=', 16404]],
    ['id', 'name', 'default_code']
  );
  console.log('Product 16404:', product16404[0] ? product16404[0].name : 'NOT FOUND');
  if (product16404[0]) console.log('  SKU:', product16404[0].default_code);

  // Look at one specific problematic order
  const orderName = 'FBA305-8718812-5263502';
  console.log('\n=== CHECKING ORDER: ' + orderName + ' ===');

  const orders = await odoo.searchRead('sale.order',
    [['name', '=', orderName]],
    ['id', 'name', 'invoice_ids']
  );
  const order = orders[0];
  console.log('Invoice IDs:', order.invoice_ids);

  // Get order lines
  const orderLines = await odoo.searchRead('sale.order.line',
    [['order_id', '=', order.id]],
    ['id', 'product_id', 'product_uom_qty', 'qty_to_invoice', 'invoice_lines']
  );
  console.log('\nOrder Lines:');
  for (const line of orderLines) {
    console.log('  Line ' + line.id + ': Product ' + (line.product_id ? line.product_id[0] : 'N/A') + ' (' + (line.product_id ? line.product_id[1] : '') + ')');
    console.log('    qty_to_invoice=' + line.qty_to_invoice + ', invoice_lines=' + JSON.stringify(line.invoice_lines));
  }

  // Get regular invoices (not credit notes)
  const invoices = await odoo.searchRead('account.move',
    [['id', 'in', order.invoice_ids], ['move_type', '=', 'out_invoice']],
    ['id', 'name']
  );
  console.log('\nRegular Invoices:', invoices.map(i => i.name));

  // Get invoice lines
  const invoiceIds = invoices.map(i => i.id);
  const invLines = await odoo.searchRead('account.move.line',
    [
      ['move_id', 'in', invoiceIds],
      ['display_type', '=', 'product']
    ],
    ['id', 'product_id', 'quantity', 'name', 'sale_line_ids']
  );
  console.log('\nInvoice Lines:');
  for (const il of invLines) {
    console.log('  Line ' + il.id + ': Product ' + (il.product_id ? il.product_id[0] : 'N/A') + ' (' + (il.product_id ? il.product_id[1] : '') + ')');
    console.log('    qty=' + il.quantity + ', sale_line_ids=' + JSON.stringify(il.sale_line_ids));
    console.log('    name: ' + (il.name || '').substring(0, 60));
  }
}

main().catch(e => console.error(e));
