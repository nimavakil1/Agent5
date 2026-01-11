require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const SERVICE_PRODUCT_IDS = [16401, 16402, 16403, 16404];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '50');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX DUPLICATE ORDERS - OVER-INVOICED ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Get all FBA/FBM orders
  console.log('Fetching orders...');
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_ids', 'partner_id'],
    { limit: 50000, order: 'name asc' }
  );

  console.log('Found ' + orders.length + ' orders with "to invoice" status\n');

  // Group by order name to find duplicates
  const ordersByName = {};
  for (const order of orders) {
    if (!ordersByName[order.name]) {
      ordersByName[order.name] = [];
    }
    ordersByName[order.name].push(order);
  }

  // Find duplicate groups that are over-invoiced
  const toFix = [];
  for (const [name, orderList] of Object.entries(ordersByName)) {
    if (orderList.length <= 1) continue;

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
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', uniqueInvoiceIds]],
      ['id', 'move_type', 'state', 'amount_total', 'journal_id']
    );

    let totalInvoiced = 0;
    let totalCredited = 0;
    let journalId = 1;

    for (const inv of invoices) {
      if (inv.state === 'posted' || inv.state === 'draft') {
        if (inv.move_type === 'out_invoice') {
          totalInvoiced += inv.amount_total;
          journalId = inv.journal_id[0];
        } else if (inv.move_type === 'out_refund') {
          totalCredited += inv.amount_total;
        }
      }
    }

    const netInvoiced = totalInvoiced - totalCredited;
    const diff = netInvoiced - totalOrderAmount;

    // Only fix if over-invoiced (diff > 0)
    if (diff <= 0.10) continue;

    toFix.push({
      name,
      orders: orderList,
      totalOrderAmount,
      netInvoiced,
      overAmount: diff,
      journalId,
      partnerId: orderList[0].partner_id[0]
    });
  }

  console.log('Found ' + toFix.length + ' over-invoiced duplicate groups\n');

  let fixed = 0;
  let errors = 0;
  let creditNotesCreated = 0;

  for (const group of toFix) {
    if (fixed >= limit) break;

    console.log(group.name + ':');
    console.log('  Order total: EUR ' + group.totalOrderAmount.toFixed(2));
    console.log('  Net invoiced: EUR ' + group.netInvoiced.toFixed(2));
    console.log('  Over by: EUR ' + group.overAmount.toFixed(2));

    if (!dryRun) {
      try {
        // Create a credit note for the over-invoiced amount
        // Use a generic product or create a correction line
        const creditNoteId = await odoo.execute('account.move', 'create', [{
          move_type: 'out_refund',
          partner_id: group.partnerId,
          journal_id: group.journalId,
          invoice_date: new Date().toISOString().split('T')[0],
          ref: 'Correction for duplicate order ' + group.name,
          invoice_line_ids: [[0, 0, {
            name: 'Correction for over-invoicing on ' + group.name,
            quantity: 1,
            price_unit: group.overAmount
          }]]
        }]);

        console.log('  Created credit note ID: ' + creditNoteId);
        creditNotesCreated++;

        // Link credit note to all orders in the group
        for (const order of group.orders) {
          const currentInvoiceIds = order.invoice_ids || [];
          if (!currentInvoiceIds.includes(creditNoteId)) {
            currentInvoiceIds.push(creditNoteId);
            await odoo.execute('sale.order', 'write', [[order.id], {
              invoice_ids: [[6, 0, currentInvoiceIds]]
            }]);
          }
        }

        // Post the credit note
        await odoo.execute('account.move', 'action_post', [[creditNoteId]]);
        console.log('  Posted credit note');

        // Mark all order lines as invoiced
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
      console.log('  [DRY RUN] Would create credit note for EUR ' + group.overAmount.toFixed(2));
      fixed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Groups processed: ' + Math.min(toFix.length, limit));
  console.log('Fixed: ' + fixed);
  console.log('Credit notes created: ' + creditNotesCreated);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to fix.');
  }
}

main().catch(e => console.error(e));
