require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// These product IDs are Amazon fee/discount products that don't need actual invoicing
const SERVICE_PRODUCT_IDS = [
  16403, // FBA Gift Wrapper Fee
  16404, // FBA Promotion Discount
  16401, // Shipping Fee
  16402  // Other shipping
];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX GIFT WRAPPER & PROMOTION ORDERS ===');
  console.log('Sets invoice_status="invoiced" on service lines (gift wrapper, promotions, shipping)');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Find orders still "to invoice" with invoices
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'invoice_ids'],
    { limit: 3000, order: 'date_order asc' }
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

    // Separate service lines (gift wrapper, promotions) from product lines
    const serviceLines = orderLines.filter(l =>
      l.product_id && SERVICE_PRODUCT_IDS.includes(l.product_id[0])
    );
    const productLines = orderLines.filter(l =>
      l.product_id && !SERVICE_PRODUCT_IDS.includes(l.product_id[0])
    );

    // Find service lines that are orphaned (not invoiced, have qty_to_invoice > 0)
    const orphanedServiceLines = serviceLines.filter(l =>
      l.qty_to_invoice !== 0 && l.invoice_status !== 'invoiced'
    );

    if (orphanedServiceLines.length === 0) continue;

    // Check if ALL product lines are fully invoiced
    const productLinesOK = productLines.every(l =>
      l.invoice_status === 'invoiced' || l.qty_to_invoice === 0
    );

    if (!productLinesOK) {
      // Product lines have issues, skip this order
      skipped++;
      continue;
    }

    // All product lines OK, only service lines need fixing
    const serviceNames = orphanedServiceLines.map(l => l.product_id[1]).join(', ');
    console.log('Order: ' + order.name);
    console.log('  Service lines to fix: ' + serviceNames);

    if (!dryRun) {
      try {
        const lineIds = orphanedServiceLines.map(l => l.id);
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
  console.log('Orders skipped (product issues): ' + skipped);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to actually fix.');
  }
}

main().catch(e => console.error(e));
