require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX ORDERS WHERE AMOUNTS MATCH (Safe to mark as invoiced) ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE') + '\n');

  // Get orders that are 'to invoice' but have invoices linked
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_ids', 'date_order'],
    { limit: 3000, order: 'date_order asc' }
  );

  console.log('Found ' + orders.length + ' orders to analyze\n');

  const safeToFix = [];

  for (const order of orders) {
    // Get invoice details
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'name', 'move_type', 'state', 'amount_total']
    );

    let totalInvoiced = 0;
    let totalCredited = 0;
    let hasPosted = false;

    for (const inv of invoices) {
      if (inv.state === 'posted') {
        hasPosted = true;
        if (inv.move_type === 'out_invoice') {
          totalInvoiced += inv.amount_total;
        } else if (inv.move_type === 'out_refund') {
          totalCredited += inv.amount_total;
        }
      }
    }

    const netInvoiced = totalInvoiced - totalCredited;
    const diff = netInvoiced - order.amount_total;

    // Only process orders where amounts match (within EUR 1 tolerance)
    if (hasPosted && Math.abs(diff) < 1) {
      safeToFix.push({
        id: order.id,
        name: order.name,
        orderTotal: order.amount_total,
        netInvoiced: netInvoiced,
        diff: diff
      });
    }
  }

  console.log('Orders safe to fix (amounts match): ' + safeToFix.length + '\n');

  let fixed = 0;
  let errors = 0;

  for (const order of safeToFix) {
    console.log(order.name + ': Order EUR ' + order.orderTotal.toFixed(2) + ' = Invoiced EUR ' + order.netInvoiced.toFixed(2));

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
          console.log('  -> Marked ' + lineIds.length + ' lines as invoiced');
        } else {
          console.log('  -> All lines already invoiced');
        }
        fixed++;
      } catch (err) {
        console.log('  -> ERROR: ' + err.message);
        errors++;
      }
    } else {
      console.log('  -> [DRY RUN] would mark lines as invoiced');
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
