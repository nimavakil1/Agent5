require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const SERVICE_PRODUCT_IDS = [16401, 16402, 16403, 16404];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '200');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX DUPLICATE ORDERS - UNDER-INVOICED (v2) ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Get ALL FBA/FBM orders (not just to invoice)
  console.log('Fetching all orders...');
  const allOrders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_status', 'invoice_ids', 'partner_id'],
    { limit: 50000, order: 'name asc' }
  );

  console.log('Found ' + allOrders.length + ' total FBA/FBM orders\n');

  // Group by order name to find duplicates
  const ordersByName = {};
  for (const order of allOrders) {
    if (!ordersByName[order.name]) {
      ordersByName[order.name] = [];
    }
    ordersByName[order.name].push(order);
  }

  // Find duplicate groups where:
  // - At least one order has "to invoice" status
  // - At least one order in the group has no invoice
  // - At least one order in the group HAS an invoice
  const toFix = [];
  for (const [name, orderList] of Object.entries(ordersByName)) {
    if (orderList.length <= 1) continue;

    const hasToInvoice = orderList.some(o => o.invoice_status === 'to invoice');
    if (!hasToInvoice) continue;

    // Check if any order has no invoice AND status "to invoice"
    const ordersNeedingInvoice = orderList.filter(o =>
      o.invoice_ids.length === 0 && o.invoice_status === 'to invoice'
    );
    if (ordersNeedingInvoice.length === 0) continue;

    // Check if some orders DO have invoices (so we can get journal)
    const ordersWithInvoice = orderList.filter(o => o.invoice_ids.length > 0);

    toFix.push({
      name,
      ordersNeedingInvoice,
      ordersWithInvoice,
      allOrders: orderList
    });
  }

  console.log('Found ' + toFix.length + ' duplicate groups needing invoice creation\n');

  let fixed = 0;
  let errors = 0;
  let invoicesCreated = 0;

  for (const group of toFix) {
    if (fixed >= limit) break;

    console.log(group.name + ':');
    console.log('  Orders needing invoice: ' + group.ordersNeedingInvoice.length);
    console.log('  Orders with invoice: ' + group.ordersWithInvoice.length);

    // Get journal from existing invoice if available
    let journalId = 1; // Default
    if (group.ordersWithInvoice.length > 0) {
      const existingInvoice = await odoo.searchRead('account.move',
        [['id', 'in', group.ordersWithInvoice[0].invoice_ids]],
        ['journal_id']
      );
      if (existingInvoice.length > 0 && existingInvoice[0].journal_id) {
        journalId = existingInvoice[0].journal_id[0];
      }
    }

    for (const order of group.ordersNeedingInvoice) {
      console.log('  Creating invoice for order ID ' + order.id + ' (EUR ' + order.amount_total.toFixed(2) + ')');

      if (!dryRun) {
        try {
          // Get order lines
          const lines = await odoo.searchRead('sale.order.line',
            [['order_id', '=', order.id]],
            ['id', 'product_id', 'product_uom_qty', 'qty_delivered', 'price_unit', 'tax_id', 'name']
          );

          // Skip if all lines are service products
          const productLines = lines.filter(l =>
            l.product_id && !SERVICE_PRODUCT_IDS.includes(l.product_id[0])
          );

          if (productLines.length === 0) {
            console.log('    Only service lines, marking as invoiced');
            const lineIds = lines.map(l => l.id);
            await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
            fixed++;
            continue;
          }

          // Create invoice lines
          const invoiceLines = [];
          for (const line of productLines) {
            // Use qty_delivered as quantity
            const qty = line.qty_delivered || line.product_uom_qty;
            if (qty <= 0) continue;

            invoiceLines.push([0, 0, {
              product_id: line.product_id[0],
              name: line.name || line.product_id[1],
              quantity: qty,
              price_unit: line.price_unit,
              tax_ids: line.tax_id ? [[6, 0, line.tax_id]] : false,
              sale_line_ids: [[6, 0, [line.id]]]
            }]);
          }

          if (invoiceLines.length === 0) {
            console.log('    No lines to invoice, marking as invoiced');
            const lineIds = lines.map(l => l.id);
            await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
            fixed++;
            continue;
          }

          // Create the invoice
          const invoiceId = await odoo.execute('account.move', 'create', [{
            move_type: 'out_invoice',
            partner_id: order.partner_id[0],
            journal_id: journalId,
            invoice_date: new Date().toISOString().split('T')[0],
            ref: order.name,
            invoice_line_ids: invoiceLines
          }]);

          console.log('    Created invoice ID: ' + invoiceId);
          invoicesCreated++;

          // Link invoice to sale order
          const currentInvoiceIds = order.invoice_ids || [];
          currentInvoiceIds.push(invoiceId);
          await odoo.execute('sale.order', 'write', [[order.id], {
            invoice_ids: [[6, 0, currentInvoiceIds]]
          }]);

          // Post the invoice
          await odoo.execute('account.move', 'action_post', [[invoiceId]]);
          console.log('    Posted invoice');

          // Mark order lines as invoiced
          const lineIds = lines.map(l => l.id);
          await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
          console.log('    Marked lines as invoiced');

          fixed++;
        } catch (err) {
          console.log('    ERROR: ' + err.message);
          errors++;
        }
      } else {
        console.log('    [DRY RUN] Would create invoice');
        fixed++;
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Groups found: ' + toFix.length);
  console.log('Orders fixed: ' + fixed);
  console.log('Invoices created: ' + invoicesCreated);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to fix.');
  }
}

main().catch(e => console.error(e));
