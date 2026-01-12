require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== DETAILED ANALYSIS OF UNDER-INVOICED ORDERS ===\n');

  // Get a sample of under-invoiced orders
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_ids', 'date_order', 'order_line'],
    { limit: 50, order: 'date_order asc' }
  );

  console.log('Analyzing first 50 orders with invoices but "to invoice" status...\n');

  let analyzed = 0;
  for (const order of orders) {
    // Get invoice details
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'name', 'move_type', 'state', 'amount_total', 'invoice_line_ids']
    );

    let totalInvoiced = 0;
    let totalCredited = 0;
    let hasPosted = false;

    for (const inv of invoices) {
      if (inv.state === 'posted') {
        hasPosted = true;
        if (inv.move_type === 'out_invoice') {
          totalInvoiced += inv.amount_total;
        } else if (inv.move_type === 'out_refund') {
          totalCredited += inv.amount_total;
        }
      }
    }

    const netInvoiced = totalInvoiced - totalCredited;
    const diff = netInvoiced - order.amount_total;

    // Only analyze under-invoiced orders
    if (!hasPosted || diff >= -1) continue;

    analyzed++;
    if (analyzed > 10) break; // Only show 10 detailed examples

    console.log('='.repeat(70));
    console.log('ORDER: ' + order.name + ' (ID: ' + order.id + ')');
    console.log('Date: ' + (order.date_order ? order.date_order.substring(0, 10) : ''));
    console.log('Order Total: EUR ' + order.amount_total.toFixed(2));
    console.log('Net Invoiced: EUR ' + netInvoiced.toFixed(2));
    console.log('MISSING: EUR ' + Math.abs(diff).toFixed(2));
    console.log('');

    // Get order lines
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'name', 'product_id', 'product_uom_qty', 'price_unit', 'price_subtotal', 'invoice_status', 'invoice_lines']
    );

    console.log('ORDER LINES (' + orderLines.length + '):');
    for (const line of orderLines) {
      const productName = line.product_id ? line.product_id[1] : 'No product';
      const invoiceLineCount = line.invoice_lines ? line.invoice_lines.length : 0;
      console.log('  - ' + productName.substring(0, 40).padEnd(40) +
        ' | Qty: ' + line.product_uom_qty +
        ' | EUR ' + line.price_subtotal.toFixed(2).padStart(8) +
        ' | Status: ' + line.invoice_status.padEnd(10) +
        ' | Invoice Lines: ' + invoiceLineCount);
    }
    console.log('');

    console.log('LINKED INVOICES (' + invoices.length + '):');
    for (const inv of invoices) {
      console.log('  - ' + inv.name +
        ' | Type: ' + inv.move_type +
        ' | State: ' + inv.state +
        ' | EUR ' + inv.amount_total.toFixed(2));

      // Get invoice lines for this invoice
      if (inv.invoice_line_ids && inv.invoice_line_ids.length > 0) {
        const invLines = await odoo.searchRead('account.move.line',
          [['id', 'in', inv.invoice_line_ids], ['display_type', '=', false]],
          ['id', 'name', 'product_id', 'quantity', 'price_unit', 'price_subtotal']
        );

        for (const invLine of invLines) {
          if (invLine.price_subtotal !== 0) {
            const prodName = invLine.product_id ? invLine.product_id[1] : invLine.name;
            console.log('      ' + (prodName || '').substring(0, 35).padEnd(35) +
              ' | Qty: ' + invLine.quantity +
              ' | EUR ' + invLine.price_subtotal.toFixed(2));
          }
        }
      }
    }
    console.log('');
  }

  // Now check if there are unlinked invoices that might match these orders
  console.log('\n=== CHECKING FOR UNLINKED INVOICES ===\n');

  // Get a sample of Amazon invoices that might not be linked to orders
  const sampleOrderNames = orders.slice(0, 20).map(o => o.name.replace(/^FBA|^FBM/, ''));

  for (const amazonId of sampleOrderNames.slice(0, 5)) {
    // Search for invoices containing this Amazon ID in their name or reference
    const matchingInvoices = await odoo.searchRead('account.move',
      [
        ['move_type', 'in', ['out_invoice', 'out_refund']],
        '|',
        ['name', 'like', '%' + amazonId + '%'],
        ['ref', 'like', '%' + amazonId + '%']
      ],
      ['id', 'name', 'ref', 'state', 'amount_total'],
      { limit: 5 }
    );

    if (matchingInvoices.length > 0) {
      console.log('Amazon ID ' + amazonId + ':');
      for (const inv of matchingInvoices) {
        console.log('  Found: ' + inv.name + ' (ref: ' + (inv.ref || '') + ') - EUR ' + inv.amount_total.toFixed(2) + ' [' + inv.state + ']');
      }
    }
  }
}

main().catch(e => console.error(e));
