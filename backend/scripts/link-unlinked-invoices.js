require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '2000');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== LINK UNLINKED INVOICES TO UNDER-INVOICED ORDERS ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Get under-invoiced orders
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_ids'],
    { limit: limit, order: 'date_order asc' }
  );

  console.log('Found ' + orders.length + ' orders with invoices but "to invoice" status\n');

  let fixed = 0;
  let partiallyFixed = 0;
  let notFixable = 0;
  let errors = 0;
  let processed = 0;

  for (const order of orders) {
    processed++;
    if (processed % 100 === 0) {
      console.log('Progress: ' + processed + '/' + orders.length + ' (fixed: ' + fixed + ')');
    }

    try {
      await sleep(50); // Avoid rate limiting

      // Get currently linked invoices
      const linkedInvoices = await odoo.searchRead('account.move',
        [['id', 'in', order.invoice_ids]],
        ['id', 'move_type', 'state', 'amount_total']
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

      // Extract Amazon order ID (remove FBA/FBM prefix)
      const amazonId = order.name.replace(/^FBA|^FBM/, '');

      // Search for unlinked invoices matching this Amazon ID
      const allMatchingInvoices = await odoo.searchRead('account.move',
        [
          ['move_type', 'in', ['out_invoice', 'out_refund']],
          ['state', '=', 'posted'],
          '|',
          ['ref', 'like', '%' + amazonId + '%'],
          ['name', 'like', '%' + amazonId + '%']
        ],
        ['id', 'name', 'amount_total', 'move_type'],
        { limit: 20 }
      );

      // Find invoices that aren't already linked
      const linkedIds = new Set(order.invoice_ids);
      const unlinkedInvoices = allMatchingInvoices.filter(inv => !linkedIds.has(inv.id));

      if (unlinkedInvoices.length === 0) {
        notFixable++;
        continue;
      }

      // Calculate what linking would achieve
      let potentialAmount = 0;
      for (const inv of unlinkedInvoices) {
        potentialAmount += inv.move_type === 'out_invoice' ? inv.amount_total : -inv.amount_total;
      }

      const afterLinking = currentNetInvoiced + potentialAmount;
      const wouldFix = Math.abs(afterLinking - order.amount_total) < 1;

      if (!dryRun) {
        // Link the invoices to the order
        const newInvoiceIds = [...order.invoice_ids, ...unlinkedInvoices.map(inv => inv.id)];
        await odoo.execute('sale.order', 'write', [[order.id], { invoice_ids: [[6, 0, newInvoiceIds]] }]);

        if (wouldFix) {
          // Also mark order lines as invoiced
          const lines = await odoo.searchRead('sale.order.line',
            [['order_id', '=', order.id]],
            ['id', 'invoice_status']
          );
          const linesToFix = lines.filter(l => l.invoice_status !== 'invoiced');
          if (linesToFix.length > 0) {
            const lineIds = linesToFix.map(l => l.id);
            await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
          }
          fixed++;
          if (fixed <= 30 || fixed % 50 === 0) {
            console.log(order.name + ': FIXED - linked ' + unlinkedInvoices.length + ' invoices');
          }
        } else {
          partiallyFixed++;
          if (partiallyFixed <= 10) {
            console.log(order.name + ': PARTIAL - linked ' + unlinkedInvoices.length + ' invoices (still missing EUR ' + (order.amount_total - afterLinking).toFixed(2) + ')');
          }
        }
      } else {
        if (wouldFix) {
          fixed++;
          if (fixed <= 30) {
            console.log(order.name + ': [DRY RUN] would link ' + unlinkedInvoices.length + ' invoices and mark as invoiced');
          }
        } else {
          partiallyFixed++;
          if (partiallyFixed <= 10) {
            console.log(order.name + ': [DRY RUN] would link ' + unlinkedInvoices.length + ' invoices (partial fix, still missing EUR ' + (order.amount_total - afterLinking).toFixed(2) + ')');
          }
        }
      }
    } catch (err) {
      errors++;
      if (errors <= 10) {
        console.log(order.name + ': ERROR - ' + err.message);
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Orders analyzed: ' + orders.length);
  console.log('Orders FULLY fixed: ' + fixed);
  console.log('Orders PARTIALLY fixed: ' + partiallyFixed);
  console.log('Orders not fixable (no matching invoices): ' + notFixable);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to fix.');
  }
}

main().catch(e => console.error(e));
