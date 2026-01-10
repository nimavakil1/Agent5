require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== INVESTIGATING PROMOTION-ONLY ORDERS ===\n');

  // Find orders with orphaned lines
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

  let promotionOnlyOrders = [];
  let totalPromotionAmount = 0;

  for (const order of orders) {
    // Get order lines
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'product_id', 'qty_to_invoice', 'invoice_lines', 'price_unit', 'product_uom_qty', 'price_subtotal']
    );

    // Find orphaned lines (qty_to_invoice > 0 AND no invoice_lines)
    const orphanedLines = orderLines.filter(l => 
      l.qty_to_invoice > 0 && (!l.invoice_lines || l.invoice_lines.length === 0)
    );

    if (orphanedLines.length === 0) continue;

    // Get regular invoices
    const regularInvoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids], ['move_type', '=', 'out_invoice']],
      ['id']
    );
    if (regularInvoices.length === 0) continue;

    // Get invoice lines products
    const invLines = await odoo.searchRead('account.move.line',
      [
        ['move_id', 'in', regularInvoices.map(i => i.id)],
        ['display_type', '=', 'product']
      ],
      ['product_id']
    );
    const invoiceProductIds = new Set(invLines.map(il => il.product_id ? il.product_id[0] : 0));

    // Check if ALL orphaned lines have products NOT in invoice (meaning truly missing)
    // AND all those products are the promotion product (16404)
    let allPromotionMissing = true;
    for (const line of orphanedLines) {
      const productId = line.product_id ? line.product_id[0] : 0;
      if (!invoiceProductIds.has(productId)) {
        // Product is missing from invoice
        if (productId !== 16404) {
          allPromotionMissing = false;
          break;
        }
      }
    }

    if (allPromotionMissing) {
      const promoAmount = orphanedLines
        .filter(l => l.product_id && l.product_id[0] === 16404)
        .reduce((sum, l) => sum + (l.price_subtotal || 0), 0);
      
      totalPromotionAmount += promoAmount;
      promotionOnlyOrders.push({
        order,
        orphanedLines,
        allLines: orderLines,
        promoAmount
      });
    }
  }

  console.log('Found ' + promotionOnlyOrders.length + ' promotion-only orders\n');

  // Show first 5 examples
  for (const { order, orphanedLines, allLines, promoAmount } of promotionOnlyOrders.slice(0, 5)) {
    console.log('Order: ' + order.name + ' | Total: EUR ' + order.amount_total);
    
    // Show order lines
    console.log('  Order lines:');
    for (const line of allLines) {
      const productName = line.product_id ? line.product_id[1].substring(0, 50) : 'N/A';
      const isOrphaned = orphanedLines.some(ol => ol.id === line.id);
      const status = isOrphaned ? 'MISSING' : 'OK';
      console.log('    [' + status + '] ' + productName);
      console.log('           qty=' + line.product_uom_qty + ', price=' + line.price_unit + ', subtotal=EUR ' + (line.price_subtotal || 0).toFixed(2));
    }

    // Get invoice info
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'name', 'move_type', 'amount_total', 'state']
    );
    console.log('  Invoices:');
    for (const inv of invoices) {
      console.log('    ' + inv.name + ' (' + inv.move_type + '): EUR ' + inv.amount_total + ' [' + inv.state + ']');
    }
    console.log('  Promotion discount not invoiced: EUR ' + promoAmount.toFixed(2));
    console.log('');
  }

  console.log('=== SUMMARY ===');
  console.log('Total promotion-only orders: ' + promotionOnlyOrders.length);
  console.log('Total promotion amount not invoiced: EUR ' + totalPromotionAmount.toFixed(2));
  
  // Count by negative vs positive
  const negativePromo = promotionOnlyOrders.filter(p => p.promoAmount < 0);
  const positivePromo = promotionOnlyOrders.filter(p => p.promoAmount > 0);
  const zeroPromo = promotionOnlyOrders.filter(p => p.promoAmount === 0);
  
  console.log('\nBreakdown:');
  console.log('  Negative amounts (discounts): ' + negativePromo.length + ' orders, EUR ' + negativePromo.reduce((s, p) => s + p.promoAmount, 0).toFixed(2));
  console.log('  Positive amounts: ' + positivePromo.length + ' orders, EUR ' + positivePromo.reduce((s, p) => s + p.promoAmount, 0).toFixed(2));
  console.log('  Zero amounts: ' + zeroPromo.length + ' orders');
}

main().catch(e => console.error(e));
