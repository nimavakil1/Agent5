require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX DUPLICATE ORDERS - AMOUNTS MATCH ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE') + '\n');

  // Get all FBA/FBM orders
  const orders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_status', 'invoice_ids'],
    { limit: 50000, order: 'name asc' }
  );

  // Group by order name
  const ordersByName = {};
  for (const order of orders) {
    if (!ordersByName[order.name]) {
      ordersByName[order.name] = [];
    }
    ordersByName[order.name].push(order);
  }

  // Find duplicates with "to invoice" and amounts match
  let fixed = 0;
  let checked = 0;

  for (const [name, orderList] of Object.entries(ordersByName)) {
    if (orderList.length <= 1) continue;

    const hasToInvoice = orderList.some(o => o.invoice_status === 'to invoice');
    if (!hasToInvoice) continue;

    checked++;

    // Get all invoices for this group
    const allInvoiceIds = [];
    for (const o of orderList) {
      allInvoiceIds.push(...o.invoice_ids);
    }
    const uniqueInvoiceIds = [...new Set(allInvoiceIds)];

    if (uniqueInvoiceIds.length === 0) continue;

    // Calculate totals
    const totalOrderAmount = orderList.reduce((sum, o) => sum + o.amount_total, 0);

    // Get invoices
    let totalInvoiced = 0;
    let totalCredited = 0;
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', uniqueInvoiceIds]],
      ['id', 'move_type', 'state', 'amount_total']
    );
    for (const inv of invoices) {
      if (inv.state === 'posted' || inv.state === 'draft') {
        if (inv.move_type === 'out_invoice') {
          totalInvoiced += inv.amount_total;
        } else if (inv.move_type === 'out_refund') {
          totalCredited += inv.amount_total;
        }
      }
    }

    const netInvoiced = totalInvoiced - totalCredited;
    const diff = Math.abs(netInvoiced - totalOrderAmount);

    // Only fix if amounts match (within tolerance)
    if (diff >= 0.10) continue;

    console.log(name + ' (' + orderList.length + ' orders)');
    console.log('  Order total: EUR ' + totalOrderAmount.toFixed(2));
    console.log('  Net invoiced: EUR ' + netInvoiced.toFixed(2));

    if (!dryRun) {
      // Mark all order lines as invoiced
      for (const order of orderList) {
        const lines = await odoo.searchRead('sale.order.line',
          [['order_id', '=', order.id]],
          ['id']
        );
        const lineIds = lines.map(l => l.id);
        if (lineIds.length > 0) {
          await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
        }
      }
      console.log('  FIXED - marked all lines as invoiced');
      fixed++;
    } else {
      console.log('  [DRY RUN] Would mark all lines as invoiced');
      fixed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Groups checked: ' + checked);
  console.log('Fixed: ' + fixed);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to fix.');
  }
}

main().catch(e => console.error(e));
