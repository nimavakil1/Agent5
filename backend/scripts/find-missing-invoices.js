require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FINDING MISSING/UNLINKED INVOICES FOR UNDER-INVOICED ORDERS ===\n');

  // Get sample of under-invoiced orders
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_ids'],
    { limit: 100, order: 'date_order asc' }
  );

  console.log('Checking ' + orders.length + ' orders for unlinked invoices...\n');

  let foundUnlinked = 0;
  let totalMissing = 0;
  let canBeFixed = 0;

  for (const order of orders) {
    await sleep(100); // Avoid rate limiting

    // Get currently linked invoices
    const linkedInvoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'name', 'move_type', 'state', 'amount_total']
    );

    let currentNetInvoiced = 0;
    for (const inv of linkedInvoices) {
      if (inv.state === 'posted') {
        if (inv.move_type === 'out_invoice') {
          currentNetInvoiced += inv.amount_total;
        } else if (inv.move_type === 'out_refund') {
          currentNetInvoiced -= inv.amount_total;
        }
      }
    }

    const missing = order.amount_total - currentNetInvoiced;
    if (missing < 1) continue; // Not under-invoiced

    totalMissing += missing;

    // Extract Amazon order ID (remove FBA/FBM prefix)
    const amazonId = order.name.replace(/^FBA|^FBM/, '');

    // Search for ALL invoices containing this Amazon ID
    const allMatchingInvoices = await odoo.searchRead('account.move',
      [
        ['move_type', 'in', ['out_invoice', 'out_refund']],
        ['state', '=', 'posted'],
        '|',
        ['ref', 'like', '%' + amazonId + '%'],
        ['name', 'like', '%' + amazonId + '%']
      ],
      ['id', 'name', 'ref', 'amount_total', 'move_type'],
      { limit: 20 }
    );

    // Find invoices that match but aren't linked
    const linkedIds = new Set(order.invoice_ids);
    const unlinkedInvoices = allMatchingInvoices.filter(inv => !linkedIds.has(inv.id));

    if (unlinkedInvoices.length > 0) {
      foundUnlinked++;
      let potentialAmount = 0;

      console.log('ORDER: ' + order.name + ' (ID: ' + order.id + ')');
      console.log('  Order Total: EUR ' + order.amount_total.toFixed(2));
      console.log('  Currently Invoiced: EUR ' + currentNetInvoiced.toFixed(2));
      console.log('  Missing: EUR ' + missing.toFixed(2));
      console.log('  UNLINKED INVOICES FOUND:');

      for (const inv of unlinkedInvoices) {
        const amount = inv.move_type === 'out_invoice' ? inv.amount_total : -inv.amount_total;
        potentialAmount += amount;
        console.log('    -> ' + inv.name + ' (ref: ' + (inv.ref || '') + ') EUR ' + inv.amount_total.toFixed(2));
      }

      // Check if linking these would fix the issue
      const afterLinking = currentNetInvoiced + potentialAmount;
      const wouldFix = Math.abs(afterLinking - order.amount_total) < 1;
      if (wouldFix) {
        console.log('  *** LINKING THESE WOULD FIX THE ORDER! ***');
        canBeFixed++;
      } else {
        console.log('  After linking: EUR ' + afterLinking.toFixed(2) + ' (still off by EUR ' + (order.amount_total - afterLinking).toFixed(2) + ')');
      }
      console.log('');
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Orders checked: ' + orders.length);
  console.log('Orders with unlinked invoices found: ' + foundUnlinked);
  console.log('Orders that can be FIXED by linking: ' + canBeFixed);
  console.log('Total missing amount in checked orders: EUR ' + totalMissing.toFixed(2));
}

main().catch(e => console.error(e));
