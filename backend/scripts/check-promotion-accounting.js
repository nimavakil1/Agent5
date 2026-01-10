require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const orderName = 'FBA402-9039450-8739520';
  console.log('=== CHECKING ORDER: ' + orderName + ' ===\n');

  const orders = await odoo.searchRead('sale.order',
    [['name', '=', orderName]],
    ['id', 'name', 'amount_untaxed', 'amount_tax', 'amount_total', 'invoice_ids']
  );
  const order = orders[0];

  console.log('Order totals:');
  console.log('  Untaxed: EUR ' + order.amount_untaxed);
  console.log('  Tax: EUR ' + order.amount_tax);
  console.log('  Total: EUR ' + order.amount_total);

  // Get all order lines
  const orderLines = await odoo.searchRead('sale.order.line',
    [['order_id', '=', order.id]],
    ['id', 'product_id', 'price_subtotal', 'price_tax', 'price_total', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines']
  );

  console.log('\nOrder lines:');
  let totalSubtotal = 0;
  let totalTax = 0;
  for (const line of orderLines) {
    const productName = (line.product_id ? line.product_id[1] : 'N/A').substring(0, 35);
    console.log('  ' + productName);
    console.log('    subtotal=' + line.price_subtotal + ', tax=' + line.price_tax + ', total=' + line.price_total);
    console.log('    invoiced=' + line.qty_invoiced + ', to_invoice=' + line.qty_to_invoice + ', inv_lines=' + JSON.stringify(line.invoice_lines));
    totalSubtotal += line.price_subtotal || 0;
    totalTax += line.price_tax || 0;
  }
  console.log('\nSum of lines: subtotal=' + totalSubtotal.toFixed(2) + ', tax=' + totalTax.toFixed(2) + ', total=' + (totalSubtotal + totalTax).toFixed(2));

  // Get invoice
  const invoices = await odoo.searchRead('account.move',
    [['id', 'in', order.invoice_ids]],
    ['id', 'name', 'move_type', 'amount_untaxed_signed', 'amount_tax_signed', 'amount_total_signed']
  );

  console.log('\nInvoices:');
  for (const inv of invoices) {
    console.log('  ' + inv.name + ' (' + inv.move_type + '):');
    console.log('    untaxed=' + inv.amount_untaxed_signed + ', tax=' + inv.amount_tax_signed + ', total=' + inv.amount_total_signed);
  }

  // Check invoice lines
  const regularInvoices = invoices.filter(i => i.move_type === 'out_invoice');
  if (regularInvoices.length > 0) {
    const invLines = await odoo.searchRead('account.move.line',
      [
        ['move_id', '=', regularInvoices[0].id],
        ['display_type', '=', 'product']
      ],
      ['id', 'name', 'quantity', 'price_unit', 'price_subtotal', 'price_total', 'sale_line_ids']
    );
    console.log('\nInvoice lines:');
    let invSubtotal = 0;
    for (const il of invLines) {
      console.log('  ' + (il.name || '').substring(0, 35));
      console.log('    qty=' + il.quantity + ', unit=' + il.price_unit + ', subtotal=' + il.price_subtotal + ', total=' + il.price_total);
      console.log('    sale_line_ids=' + JSON.stringify(il.sale_line_ids));
      invSubtotal += il.price_subtotal || 0;
    }
    console.log('\nInvoice lines sum: ' + invSubtotal.toFixed(2));
  }

  // Analysis
  console.log('\n=== ANALYSIS ===');
  const invoicedSubtotal = invoices.filter(i => i.move_type === 'out_invoice').reduce((s, i) => s + i.amount_untaxed_signed, 0);
  const creditedSubtotal = invoices.filter(i => i.move_type === 'out_refund').reduce((s, i) => s + i.amount_untaxed_signed, 0);
  const netInvoiced = invoicedSubtotal - creditedSubtotal;

  console.log('Order untaxed total: EUR ' + order.amount_untaxed);
  console.log('Invoiced total: EUR ' + invoicedSubtotal);
  console.log('Credited total: EUR ' + creditedSubtotal);
  console.log('Net invoiced: EUR ' + netInvoiced);
  console.log('Difference: EUR ' + (order.amount_untaxed - netInvoiced).toFixed(2));
}

main().catch(e => console.error(e));
