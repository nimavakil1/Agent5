require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== INVESTIGATING "OTHER" TO INVOICE ORDERS ===\n');

  // Get orders with invoices but not in over-invoiced/orphaned categories
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'date_order', 'amount_total', 'invoice_ids'],
    { limit: 500, order: 'date_order asc' }
  );

  let otherCases = [];

  for (const order of orders) {
    const lines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines']
    );

    // Check for over-invoiced and orphaned
    let hasOverInvoiced = lines.some(l => l.qty_invoiced > l.qty_delivered && l.qty_delivered > 0);
    let hasOrphaned = lines.some(l => l.qty_to_invoice > 0 && (!l.invoice_lines || l.invoice_lines.length === 0));

    // Check invoice states
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['state', 'amount_total']
    );
    const allDraft = invoices.every(inv => inv.state === 'draft');

    // If not over-invoiced, not orphaned, not all draft - it's "other"
    if (!hasOverInvoiced && !hasOrphaned && !allDraft) {
      otherCases.push({ order, lines, invoices });
      if (otherCases.length >= 20) break;
    }
  }

  console.log('Found ' + otherCases.length + ' "other" cases to analyze\n');

  // Analyze patterns
  for (const c of otherCases.slice(0, 10)) {
    console.log('Order: ' + c.order.name + ' | EUR ' + (c.order.amount_total || 0).toFixed(2));
    
    let totalDelivered = 0;
    let totalInvoiced = 0;
    let totalToInvoice = 0;
    
    for (const line of c.lines) {
      totalDelivered += line.qty_delivered || 0;
      totalInvoiced += line.qty_invoiced || 0;
      totalToInvoice += line.qty_to_invoice || 0;
      console.log('  Line: delivered=' + line.qty_delivered + ', invoiced=' + line.qty_invoiced + ', to_invoice=' + line.qty_to_invoice + ', inv_lines=' + (line.invoice_lines || []).length);
    }
    
    let totalInvAmount = 0;
    for (const inv of c.invoices) {
      totalInvAmount += inv.amount_total || 0;
      console.log('  Invoice: ' + inv.state + ' EUR ' + inv.amount_total);
    }
    
    console.log('  TOTALS: delivered=' + totalDelivered + ', invoiced=' + totalInvoiced + ', to_invoice=' + totalToInvoice);
    console.log('  Invoice total: EUR ' + totalInvAmount.toFixed(2) + ' vs Order: EUR ' + (c.order.amount_total || 0).toFixed(2));
    
    // Diagnose
    if (totalToInvoice > 0 && totalInvoiced > 0) {
      console.log('  DIAGNOSIS: Partial invoicing - some qty still to invoice');
    } else if (totalToInvoice === 0) {
      console.log('  DIAGNOSIS: All qty invoiced but status not updated?');
    }
    console.log('');
  }
}

main().catch(e => console.error(e));
