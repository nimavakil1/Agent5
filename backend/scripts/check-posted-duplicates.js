/**
 * Check for multiple posted invoices on the same order
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Checking for Multiple Posted Invoices per Order ===\n');

  // Get all posted customer invoices with invoice_origin (linked to sale order)
  const invoices = await odoo.searchRead('account.move',
    [
      ['state', '=', 'posted'],
      ['move_type', '=', 'out_invoice'],
      ['invoice_origin', '!=', false]
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'amount_total', 'invoice_date'],
    { limit: 200000 }
  );

  console.log(`Total posted invoices with origin: ${invoices.length}`);

  // Group by invoice_origin
  const byOrigin = {};
  for (const inv of invoices) {
    const origin = inv.invoice_origin;
    if (!byOrigin[origin]) {
      byOrigin[origin] = [];
    }
    byOrigin[origin].push(inv);
  }

  // Find origins with multiple invoices
  const multipleInvoices = Object.entries(byOrigin)
    .filter(([_, invs]) => invs.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  console.log(`Orders with multiple posted invoices: ${multipleInvoices.length}\n`);

  // Show distribution
  const dist = {};
  for (const [_, invs] of multipleInvoices) {
    const count = invs.length;
    dist[count] = (dist[count] || 0) + 1;
  }

  console.log('Distribution:');
  for (const [count, orders] of Object.entries(dist).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  ${count} invoices: ${orders} orders`);
  }

  // Show first 20 examples
  console.log('\n=== Examples ===\n');
  for (const [origin, invs] of multipleInvoices.slice(0, 20)) {
    console.log(`Order: ${origin}`);
    console.log(`  ${invs.length} invoices:`);
    for (const inv of invs) {
      console.log(`    ${inv.name} | Date: ${inv.invoice_date} | €${inv.amount_total?.toFixed(2)}`);
    }
    console.log('');
  }

  // Check if these are "expected" duplicates (user mentioned one invoice per VCS line)
  // The issue is if the SAME sale order line is invoiced multiple times
  console.log('\n=== Checking Sale Order Line Links ===\n');

  // Take first 5 multi-invoice orders for detailed analysis
  for (const [origin, invs] of multipleInvoices.slice(0, 5)) {
    console.log(`=== ${origin} (${invs.length} invoices) ===`);

    // Get the sale order
    const [saleOrder] = await odoo.searchRead('sale.order',
      [['name', '=', origin]],
      ['id', 'name', 'order_line']
    );

    if (!saleOrder) {
      // Try with FBA prefix
      const [saleOrderFba] = await odoo.searchRead('sale.order',
        [['name', 'like', origin]],
        ['id', 'name', 'order_line']
      );
      if (!saleOrderFba) {
        console.log('  Sale order not found');
        continue;
      }
    }

    // Get order lines with invoice info
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id.name', 'like', origin.replace('FBA', '').replace('FBM', '')]],
      ['product_id', 'product_uom_qty', 'qty_invoiced', 'invoice_lines']
    );

    console.log(`  Order lines: ${orderLines.length}`);
    for (const line of orderLines) {
      const over = line.qty_invoiced - line.product_uom_qty;
      const status = over > 0.01 ? '❌ OVER' : '✓ OK';
      console.log(`    ${status} ${line.product_id?.[1]?.substring(0, 40)}`);
      console.log(`      Ordered: ${line.product_uom_qty} | Invoiced: ${line.qty_invoiced}`);
      console.log(`      Invoice lines linked: ${line.invoice_lines?.length || 0}`);
    }
    console.log('');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
