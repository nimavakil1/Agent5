/**
 * Find orders where qty_invoiced > qty_ordered
 * This identifies real over-invoicing issues
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Finding Over-Invoiced Orders ===\n');

  // Query order lines where qty_invoiced > 0
  const invoicedLines = await odoo.searchRead('sale.order.line',
    [['qty_invoiced', '>', 0]],
    ['order_id', 'product_id', 'product_uom_qty', 'qty_invoiced', 'price_unit'],
    { limit: 100000 }
  );

  console.log('Analyzing', invoicedLines.length, 'invoiced order lines...\n');

  // Find lines where invoiced > ordered
  const orderIssues = {};

  for (const line of invoicedLines) {
    if (line.qty_invoiced > line.product_uom_qty + 0.01) {
      const orderId = line.order_id[0];
      const orderName = line.order_id[1];

      if (!orderIssues[orderId]) {
        orderIssues[orderId] = {
          orderName,
          products: []
        };
      }

      orderIssues[orderId].products.push({
        product: line.product_id?.[1] || 'Unknown',
        ordered: line.product_uom_qty,
        invoiced: line.qty_invoiced,
        diff: line.qty_invoiced - line.product_uom_qty,
        priceUnit: line.price_unit
      });
    }
  }

  const overInvoicedCount = Object.keys(orderIssues).length;

  console.log('=== RESULTS ===');
  console.log('Lines analyzed:', invoicedLines.length);
  console.log('❌ OVER-INVOICED ORDERS:', overInvoicedCount);

  if (overInvoicedCount > 0) {
    // Get order details
    const orderIds = Object.keys(orderIssues).map(Number);
    const orders = await odoo.searchRead('sale.order',
      [['id', 'in', orderIds.slice(0, 100)]],
      ['name', 'client_order_ref', 'invoice_ids', 'amount_total']
    );

    const orderMap = {};
    for (const o of orders) orderMap[o.id] = o;

    console.log('\n=== OVER-INVOICED ORDER DETAILS ===');
    let totalOverValue = 0;
    let totalOverQty = 0;

    for (const [orderId, data] of Object.entries(orderIssues).slice(0, 50)) {
      const order = orderMap[orderId];
      if (!order) continue;

      console.log('\n' + order.name + ' | ' + order.client_order_ref);
      console.log('  Invoices:', order.invoice_ids?.length || 0);

      for (const p of data.products) {
        console.log('  Product: ' + p.product.substring(0, 60));
        console.log('    Ordered: ' + p.ordered + ' | Invoiced: ' + p.invoiced + ' | OVER by: ' + p.diff.toFixed(2));
        totalOverQty += p.diff;
        totalOverValue += p.diff * p.priceUnit;
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log('Total over-invoiced orders:', overInvoicedCount);
    console.log('Total over-invoiced quantity:', totalOverQty.toFixed(2), 'units');
    console.log('Estimated over-invoiced value: €' + totalOverValue.toFixed(2));
  }

  // Also check for under-invoiced (to_invoice status)
  console.log('\n\n=== UNDER-INVOICED CHECK ===');
  const toInvoiceCount = await odoo.execute('sale.order', 'search_count',
    [[['invoice_status', '=', 'to invoice'], ['state', '=', 'sale']]]
  );
  console.log('Orders with status "to invoice":', toInvoiceCount);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
