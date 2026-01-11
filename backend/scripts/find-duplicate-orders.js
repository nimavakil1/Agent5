require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Searching for duplicate Amazon orders in Odoo...\n');

  // Get all FBA/FBM orders
  const orders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'client_order_ref', 'date_order', 'amount_total', 'invoice_status', 'state'],
    { limit: 50000, order: 'name asc' }
  );

  console.log('Total FBA/FBM orders: ' + orders.length);

  // Group by order name
  const ordersByName = {};
  for (const order of orders) {
    if (!ordersByName[order.name]) {
      ordersByName[order.name] = [];
    }
    ordersByName[order.name].push(order);
  }

  // Find duplicates
  const duplicates = [];
  for (const [name, orderList] of Object.entries(ordersByName)) {
    if (orderList.length > 1) {
      duplicates.push({
        name,
        count: orderList.length,
        orders: orderList
      });
    }
  }

  console.log('Orders with duplicate names: ' + duplicates.length + '\n');

  // Analyze duplicates
  let totalDuplicateOrders = 0;
  let toInvoiceCount = 0;

  // Group by count
  const byCount = {};
  for (const dup of duplicates) {
    byCount[dup.count] = (byCount[dup.count] || 0) + 1;
    totalDuplicateOrders += dup.count;

    // Check if any are 'to invoice'
    const hasToInvoice = dup.orders.some(o => o.invoice_status === 'to invoice');
    if (hasToInvoice) toInvoiceCount++;
  }

  console.log('=== SUMMARY ===');
  console.log('Unique Amazon orders with multiple Odoo records: ' + duplicates.length);
  console.log('Total Odoo orders involved: ' + totalDuplicateOrders);
  console.log('Of these, orders with "to invoice" status: ' + toInvoiceCount);
  console.log('');
  console.log('Breakdown by duplicate count:');
  for (const [count, num] of Object.entries(byCount).sort((a, b) => parseInt(b) - parseInt(a))) {
    console.log('  ' + count + ' Odoo orders per Amazon order: ' + num + ' cases');
  }

  // Show first 20 examples with 'to invoice' status
  console.log('\n=== EXAMPLES (with "to invoice" status) ===');
  let shown = 0;
  for (const dup of duplicates) {
    const hasToInvoice = dup.orders.some(o => o.invoice_status === 'to invoice');
    if (!hasToInvoice) continue;
    if (shown >= 15) break;

    console.log('\n' + dup.name + ' (' + dup.count + ' orders):');
    for (const o of dup.orders) {
      console.log('  ID ' + o.id + ': EUR ' + o.amount_total.toFixed(2) + ' | ' + o.invoice_status + ' | ' + o.state);
    }
    shown++;
  }
}

main().catch(e => console.error(e));
