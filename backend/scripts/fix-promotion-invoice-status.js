require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '10');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX PROMOTION LINE INVOICE STATUS ===');
  console.log('Sets invoice_status="invoiced" on promotion discount lines');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Find orders with only promotion lines missing
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
      ['id', 'product_id', 'qty_to_invoice', 'invoice_lines', 'invoice_status', 'price_subtotal']
    );

    // Find orphaned promotion lines (product 16404 with qty_to_invoice > 0)
    const orphanedPromoLines = orderLines.filter(l =>
      l.qty_to_invoice > 0 &&
      (!l.invoice_lines || l.invoice_lines.length === 0) &&
      l.product_id && l.product_id[0] === 16404 &&
      l.invoice_status !== 'invoiced'
    );

    if (orphanedPromoLines.length === 0) continue;

    // Check that ALL orphaned lines are promotions (no other products missing)
    const allOrphanedLines = orderLines.filter(l =>
      l.qty_to_invoice > 0 && (!l.invoice_lines || l.invoice_lines.length === 0)
    );
    const allArePromotions = allOrphanedLines.every(l => l.product_id && l.product_id[0] === 16404);

    if (!allArePromotions) {
      // Skip orders with other missing products
      continue;
    }

    // Check that other lines are properly invoiced (no over-invoicing issues)
    const otherLines = orderLines.filter(l => !(l.product_id && l.product_id[0] === 16404));
    const hasInvoiceIssues = otherLines.some(l => l.invoice_status === 'to invoice');

    if (hasInvoiceIssues) {
      // Skip orders with other invoice issues
      skipped++;
      continue;
    }

    const totalPromoAmount = orphanedPromoLines.reduce((sum, l) => sum + (l.price_subtotal || 0), 0);

    console.log('Order: ' + order.name);
    console.log('  Promotion lines to fix: ' + orphanedPromoLines.length);
    console.log('  Total amount: EUR ' + totalPromoAmount.toFixed(2));

    if (!dryRun) {
      try {
        const lineIds = orphanedPromoLines.map(l => l.id);
        await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
        console.log('  FIXED!');
        fixed++;
      } catch (err) {
        console.log('  ERROR: ' + err.message);
        errors++;
      }
    } else {
      console.log('  [DRY RUN - would set invoice_status=invoiced]');
      fixed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Orders fixed: ' + fixed);
  console.log('Skipped (other issues): ' + skipped);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to actually fix.');
  }
}

main().catch(e => console.error(e));
