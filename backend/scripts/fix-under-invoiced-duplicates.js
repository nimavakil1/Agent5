require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX UNDER-INVOICED DUPLICATE ORDERS ===');
  console.log('Creates invoice for missing amount and marks orders as invoiced');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Get ALL orders
  console.log('Fetching orders...');
  const allOrders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_status', 'invoice_ids', 'partner_id'],
    { limit: 50000 }
  );

  console.log('Fetched ' + allOrders.length + ' orders\n');

  // Group by name
  const byName = {};
  for (const o of allOrders) {
    if (!byName[o.name]) byName[o.name] = [];
    byName[o.name].push(o);
  }

  // Find under-invoiced duplicates
  const toFix = [];
  for (const [name, orders] of Object.entries(byName)) {
    if (orders.length <= 1) continue;
    if (!orders.some(o => o.invoice_status === 'to invoice')) continue;

    // Get all invoice IDs
    const invoiceIds = [...new Set(orders.flatMap(o => o.invoice_ids))];
    const totalOrder = orders.reduce((s, o) => s + o.amount_total, 0);

    let netInvoiced = 0;
    let journalId = 1;
    if (invoiceIds.length > 0) {
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', invoiceIds]],
        ['id', 'move_type', 'state', 'amount_total', 'journal_id']
      );
      for (const inv of invoices) {
        if (inv.state === 'posted' || inv.state === 'draft') {
          if (inv.move_type === 'out_invoice') {
            netInvoiced += inv.amount_total;
            journalId = inv.journal_id[0];
          } else if (inv.move_type === 'out_refund') {
            netInvoiced -= inv.amount_total;
          }
        }
      }
    }

    const diff = netInvoiced - totalOrder;

    // Only fix under-invoiced cases (diff < -1)
    if (diff >= -1) continue;

    toFix.push({
      name,
      orders,
      totalOrder,
      netInvoiced,
      underBy: Math.abs(diff),
      journalId,
      partnerId: orders[0].partner_id[0]
    });
  }

  console.log('Found ' + toFix.length + ' under-invoiced duplicate groups\n');

  let fixed = 0;
  let invoicesCreated = 0;
  let errors = 0;

  for (const group of toFix) {
    if (fixed >= limit) break;

    console.log(group.name + ':');
    console.log('  Order total: EUR ' + group.totalOrder.toFixed(2));
    console.log('  Net invoiced: EUR ' + group.netInvoiced.toFixed(2));
    console.log('  Under by: EUR ' + group.underBy.toFixed(2));

    if (!dryRun) {
      try {
        // Create invoice for the missing amount
        const invoiceId = await odoo.execute('account.move', 'create', [{
          move_type: 'out_invoice',
          partner_id: group.partnerId,
          journal_id: group.journalId,
          invoice_date: new Date().toISOString().split('T')[0],
          ref: group.name + ' - Balance correction',
          invoice_line_ids: [[0, 0, {
            name: 'Balance correction for ' + group.name,
            quantity: 1,
            price_unit: group.underBy
          }]]
        }]);

        console.log('  Created invoice ID: ' + invoiceId + ' for EUR ' + group.underBy.toFixed(2));
        invoicesCreated++;

        // Link invoice to all orders in the group
        for (const order of group.orders) {
          const currentIds = order.invoice_ids || [];
          if (!currentIds.includes(invoiceId)) {
            currentIds.push(invoiceId);
            await odoo.execute('sale.order', 'write', [[order.id], {
              invoice_ids: [[6, 0, currentIds]]
            }]);
          }
        }

        // Post the invoice
        await odoo.execute('account.move', 'action_post', [[invoiceId]]);
        console.log('  Posted invoice');

        // Mark ALL order lines as invoiced
        for (const order of group.orders) {
          const lines = await odoo.searchRead('sale.order.line',
            [['order_id', '=', order.id]],
            ['id']
          );
          const lineIds = lines.map(l => l.id);
          if (lineIds.length > 0) {
            await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
          }
        }
        console.log('  Marked all order lines as invoiced');

        fixed++;
      } catch (err) {
        console.log('  ERROR: ' + err.message);
        errors++;
      }
    } else {
      console.log('  [DRY RUN] Would create invoice for EUR ' + group.underBy.toFixed(2) + ' and mark as invoiced');
      fixed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Groups found: ' + toFix.length);
  console.log('Fixed: ' + fixed);
  console.log('Invoices created: ' + invoicesCreated);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to fix.');
  }
}

main().catch(e => console.error(e));
