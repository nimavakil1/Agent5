require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== ANALYZING ORDERS WITH MISSING INVOICE LINES ===\n');

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

  console.log('Checking ' + orders.length + ' orders...\n');

  let linkable = 0;          // Can fix by linking
  let missingInvoiceLines = 0; // Invoice line missing for product
  let promotionOnly = 0;     // Only promotion/discount lines missing
  let noRegularInvoices = 0; // No regular invoices (only credit notes)

  const missingProductIds = {};

  for (const order of orders) {
    // Get order lines
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'product_id', 'qty_to_invoice', 'invoice_lines']
    );

    // Find orphaned lines
    const orphanedLines = orderLines.filter(l => 
      l.qty_to_invoice > 0 && (!l.invoice_lines || l.invoice_lines.length === 0)
    );

    if (orphanedLines.length === 0) continue;

    // Get regular invoices
    const regularInvoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids], ['move_type', '=', 'out_invoice']],
      ['id']
    );

    if (regularInvoices.length === 0) {
      noRegularInvoices++;
      continue;
    }

    // Get invoice lines
    const invLines = await odoo.searchRead('account.move.line',
      [
        ['move_id', 'in', regularInvoices.map(i => i.id)],
        ['display_type', '=', 'product']
      ],
      ['id', 'product_id']
    );

    const invoiceProductIds = new Set(invLines.map(il => il.product_id ? il.product_id[0] : 0));

    let canFix = false;
    let allPromotion = true;

    for (const line of orphanedLines) {
      const productId = line.product_id ? line.product_id[0] : 0;
      if (invoiceProductIds.has(productId)) {
        canFix = true;
      } else {
        missingProductIds[productId] = (missingProductIds[productId] || 0) + 1;
        // Check if it's not a promotion product
        if (productId !== 16404) {
          allPromotion = false;
        }
      }
    }

    if (canFix) {
      linkable++;
    } else if (allPromotion) {
      promotionOnly++;
    } else {
      missingInvoiceLines++;
    }
  }

  console.log('=== RESULTS ===');
  console.log('Orders that can be fixed by linking: ' + linkable);
  console.log('Orders with only promotion lines missing: ' + promotionOnly);
  console.log('Orders with missing invoice lines for real products: ' + missingInvoiceLines);
  console.log('Orders with no regular invoices (only credit notes): ' + noRegularInvoices);

  console.log('\n=== MOST COMMON MISSING PRODUCTS ===');
  const sorted = Object.entries(missingProductIds).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [productId, count] of sorted) {
    const products = await odoo.searchRead('product.product', [['id', '=', parseInt(productId)]], ['name', 'default_code']);
    const name = products[0] ? products[0].name : 'Unknown';
    const sku = products[0] ? products[0].default_code : '';
    console.log('  ' + productId + ': ' + count + 'x - ' + name + ' (' + sku + ')');
  }
}

main().catch(e => console.error(e));
