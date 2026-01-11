require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Known amounts-match cases from analysis
const AMOUNTS_MATCH_ORDERS = [
  'FBA028-5976887-6020343',
  'FBA304-3756897-4762750',
  'FBA404-6383242-3964342'
];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX DUPLICATE ORDERS - AMOUNTS MATCH ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Orders to fix: ' + AMOUNTS_MATCH_ORDERS.length + '\n');

  let fixed = 0;

  for (const orderName of AMOUNTS_MATCH_ORDERS) {
    console.log('Processing: ' + orderName);

    // Get all Odoo orders with this name
    const orders = await odoo.searchRead('sale.order',
      [['name', '=', orderName]],
      ['id', 'name', 'amount_total', 'invoice_status', 'invoice_ids']
    );

    console.log('  Found ' + orders.length + ' Odoo orders');

    for (const order of orders) {
      console.log('  Order ID ' + order.id + ': EUR ' + order.amount_total.toFixed(2) + ' [' + order.invoice_status + ']');

      if (order.invoice_status !== 'to invoice') {
        console.log('    Already invoiced, skipping');
        continue;
      }

      if (!dryRun) {
        // Get order lines
        const lines = await odoo.searchRead('sale.order.line',
          [['order_id', '=', order.id]],
          ['id']
        );
        const lineIds = lines.map(l => l.id);

        if (lineIds.length > 0) {
          await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
          console.log('    Marked ' + lineIds.length + ' lines as invoiced');
        }
        fixed++;
      } else {
        console.log('    [DRY RUN] Would mark lines as invoiced');
        fixed++;
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Fixed: ' + fixed);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to fix.');
  }
}

main().catch(e => console.error(e));
