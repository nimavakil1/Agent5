require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Service product IDs to exclude from analysis
const SERVICE_PRODUCT_IDS = [16401, 16402, 16403, 16404];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX OVER-INVOICED ORDERS (Amounts Match) ===');
  console.log('Fixes orders where order total = net invoiced, but line linkage is wrong');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'invoice_ids', 'amount_total'],
    { limit: 2000, order: 'date_order asc' }
  );

  console.log('Checking ' + orders.length + ' orders...\n');

  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  for (const order of orders) {
    if (fixed >= limit) break;

    // Get order lines
    const lines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'product_id', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_status']
    );

    // Check for over-invoicing on product lines
    const productLines = lines.filter(l => l.product_id && !SERVICE_PRODUCT_IDS.includes(l.product_id[0]));
    const hasOverInvoicing = productLines.some(l => l.qty_invoiced > l.qty_delivered && l.qty_delivered > 0);

    if (!hasOverInvoicing) continue;

    // Get invoices
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'move_type', 'state', 'amount_total']
    );

    const regularInvoices = invoices.filter(i => i.move_type === 'out_invoice' && i.state === 'posted');
    const creditNotes = invoices.filter(i => i.move_type === 'out_refund' && i.state === 'posted');

    const invoiceTotal = regularInvoices.reduce((sum, i) => sum + i.amount_total, 0);
    const creditTotal = creditNotes.reduce((sum, i) => sum + i.amount_total, 0);
    const netInvoiced = invoiceTotal - creditTotal;

    // Compare to order total
    const orderTotal = order.amount_total;
    const diff = Math.abs(netInvoiced - orderTotal);

    if (diff >= 0.10) {
      skipped++;
      continue; // Amounts don't match, skip
    }

    // Amounts match - mark all lines as invoiced
    console.log('Order: ' + order.name);
    console.log('  Order Total: EUR ' + orderTotal.toFixed(2));
    console.log('  Net Invoiced: EUR ' + netInvoiced.toFixed(2));

    if (!dryRun) {
      try {
        const lineIds = lines.map(l => l.id);
        await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
        console.log('  FIXED!');
        fixed++;
      } catch (err) {
        console.log('  ERROR: ' + err.message);
        errors++;
      }
    } else {
      console.log('  [DRY RUN - would mark all lines as invoiced]');
      fixed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Orders fixed: ' + fixed);
  console.log('Orders skipped (amounts differ): ' + skipped);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to actually fix.');
  }
}

main().catch(e => console.error(e));
