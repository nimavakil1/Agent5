require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== COUNTING ORDERS WITH INVOICE LINKING ISSUES ===\n');

  // Get all Amazon orders "to invoice" that have invoices linked
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'date_order', 'amount_total', 'invoice_ids'],
    { limit: 5000, order: 'date_order asc' }
  );

  console.log('Amazon orders "to invoice" WITH invoices linked: ' + orders.length + '\n');
  console.log('Analyzing each order (this may take a while)...\n');

  let overInvoicedOrphaned = 0;  // Has over-invoiced + orphaned lines
  let onlyOrphaned = 0;          // Has orphaned lines but no over-invoiced
  let onlyOverInvoiced = 0;      // Has over-invoiced but no orphaned
  let draftInvoicesOnly = 0;     // Only has draft invoices
  let other = 0;

  const overInvoicedOrphanedExamples = [];
  const onlyOrphanedExamples = [];

  let processed = 0;
  for (const order of orders) {
    processed++;
    if (processed % 100 === 0) {
      process.stdout.write('Processed ' + processed + '/' + orders.length + '\r');
    }

    // Get order lines
    const lines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice', 'invoice_lines']
    );

    // Check for over-invoiced and orphaned lines
    let hasOverInvoiced = false;
    let hasOrphaned = false;

    for (const line of lines) {
      if (line.qty_invoiced > line.qty_delivered && line.qty_delivered > 0) {
        hasOverInvoiced = true;
      }
      if (line.qty_to_invoice > 0 && (!line.invoice_lines || line.invoice_lines.length === 0)) {
        hasOrphaned = true;
      }
    }

    // Check invoice states
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['state']
    );
    const allDraft = invoices.every(inv => inv.state === 'draft');

    if (allDraft) {
      draftInvoicesOnly++;
    } else if (hasOverInvoiced && hasOrphaned) {
      overInvoicedOrphaned++;
      if (overInvoicedOrphanedExamples.length < 10) {
        overInvoicedOrphanedExamples.push(order.name);
      }
    } else if (hasOrphaned) {
      onlyOrphaned++;
      if (onlyOrphanedExamples.length < 10) {
        onlyOrphanedExamples.push(order.name);
      }
    } else if (hasOverInvoiced) {
      onlyOverInvoiced++;
    } else {
      other++;
    }
  }

  console.log('\n\n=== RESULTS ===\n');
  console.log('Total analyzed: ' + orders.length);
  console.log('');
  console.log('ISSUE BREAKDOWN:');
  console.log('  Over-invoiced + Orphaned lines: ' + overInvoicedOrphaned + ' (' + Math.round(overInvoicedOrphaned/orders.length*100) + '%)');
  console.log('  Only Orphaned lines (no over-invoiced): ' + onlyOrphaned + ' (' + Math.round(onlyOrphaned/orders.length*100) + '%)');
  console.log('  Only Over-invoiced (no orphaned): ' + onlyOverInvoiced + ' (' + Math.round(onlyOverInvoiced/orders.length*100) + '%)');
  console.log('  Draft invoices only: ' + draftInvoicesOnly + ' (' + Math.round(draftInvoicesOnly/orders.length*100) + '%)');
  console.log('  Other/Unknown: ' + other + ' (' + Math.round(other/orders.length*100) + '%)');

  console.log('\n=== EXAMPLES: OVER-INVOICED + ORPHANED ===');
  console.log(overInvoicedOrphanedExamples.join(', '));

  console.log('\n=== EXAMPLES: ONLY ORPHANED ===');
  console.log(onlyOrphanedExamples.join(', '));

  // Now count orders WITHOUT invoices
  console.log('\n\n=== ORDERS WITHOUT ANY INVOICE ===\n');
  
  const noInvoiceCount = await odoo.execute('sale.order', 'search_count', [
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ]
  ]);

  console.log('Amazon orders "to invoice" WITHOUT any invoice: ' + noInvoiceCount);

  // Summary
  console.log('\n\n=== SUMMARY ===\n');
  console.log('Total Amazon "to invoice": ' + (orders.length + noInvoiceCount));
  console.log('  - With invoices (linking issues): ' + orders.length);
  console.log('  - Without any invoice: ' + noInvoiceCount);
}

main().catch(e => console.error(e));
