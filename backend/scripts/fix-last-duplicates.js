require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Finding remaining duplicate orders with "to invoice" status...\n');

  // Get ALL FBA/FBM orders in one query
  const allOrders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'invoice_status'],
    { limit: 50000 }
  );

  console.log('Fetched ' + allOrders.length + ' orders');

  // Group by name
  const byName = {};
  for (const o of allOrders) {
    if (!byName[o.name]) byName[o.name] = [];
    byName[o.name].push(o);
  }

  // Find duplicates with "to invoice"
  const toFix = [];
  for (const [name, orders] of Object.entries(byName)) {
    if (orders.length <= 1) continue;
    const ordersToFix = orders.filter(o => o.invoice_status === 'to invoice');
    if (ordersToFix.length > 0) {
      toFix.push({ name, ordersToFix });
    }
  }

  console.log('Found ' + toFix.length + ' duplicate groups with "to invoice"\n');

  let fixed = 0;
  for (const { name, ordersToFix } of toFix) {
    console.log(name + ': ' + ordersToFix.length + ' order(s)');

    for (const order of ordersToFix) {
      const lines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', order.id]],
        ['id']
      );
      const lineIds = lines.map(l => l.id);
      if (lineIds.length > 0) {
        await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
        console.log('  Order ' + order.id + ': marked ' + lineIds.length + ' lines as invoiced');
      }
      fixed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Orders fixed: ' + fixed);
}

main().catch(e => console.error(e));
