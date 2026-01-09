/**
 * Detailed analysis of over-invoiced orders
 * Shows exactly why qty_invoiced > qty_ordered
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Analyzing Over-Invoiced Orders ===\n');

  // Get over-invoiced order lines
  const invoicedLines = await odoo.searchRead('sale.order.line',
    [['qty_invoiced', '>', 0]],
    ['order_id', 'product_id', 'product_uom_qty', 'qty_invoiced', 'price_unit', 'invoice_lines'],
    { limit: 100000 }
  );

  // Find lines where invoiced > ordered
  const overInvoicedLines = invoicedLines.filter(
    line => line.qty_invoiced > line.product_uom_qty + 0.01
  );

  console.log(`Found ${overInvoicedLines.length} over-invoiced order lines\n`);

  // Get unique order IDs
  const orderIds = [...new Set(overInvoicedLines.map(l => l.order_id[0]))];
  console.log(`Across ${orderIds.length} unique orders\n`);

  // Analyze first 20 orders in detail
  const samplesToAnalyze = orderIds.slice(0, 20);

  for (const orderId of samplesToAnalyze) {
    // Get order details
    const [order] = await odoo.searchRead('sale.order',
      [['id', '=', orderId]],
      ['name', 'client_order_ref', 'invoice_ids', 'date_order', 'state', 'invoice_status']
    );

    if (!order) continue;

    console.log('='.repeat(80));
    console.log(`ORDER: ${order.name} | Amazon: ${order.client_order_ref}`);
    console.log(`Date: ${order.date_order} | State: ${order.state} | Invoice Status: ${order.invoice_status}`);
    console.log(`Number of invoices: ${order.invoice_ids?.length || 0}`);

    // Get order lines
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', orderId]],
      ['product_id', 'product_uom_qty', 'qty_invoiced', 'qty_delivered', 'price_unit', 'invoice_lines']
    );

    console.log('\nOrder Lines:');
    for (const line of orderLines) {
      const overQty = line.qty_invoiced - line.product_uom_qty;
      const status = overQty > 0.01 ? '❌ OVER' : '✓ OK';
      console.log(`  ${status} ${line.product_id?.[1]?.substring(0, 50) || 'Unknown'}`);
      console.log(`      Ordered: ${line.product_uom_qty} | Delivered: ${line.qty_delivered} | Invoiced: ${line.qty_invoiced}`);
      if (overQty > 0.01) {
        console.log(`      OVER-INVOICED BY: ${overQty.toFixed(2)} units`);
      }
      if (line.invoice_lines?.length > 0) {
        console.log(`      Linked to ${line.invoice_lines.length} invoice line(s)`);
      }
    }

    // Get invoice details if any
    if (order.invoice_ids?.length > 0) {
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', order.invoice_ids]],
        ['name', 'state', 'invoice_date', 'create_date', 'amount_total', 'invoice_origin', 'ref']
      );

      console.log('\nLinked Invoices:');
      for (const inv of invoices) {
        console.log(`  ${inv.name} | ${inv.state} | Date: ${inv.invoice_date || inv.create_date}`);
        console.log(`      Origin: ${inv.invoice_origin} | Ref: ${inv.ref}`);
        console.log(`      Amount: €${inv.amount_total?.toFixed(2)}`);

        // Get invoice lines
        const invLines = await odoo.searchRead('account.move.line',
          [['move_id', '=', inv.id], ['product_id', '!=', false]],
          ['product_id', 'quantity', 'price_unit', 'sale_line_ids']
        );
        for (const invLine of invLines) {
          console.log(`        - ${invLine.product_id?.[1]?.substring(0, 40)}: ${invLine.quantity} @ €${invLine.price_unit}`);
          if (invLine.sale_line_ids?.length > 0) {
            console.log(`          Linked to sale order line ID(s): ${invLine.sale_line_ids.join(', ')}`);
          }
        }
      }
    }

    console.log('\n');
  }

  // Summary statistics
  console.log('='.repeat(80));
  console.log('=== SUMMARY ===');
  console.log(`Total over-invoiced order lines: ${overInvoicedLines.length}`);
  console.log(`Total over-invoiced orders: ${orderIds.length}`);

  // Calculate total over-invoiced value
  let totalOverQty = 0;
  let totalOverValue = 0;
  for (const line of overInvoicedLines) {
    const over = line.qty_invoiced - line.product_uom_qty;
    totalOverQty += over;
    totalOverValue += over * line.price_unit;
  }
  console.log(`Total over-invoiced quantity: ${totalOverQty.toFixed(2)} units`);
  console.log(`Estimated over-invoiced value: €${totalOverValue.toFixed(2)}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
