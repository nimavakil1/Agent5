require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== MARK REMAINING DUPLICATE ORDER LINES AS INVOICED ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE') + '\n');

  // Get ALL orders
  const allOrders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_status', 'invoice_ids'],
    { limit: 50000 }
  );

  // Group by name
  const byName = {};
  for (const o of allOrders) {
    if (!byName[o.name]) byName[o.name] = [];
    byName[o.name].push(o);
  }

  let fixed = 0;

  for (const [name, orders] of Object.entries(byName)) {
    if (orders.length <= 1) continue;

    // Check if any order still has "to invoice" status
    const ordersToFix = orders.filter(o => o.invoice_status === 'to invoice');
    if (ordersToFix.length === 0) continue;

    console.log(name + ': ' + ordersToFix.length + ' order(s) still "to invoice"');

    if (!dryRun) {
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
      }
      fixed++;
    } else {
      console.log('  [DRY RUN] Would mark lines as invoiced');
      fixed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Duplicate groups fixed: ' + fixed);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to fix.');
  }
}

main().catch(e => console.error(e));
