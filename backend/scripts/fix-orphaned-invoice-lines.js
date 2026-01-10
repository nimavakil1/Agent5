require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '10');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX ORPHANED INVOICE LINES (MULTI-LINK) ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Find orders with orphaned lines
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

  console.log('Checking ' + orders.length + ' orders for orphaned lines...\n');

  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  for (const order of orders) {
    if (fixed >= limit) break;

    // Get order lines
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines']
    );

    // Find orphaned lines (qty_to_invoice > 0 AND no invoice_lines linked)
    const orphanedLines = orderLines.filter(l => 
      l.qty_to_invoice > 0 && (!l.invoice_lines || l.invoice_lines.length === 0)
    );

    if (orphanedLines.length === 0) continue;

    // Get only REGULAR invoices (not credit notes)
    const regularInvoices = await odoo.searchRead('account.move',
      [
        ['id', 'in', order.invoice_ids],
        ['move_type', '=', 'out_invoice']  // Only regular invoices, NOT credit notes (out_refund)
      ],
      ['id']
    );
    const regularInvoiceIds = regularInvoices.map(inv => inv.id);

    if (regularInvoiceIds.length === 0) {
      console.log('\nOrder: ' + order.name);
      console.log('  SKIPPED: No regular invoices (only credit notes)');
      continue;
    }

    // Get invoice lines only from regular invoices
    const invoiceLines = await odoo.searchRead('account.move.line',
      [
        ['move_id', 'in', regularInvoiceIds],
        ['display_type', '=', 'product']
      ],
      ['id', 'product_id', 'quantity', 'sale_line_ids']
    );

    console.log('\nOrder: ' + order.name);
    console.log('  Orphaned order lines: ' + orphanedLines.length);
    console.log('  Invoice lines available: ' + invoiceLines.length);

    let orderFixed = false;

    // Group orphaned lines by product
    const orphanedByProduct = {};
    for (const line of orphanedLines) {
      const productId = line.product_id ? line.product_id[0] : 0;
      if (!orphanedByProduct[productId]) {
        orphanedByProduct[productId] = [];
      }
      orphanedByProduct[productId].push(line);
    }

    // For each product, find invoice lines with same product and link to ALL orphaned order lines
    for (const [productId, orphanedForProduct] of Object.entries(orphanedByProduct)) {
      // Find invoice line(s) with this product
      const matchingInvLines = invoiceLines.filter(il => 
        il.product_id && il.product_id[0] === parseInt(productId)
      );

      if (matchingInvLines.length === 0) {
        console.log('  NO invoice line found for product ' + productId);
        continue;
      }

      // Use the first matching invoice line
      const invLine = matchingInvLines[0];
      
      // Get all order line IDs for this product (orphaned + already linked)
      const allOrderLineIds = orderLines
        .filter(ol => ol.product_id && ol.product_id[0] === parseInt(productId))
        .map(ol => ol.id);

      // Current linked order lines
      const currentLinked = invLine.sale_line_ids || [];
      
      // Merge: add orphaned lines to existing linked lines
      const newLinkedIds = [...new Set([...currentLinked, ...allOrderLineIds])];

      if (newLinkedIds.length === currentLinked.length) {
        console.log('  Product ' + productId + ': Already fully linked');
        continue;
      }

      console.log('  LINKING invoice line ' + invLine.id + ' to order lines: ' + JSON.stringify(newLinkedIds));
      console.log('    (was: ' + JSON.stringify(currentLinked) + ')');

      if (!dryRun) {
        try {
          await odoo.execute('account.move.line', 'write', [
            [invLine.id],
            { sale_line_ids: [[6, 0, newLinkedIds]] }  // 6,0 = replace with new list
          ]);
          console.log('    LINKED!');
          orderFixed = true;
        } catch (err) {
          console.log('    ERROR: ' + err.message);
          errors++;
        }
      } else {
        console.log('    [DRY RUN - would link]');
        orderFixed = true;
      }
    }

    if (orderFixed) fixed++;
  }

  console.log('\n=== SUMMARY ===');
  console.log('Orders fixed: ' + fixed);
  console.log('Errors: ' + errors);
  
  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to actually fix.');
  }
}

main().catch(e => console.error(e));
