require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== ANALYZING UNLINKED LINE PATTERNS ===\n');

  // Get orders with invoices but still "to invoice"
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false]
    ],
    ['id', 'name', 'invoice_ids'],
    { limit: 100 }
  );

  let multiLineOrders = 0;
  let singleLineOrders = 0;
  let overInvoicedLines = 0;
  let underInvoicedLines = 0;
  let invoiceOriginMismatch = 0;

  for (const order of orders) {
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines']
    );

    if (orderLines.length > 1) {
      multiLineOrders++;
    } else {
      singleLineOrders++;
    }

    for (const line of orderLines) {
      if (line.qty_invoiced > line.qty_delivered) {
        overInvoicedLines++;
      }
      if (line.qty_to_invoice > 0) {
        underInvoicedLines++;
      }
    }

    // Check if invoice_origin matches order name
    if (order.invoice_ids && order.invoice_ids.length > 0) {
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', order.invoice_ids]],
        ['invoice_origin']
      );
      for (const inv of invoices) {
        // invoice_origin should contain the order name or Amazon order ID
        if (inv.invoice_origin && !inv.invoice_origin.includes(order.name.replace('FBA', '').replace('FBM', ''))) {
          invoiceOriginMismatch++;
        }
      }
    }
  }

  console.log('Orders analyzed: ' + orders.length);
  console.log('');
  console.log('Order line patterns:');
  console.log('  Multi-line orders: ' + multiLineOrders);
  console.log('  Single-line orders: ' + singleLineOrders);
  console.log('');
  console.log('Line issues:');
  console.log('  Over-invoiced lines (qty_invoiced > qty_delivered): ' + overInvoicedLines);
  console.log('  Under-invoiced lines (qty_to_invoice > 0): ' + underInvoicedLines);
  console.log('');
  console.log('Invoice origin mismatches: ' + invoiceOriginMismatch);

  // Now check the "no invoice at all" scenario - check VCS data in MongoDB
  console.log('\n\n=== SCENARIO 1: ORDERS WITH NO INVOICE ===\n');
  
  const noInvoiceOrders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['name', 'like', 'FBA%'],
      ['invoice_ids', '=', false]
    ],
    ['id', 'name', 'date_order'],
    { limit: 20, order: 'date_order asc' }
  );

  console.log('Oldest FBA orders with NO invoice:');
  for (const order of noInvoiceOrders) {
    // Extract Amazon order ID from FBA order name
    const amazonOrderId = order.name.replace('FBA', '');
    console.log(order.name + ' | Amazon ID: ' + amazonOrderId + ' | Date: ' + (order.date_order || '').substring(0, 10));
  }

  console.log('\nThese Amazon Order IDs should be checked against VCS data in unified_orders collection');
}

main().catch(e => console.error(e));
