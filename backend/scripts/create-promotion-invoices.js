require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '10');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== CREATE PROMOTION DISCOUNT CREDIT NOTES ===');
  console.log('This creates credit notes for promotion discounts to reduce turnover and mark orders as invoiced.');
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
    ['id', 'name', 'invoice_ids', 'partner_id', 'partner_invoice_id', 'pricelist_id', 'fiscal_position_id'],
    { limit: 2000, order: 'date_order asc' }
  );

  let processed = 0;
  let created = 0;
  let errors = 0;

  for (const order of orders) {
    if (processed >= limit) break;

    // Get order lines
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'product_id', 'qty_to_invoice', 'invoice_lines', 'price_unit', 'product_uom_qty', 'price_subtotal', 'tax_id']
    );

    // Find orphaned promotion lines (product 16404)
    const orphanedPromoLines = orderLines.filter(l => 
      l.qty_to_invoice > 0 && 
      (!l.invoice_lines || l.invoice_lines.length === 0) &&
      l.product_id && l.product_id[0] === 16404
    );

    if (orphanedPromoLines.length === 0) continue;

    // Check that ALL orphaned lines are promotions (no other products missing)
    const allOrphanedLines = orderLines.filter(l => 
      l.qty_to_invoice > 0 && (!l.invoice_lines || l.invoice_lines.length === 0)
    );
    const allArePromotions = allOrphanedLines.every(l => l.product_id && l.product_id[0] === 16404);
    
    if (!allArePromotions) continue; // Skip orders with other missing products

    // Get the existing invoice to copy journal/fiscal position
    const existingInvoice = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids], ['move_type', '=', 'out_invoice']],
      ['journal_id', 'fiscal_position_id', 'currency_id']
    );
    
    if (existingInvoice.length === 0) continue;
    const refInvoice = existingInvoice[0];

    const totalPromoAmount = orphanedPromoLines.reduce((sum, l) => sum + (l.price_subtotal || 0), 0);

    console.log('Order: ' + order.name);
    console.log('  Promotion lines to invoice: ' + orphanedPromoLines.length);
    console.log('  Total amount: EUR ' + totalPromoAmount.toFixed(2));

    if (!dryRun) {
      try {
        // Get partner info
        const partnerId = order.partner_invoice_id ? order.partner_invoice_id[0] : order.partner_id[0];

        console.log('  Creating invoice...');
        console.log('    Partner ID: ' + partnerId);
        console.log('    Journal ID: ' + refInvoice.journal_id[0]);

        // Create credit note lines data (reverse the sign for credit notes)
        // Credit notes use positive quantities/prices to REDUCE the invoice amount
        const invoiceLineData = orphanedPromoLines.map(line => [0, 0, {
          product_id: line.product_id[0],
          quantity: line.product_uom_qty,
          price_unit: Math.abs(line.price_unit),  // Make positive for credit note
          tax_ids: line.tax_id && line.tax_id.length > 0 ? [[6, 0, line.tax_id]] : [[6, 0, []]],
          sale_line_ids: [[4, line.id]]  // Link to order line
        }]);

        console.log('    Credit note lines: ' + invoiceLineData.length);

        // Create credit note (out_refund) instead of invoice
        const invoiceData = {
          move_type: 'out_refund',  // Credit note
          partner_id: partnerId,
          journal_id: refInvoice.journal_id[0],
          invoice_origin: order.name,
          invoice_date: new Date().toISOString().split('T')[0],
          invoice_line_ids: invoiceLineData
        };

        // Add optional fields only if they exist
        if (refInvoice.currency_id) {
          invoiceData.currency_id = refInvoice.currency_id[0];
        }
        if (refInvoice.fiscal_position_id) {
          invoiceData.fiscal_position_id = refInvoice.fiscal_position_id[0];
        }

        const invoiceId = await odoo.execute('account.move', 'create', [invoiceData]);
        console.log('  Created invoice ID: ' + invoiceId);

        // Post the invoice
        console.log('  Posting invoice...');
        await odoo.execute('account.move', 'action_post', [[invoiceId]]);
        console.log('  Invoice posted!');

        created++;
      } catch (err) {
        console.log('  ERROR: ' + err.message);
        if (err.stack) console.log('  Stack: ' + err.stack.split('\n')[1]);
        errors++;
      }
    } else {
      console.log('  [DRY RUN - would create invoice]');
      created++;
    }

    processed++;
    console.log('');
  }

  console.log('=== SUMMARY ===');
  console.log('Orders processed: ' + processed);
  console.log('Invoices created: ' + created);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to actually create invoices.');
  }
}

main().catch(e => console.error(e));
