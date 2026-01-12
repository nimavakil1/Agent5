require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '500');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX ORDERS WITH INVOICES (Mark Lines as Invoiced) ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Get orders that are 'to invoice' but have invoices linked
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_ids'],
    { limit: limit, order: 'date_order asc' }
  );

  console.log('Found ' + orders.length + ' orders with invoices but "to invoice" status\n');

  let fixed = 0;
  let errors = 0;

  for (const order of orders) {
    if (!dryRun) {
      try {
        // Get all order lines
        const lines = await odoo.searchRead('sale.order.line',
          [['order_id', '=', order.id]],
          ['id', 'invoice_status']
        );

        // Filter lines that aren't already invoiced
        const linesToFix = lines.filter(l => l.invoice_status !== 'invoiced');

        if (linesToFix.length > 0) {
          const lineIds = linesToFix.map(l => l.id);
          await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);

          if (fixed < 20 || fixed % 100 === 0) {
            console.log(order.name + ': marked ' + lineIds.length + ' lines as invoiced');
          }
        }
        fixed++;
      } catch (err) {
        console.log(order.name + ': ERROR - ' + err.message);
        errors++;
      }
    } else {
      if (fixed < 20) {
        console.log(order.name + ': [DRY RUN] would mark lines as invoiced');
      }
      fixed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Orders processed: ' + fixed);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to fix.');
  }
}

main().catch(e => console.error(e));
