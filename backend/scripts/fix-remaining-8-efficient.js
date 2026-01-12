require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Finding duplicate order names...\n');

  // Get ALL FBA/FBM orders - just names
  const allOrders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name'],
    { limit: 60000 }
  );

  console.log('Total orders: ' + allOrders.length);

  // Count occurrences of each name
  const nameCounts = {};
  for (const o of allOrders) {
    nameCounts[o.name] = (nameCounts[o.name] || 0) + 1;
  }

  // Find duplicate names
  const duplicateNames = Object.keys(nameCounts).filter(n => nameCounts[n] > 1);
  console.log('Duplicate order names: ' + duplicateNames.length + '\n');

  // Now find which of these have "to invoice" status
  let fixed = 0;
  for (const name of duplicateNames) {
    const ordersWithName = await odoo.searchRead('sale.order',
      [['name', '=', name], ['invoice_status', '=', 'to invoice']],
      ['id']
    );

    if (ordersWithName.length === 0) continue;

    console.log(name + ': ' + ordersWithName.length + ' order(s) to fix');

    for (const order of ordersWithName) {
      const lines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', order.id]],
        ['id']
      );
      const lineIds = lines.map(l => l.id);
      if (lineIds.length > 0) {
        await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
        console.log('  Order ' + order.id + ': marked ' + lineIds.length + ' lines as invoiced');
      }
    }
    fixed++;
  }

  console.log('\n=== SUMMARY ===');
  console.log('Fixed ' + fixed + ' duplicate order groups');
}

main().catch(e => console.error(e));
