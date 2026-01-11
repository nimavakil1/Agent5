require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '10');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX FULLY REFUNDED ORDERS ===');
  console.log('Orders with invoice + credit note that cancel out');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Find orders with invoices
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

  let refundedCount = 0;
  let fixed = 0;
  let errors = 0;

  for (const order of orders) {
    if (fixed >= limit) break;

    // Get invoices
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'move_type', 'state', 'amount_total']
    );

    const regularInvoices = invoices.filter(i => i.move_type === 'out_invoice' && i.state === 'posted');
    const creditNotes = invoices.filter(i => i.move_type === 'out_refund' && i.state === 'posted');

    // Check if invoice amounts are fully covered by credit notes
    const invoiceTotal = regularInvoices.reduce((sum, i) => sum + i.amount_total, 0);
    const creditTotal = creditNotes.reduce((sum, i) => sum + i.amount_total, 0);

    // If credit notes >= invoices, order is fully refunded
    if (creditNotes.length > 0 && Math.abs(invoiceTotal - creditTotal) < 0.01) {
      refundedCount++;

      // Get order lines to check for negative delivered
      const orderLines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', order.id]],
        ['id', 'qty_delivered', 'invoice_status']
      );

      const hasNegativeDelivered = orderLines.some(l => l.qty_delivered < 0);

      if (hasNegativeDelivered || creditTotal >= invoiceTotal) {
        console.log('Order: ' + order.name);
        console.log('  Invoice total: EUR ' + invoiceTotal.toFixed(2));
        console.log('  Credit total: EUR ' + creditTotal.toFixed(2));
        console.log('  Status: FULLY REFUNDED');

        if (!dryRun) {
          try {
            const lineIds = orderLines.map(l => l.id);
            await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
            console.log('  FIXED!\n');
            fixed++;
          } catch (err) {
            console.log('  ERROR: ' + err.message + '\n');
            errors++;
          }
        } else {
          console.log('  [DRY RUN - would mark as invoiced]\n');
          fixed++;
        }
      }
    }
  }

  console.log('=== SUMMARY ===');
  console.log('Fully refunded orders found: ' + refundedCount);
  console.log('Orders fixed: ' + fixed);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to actually fix.');
  }
}

main().catch(e => console.error(e));
