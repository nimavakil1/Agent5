require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== INVESTIGATING ORDERS WITH INVOICES BUT STILL "TO INVOICE" ===\n');

  // Find orders with invoices linked but still "to invoice"
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

  console.log('Total orders to analyze: ' + orders.length + '\n');

  // Categories
  const categories = {
    onlyCreditNotes: [],        // Only has credit notes, no regular invoices
    promotionOnly: [],          // Only promotion lines missing
    overInvoiced: [],           // Product lines over-invoiced
    underInvoiced: [],          // Product lines under-invoiced (qty_invoiced < qty_delivered)
    missingProducts: [],        // Product lines with no invoice line for that product
    draftInvoices: [],          // Has draft invoices
    mixedIssues: [],            // Multiple issues
    unknown: []                 // Can't categorize
  };

  let processed = 0;

  for (const order of orders) {
    processed++;
    if (processed % 200 === 0) {
      console.log('Processed ' + processed + '/' + orders.length + '...');
    }

    // Get order lines
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'product_id', 'qty_to_invoice', 'invoice_lines', 'invoice_status', 'qty_invoiced', 'qty_delivered', 'product_uom_qty']
    );

    // Get invoices
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'move_type', 'state']
    );

    const regularInvoices = invoices.filter(i => i.move_type === 'out_invoice');
    const creditNotes = invoices.filter(i => i.move_type === 'out_refund');
    const draftInvoices = invoices.filter(i => i.state === 'draft');

    // Analyze issues
    const issues = [];

    // Check for only credit notes
    if (regularInvoices.length === 0 && creditNotes.length > 0) {
      issues.push('onlyCreditNotes');
    }

    // Check for draft invoices
    if (draftInvoices.length > 0) {
      issues.push('draftInvoices');
    }

    // Analyze order lines
    const productLines = orderLines.filter(l => 
      l.product_id && ![16404, 16401, 16402, 16403].includes(l.product_id[0]) // Exclude promotion/shipping products
    );
    const promoLines = orderLines.filter(l => 
      l.product_id && l.product_id[0] === 16404
    );

    // Check promotion lines
    const orphanedPromoLines = promoLines.filter(l => 
      l.qty_to_invoice > 0 && l.invoice_status !== 'invoiced'
    );
    if (orphanedPromoLines.length > 0 && productLines.every(l => l.invoice_status === 'invoiced')) {
      issues.push('promotionOnly');
    }

    // Check product lines
    for (const line of productLines) {
      if (line.qty_invoiced > line.qty_delivered && line.qty_delivered > 0) {
        if (!issues.includes('overInvoiced')) issues.push('overInvoiced');
      }
      if (line.qty_invoiced < line.qty_delivered && line.qty_to_invoice > 0) {
        if (!issues.includes('underInvoiced')) issues.push('underInvoiced');
      }
      if (line.qty_to_invoice > 0 && (!line.invoice_lines || line.invoice_lines.length === 0)) {
        if (!issues.includes('missingProducts')) issues.push('missingProducts');
      }
    }

    // Categorize
    if (issues.length === 0) {
      categories.unknown.push({ order, orderLines, invoices });
    } else if (issues.length === 1) {
      categories[issues[0]].push({ order, orderLines, invoices });
    } else {
      categories.mixedIssues.push({ order, orderLines, invoices, issues });
    }
  }

  console.log('\n=== CATEGORY BREAKDOWN ===\n');
  console.log('Only credit notes (no regular invoice): ' + categories.onlyCreditNotes.length);
  console.log('Only promotion lines missing: ' + categories.promotionOnly.length);
  console.log('Over-invoiced product lines: ' + categories.overInvoiced.length);
  console.log('Under-invoiced product lines: ' + categories.underInvoiced.length);
  console.log('Missing invoice lines for products: ' + categories.missingProducts.length);
  console.log('Has draft invoices: ' + categories.draftInvoices.length);
  console.log('Mixed issues: ' + categories.mixedIssues.length);
  console.log('Unknown/Other: ' + categories.unknown.length);

  // Show examples of each category
  for (const [category, items] of Object.entries(categories)) {
    if (items.length > 0 && items.length <= 5) {
      console.log('\n--- ' + category.toUpperCase() + ' Examples ---');
      for (const item of items.slice(0, 3)) {
        console.log('  ' + item.order.name);
      }
    } else if (items.length > 5) {
      console.log('\n--- ' + category.toUpperCase() + ' Examples (first 3 of ' + items.length + ') ---');
      for (const item of items.slice(0, 3)) {
        console.log('  ' + item.order.name);
        if (item.issues) console.log('    Issues: ' + item.issues.join(', '));
      }
    }
  }

  // Detailed analysis of unknown category
  if (categories.unknown.length > 0) {
    console.log('\n=== ANALYZING UNKNOWN CATEGORY ===');
    for (const item of categories.unknown.slice(0, 5)) {
      console.log('\nOrder: ' + item.order.name);
      console.log('  Invoices: ' + item.invoices.map(i => i.move_type + '/' + i.state).join(', '));
      for (const line of item.orderLines.slice(0, 4)) {
        const name = (line.product_id ? line.product_id[1] : 'N/A').substring(0, 25);
        console.log('  Line: ' + name);
        console.log('    qty=' + line.product_uom_qty + ', delivered=' + line.qty_delivered + ', invoiced=' + line.qty_invoiced + ', to_inv=' + line.qty_to_invoice);
        console.log('    status=' + line.invoice_status + ', inv_lines=' + (line.invoice_lines || []).length);
      }
    }
  }
}

main().catch(e => console.error(e));
