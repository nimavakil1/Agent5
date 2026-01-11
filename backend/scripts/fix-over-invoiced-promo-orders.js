require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '10');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX OVER-INVOICED PROMOTION ORDERS ===');
  console.log('Sets invoice_status="invoiced" on ALL lines of orders with over-invoicing + missing promotions');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Find orders with promotion lines missing AND other invoice issues
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'invoice_ids'],
    { limit: 2000, order: 'date_order asc' }
  );

  console.log('Checking ' + orders.length + ' orders...\n');

  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  for (const order of orders) {
    if (fixed >= limit) break;

    // Get order lines
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'product_id', 'qty_to_invoice', 'invoice_lines', 'invoice_status', 'qty_invoiced', 'qty_delivered']
    );

    // Find orphaned promotion lines (product 16404)
    const orphanedPromoLines = orderLines.filter(l =>
      l.qty_to_invoice > 0 &&
      (!l.invoice_lines || l.invoice_lines.length === 0) &&
      l.product_id && l.product_id[0] === 16404 &&
      l.invoice_status !== 'invoiced'
    );

    if (orphanedPromoLines.length === 0) continue;

    // Check if ALL orphaned lines are promotions
    const allOrphanedLines = orderLines.filter(l =>
      l.qty_to_invoice > 0 && (!l.invoice_lines || l.invoice_lines.length === 0)
    );
    const allArePromotions = allOrphanedLines.every(l => l.product_id && l.product_id[0] === 16404);

    if (!allArePromotions) continue;

    // Check for over-invoicing issues on other lines
    const otherLines = orderLines.filter(l => !(l.product_id && l.product_id[0] === 16404));
    const hasOverInvoicing = otherLines.some(l =>
      l.invoice_status === 'to invoice' && l.qty_invoiced > l.qty_delivered
    );

    if (!hasOverInvoicing) continue; // Not an over-invoiced order

    // Get invoices to show info
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids], ['move_type', '=', 'out_invoice']],
      ['name', 'amount_total']
    );
    const invoiceInfo = invoices.map(i => i.name + ' EUR ' + i.amount_total).join(', ');

    console.log('Order: ' + order.name);
    console.log('  Invoice(s): ' + invoiceInfo);
    console.log('  Lines to fix: ' + orderLines.length);

    if (!dryRun) {
      try {
        const lineIds = orderLines.map(l => l.id);
        await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
        console.log('  FIXED!');
        fixed++;
      } catch (err) {
        console.log('  ERROR: ' + err.message);
        errors++;
      }
    } else {
      console.log('  [DRY RUN - would set invoice_status=invoiced on all lines]');
      fixed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Orders fixed: ' + fixed);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to actually fix.');
  }
}

main().catch(e => console.error(e));
