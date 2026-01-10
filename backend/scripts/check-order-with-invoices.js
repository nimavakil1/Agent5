require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Check the order with 3 invoices
  const orderName = 'FBA028-5212820-4676324';
  
  console.log('=== CHECKING ORDER: ' + orderName + ' ===\n');

  const orders = await odoo.searchRead('sale.order',
    [['name', '=', orderName]],
    ['id', 'name', 'invoice_status', 'amount_total', 'invoice_ids']
  );
  const order = orders[0];
  
  console.log('Order ID: ' + order.id);
  console.log('Amount: EUR ' + order.amount_total);
  console.log('Invoice Status: ' + order.invoice_status);
  console.log('Invoice IDs: ' + JSON.stringify(order.invoice_ids));

  // Get order lines
  console.log('\n=== ORDER LINES ===');
  const lines = await odoo.searchRead('sale.order.line',
    [['order_id', '=', order.id]],
    ['id', 'name', 'product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines', 'price_subtotal']
  );
  
  let totalOrderValue = 0;
  for (const line of lines) {
    totalOrderValue += line.price_subtotal || 0;
    console.log('Line ' + line.id + ':');
    console.log('  Product: ' + (line.product_id ? line.product_id[1].substring(0, 50) : 'N/A'));
    console.log('  Qty: ordered=' + line.product_uom_qty + ', delivered=' + line.qty_delivered + ', invoiced=' + line.qty_invoiced + ', to_invoice=' + line.qty_to_invoice);
    console.log('  Value: EUR ' + (line.price_subtotal || 0).toFixed(2));
    console.log('  Linked invoice lines: ' + JSON.stringify(line.invoice_lines));
  }
  console.log('\nTotal order line value: EUR ' + totalOrderValue.toFixed(2));

  // Get invoices
  console.log('\n=== INVOICES ===');
  if (order.invoice_ids && order.invoice_ids.length > 0) {
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'name', 'state', 'amount_total', 'invoice_origin', 'invoice_line_ids']
    );
    
    let totalInvoiceValue = 0;
    for (const inv of invoices) {
      totalInvoiceValue += inv.amount_total || 0;
      console.log('\nInvoice ' + inv.name + ' (ID: ' + inv.id + '):');
      console.log('  State: ' + inv.state);
      console.log('  Amount: EUR ' + inv.amount_total);
      console.log('  Origin: ' + inv.invoice_origin);
      
      // Get invoice lines
      const invLines = await odoo.searchRead('account.move.line',
        [['move_id', '=', inv.id], ['display_type', '=', 'product']],
        ['id', 'name', 'quantity', 'price_unit', 'price_subtotal', 'sale_line_ids']
      );
      
      console.log('  Invoice lines:');
      for (const il of invLines) {
        console.log('    Line ' + il.id + ': qty=' + il.quantity + ', unit=' + il.price_unit + ', subtotal=' + (il.price_subtotal || 0).toFixed(2) + ', linked_sale_lines=' + JSON.stringify(il.sale_line_ids));
      }
    }
    console.log('\nTotal invoice value: EUR ' + totalInvoiceValue.toFixed(2));
  }

  console.log('\n=== DIAGNOSIS ===');
  const hasUnlinkedLines = lines.some(l => l.qty_to_invoice > 0 && (!l.invoice_lines || l.invoice_lines.length === 0));
  if (hasUnlinkedLines) {
    console.log('PROBLEM: Some order lines have qty_to_invoice > 0 but no linked invoice lines');
    console.log('CAUSE: Invoice lines were not linked to sale order lines when invoice was created');
  }
}

main().catch(e => console.error(e));
