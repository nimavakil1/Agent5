require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== INVESTIGATING OVER-INVOICED PROMOTION ORDERS ===\n');

  // Find orders with promotion lines missing AND other invoice issues
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

  let overInvoicedOrders = [];

  for (const order of orders) {
    // Get order lines
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'product_id', 'qty_to_invoice', 'invoice_lines', 'invoice_status', 'price_subtotal', 'product_uom_qty', 'qty_invoiced', 'qty_delivered']
    );

    // Find orphaned promotion lines
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

    // Check for other invoice issues (over-invoicing)
    const otherLines = orderLines.filter(l => !(l.product_id && l.product_id[0] === 16404));
    const problemLines = otherLines.filter(l => l.invoice_status === 'to invoice');

    if (problemLines.length > 0) {
      overInvoicedOrders.push({
        order,
        orderLines,
        orphanedPromoLines,
        problemLines
      });
    }

    if (overInvoicedOrders.length >= 20) break; // Limit for analysis
  }

  console.log('Found ' + overInvoicedOrders.length + ' over-invoiced promotion orders (showing up to 20)\n');

  // Analyze patterns
  let patterns = {
    overInvoiced: 0,      // qty_invoiced > qty_delivered
    negativeToInvoice: 0, // qty_to_invoice < 0
    missingInvoiceLines: 0
  };

  for (const { order, orderLines, orphanedPromoLines, problemLines } of overInvoicedOrders.slice(0, 10)) {
    console.log('=== Order: ' + order.name + ' ===');
    console.log('Total: EUR ' + order.amount_total);
    
    // Get invoices
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'name', 'move_type', 'amount_total', 'state']
    );
    
    console.log('\nInvoices:');
    for (const inv of invoices) {
      console.log('  ' + inv.name + ' (' + inv.move_type + '): EUR ' + inv.amount_total + ' [' + inv.state + ']');
    }

    console.log('\nOrder lines with issues:');
    for (const line of problemLines) {
      const name = (line.product_id ? line.product_id[1] : 'N/A').substring(0, 35);
      console.log('  ' + name);
      console.log('    qty=' + line.product_uom_qty + ', delivered=' + line.qty_delivered + ', invoiced=' + line.qty_invoiced + ', to_invoice=' + line.qty_to_invoice);
      console.log('    invoice_lines=' + JSON.stringify(line.invoice_lines));
      
      if (line.qty_invoiced > line.qty_delivered) {
        patterns.overInvoiced++;
        console.log('    ISSUE: Over-invoiced (invoiced > delivered)');
      }
      if (line.qty_to_invoice < 0) {
        patterns.negativeToInvoice++;
        console.log('    ISSUE: Negative qty_to_invoice');
      }
    }

    console.log('\nPromotion lines (missing):');
    for (const line of orphanedPromoLines) {
      console.log('  EUR ' + (line.price_subtotal || 0).toFixed(2));
    }
    console.log('');
  }

  console.log('=== PATTERN SUMMARY ===');
  console.log('Over-invoiced lines (invoiced > delivered): ' + patterns.overInvoiced);
  console.log('Negative qty_to_invoice: ' + patterns.negativeToInvoice);
  console.log('\nTotal orders with these issues: ' + overInvoicedOrders.length);
}

main().catch(e => console.error(e));
