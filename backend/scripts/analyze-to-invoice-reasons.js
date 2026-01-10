require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== ANALYZING WHY ORDERS ARE "TO INVOICE" ===\n');

  // Get FBA orders that are "to invoice"
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['name', 'like', 'FBA%']
    ],
    ['id', 'name', 'date_order', 'amount_total', 'invoice_ids'],
    { limit: 200, order: 'date_order desc' }
  );

  console.log('Checking ' + orders.length + ' FBA orders...\n');

  let noInvoiceAtAll = 0;
  let hasInvoiceNotLinked = 0;
  let hasInvoiceDraft = 0;
  let hasInvoicePosted = 0;
  
  const noInvoiceSamples = [];
  const notLinkedSamples = [];

  for (const order of orders) {
    if (!order.invoice_ids || order.invoice_ids.length === 0) {
      // SCENARIO 1: No invoice linked at all
      noInvoiceAtAll++;
      if (noInvoiceSamples.length < 5) {
        noInvoiceSamples.push(order);
      }
    } else {
      // Has invoice(s) linked - check if order lines are connected
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', order.invoice_ids]],
        ['id', 'name', 'state', 'amount_total']
      );
      
      const hasPosted = invoices.some(inv => inv.state === 'posted');
      const hasDraft = invoices.some(inv => inv.state === 'draft');
      
      if (hasPosted) hasInvoicePosted++;
      if (hasDraft) hasInvoiceDraft++;

      // Check order lines - do they have sale_line_ids populated on invoice lines?
      const orderLines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', order.id]],
        ['id', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines']
      );

      const hasUnlinkedLines = orderLines.some(line => 
        line.qty_to_invoice > 0 && (!line.invoice_lines || line.invoice_lines.length === 0)
      );

      if (hasUnlinkedLines) {
        hasInvoiceNotLinked++;
        if (notLinkedSamples.length < 5) {
          notLinkedSamples.push({ order, invoices, orderLines });
        }
      }
    }
  }

  console.log('=== RESULTS ===\n');
  console.log('SCENARIO 1 - No invoice at all: ' + noInvoiceAtAll);
  console.log('SCENARIO 2 - Has invoice but lines not linked: ' + hasInvoiceNotLinked);
  console.log('');
  console.log('Additional info:');
  console.log('  Has posted invoice: ' + hasInvoicePosted);
  console.log('  Has draft invoice: ' + hasInvoiceDraft);

  console.log('\n=== SAMPLES - NO INVOICE AT ALL ===\n');
  for (const order of noInvoiceSamples) {
    console.log(order.name + ' | ' + (order.date_order || '').substring(0, 10) + ' | EUR ' + (order.amount_total || 0).toFixed(2));
  }

  console.log('\n=== SAMPLES - HAS INVOICE BUT LINES NOT LINKED ===\n');
  for (const sample of notLinkedSamples) {
    console.log(sample.order.name + ' | ' + (sample.order.date_order || '').substring(0, 10) + ' | EUR ' + (sample.order.amount_total || 0).toFixed(2));
    console.log('  Invoices: ' + sample.invoices.map(i => i.name + '(' + i.state + ')').join(', '));
    console.log('  Order lines with qty_to_invoice > 0:');
    for (const line of sample.orderLines.filter(l => l.qty_to_invoice > 0)) {
      console.log('    delivered: ' + line.qty_delivered + ', invoiced: ' + line.qty_invoiced + ', to_invoice: ' + line.qty_to_invoice + ', invoice_lines: ' + (line.invoice_lines || []).length);
    }
    console.log('');
  }
}

main().catch(e => console.error(e));
