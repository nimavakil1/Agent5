require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== FIX REMAINING DUPLICATE ORDER CASES ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE') + '\n');

  // Get ALL orders
  const allOrders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_status', 'invoice_ids', 'partner_id'],
    { limit: 50000 }
  );

  // Group by name
  const byName = {};
  for (const o of allOrders) {
    if (!byName[o.name]) byName[o.name] = [];
    byName[o.name].push(o);
  }

  let amountsMatchFixed = 0;
  let overInvoicedFixed = 0;
  let creditNotesCreated = 0;
  let errors = 0;

  for (const [name, orders] of Object.entries(byName)) {
    if (orders.length <= 1) continue;
    if (!orders.some(o => o.invoice_status === 'to invoice')) continue;

    // Get all invoice IDs
    const invoiceIds = [...new Set(orders.flatMap(o => o.invoice_ids))];
    const totalOrder = orders.reduce((s, o) => s + o.amount_total, 0);

    let netInvoiced = 0;
    let journalId = 1;
    if (invoiceIds.length > 0) {
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', invoiceIds]],
        ['id', 'move_type', 'state', 'amount_total', 'journal_id']
      );
      for (const inv of invoices) {
        if (inv.state === 'posted' || inv.state === 'draft') {
          if (inv.move_type === 'out_invoice') {
            netInvoiced += inv.amount_total;
            journalId = inv.journal_id[0];
          } else if (inv.move_type === 'out_refund') {
            netInvoiced -= inv.amount_total;
          }
        }
      }
    }

    const diff = netInvoiced - totalOrder;

    // Case 1: Amounts match - just mark as invoiced
    if (Math.abs(diff) < 1 && invoiceIds.length > 0) {
      console.log(name + ': Amounts match (EUR ' + totalOrder.toFixed(2) + ' vs ' + netInvoiced.toFixed(2) + ')');

      if (!dryRun) {
        try {
          for (const order of orders) {
            if (order.invoice_status !== 'to invoice') continue;
            const lines = await odoo.searchRead('sale.order.line',
              [['order_id', '=', order.id]],
              ['id']
            );
            const lineIds = lines.map(l => l.id);
            if (lineIds.length > 0) {
              await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
            }
          }
          console.log('  FIXED - marked all lines as invoiced');
          amountsMatchFixed++;
        } catch (err) {
          console.log('  ERROR: ' + err.message);
          errors++;
        }
      } else {
        console.log('  [DRY RUN] Would mark all lines as invoiced');
        amountsMatchFixed++;
      }
    }

    // Case 2: Over-invoiced - create credit note
    else if (diff > 1) {
      console.log(name + ': Over-invoiced by EUR ' + diff.toFixed(2));

      if (!dryRun) {
        try {
          // Create credit note
          const partnerId = orders[0].partner_id[0];
          const creditNoteId = await odoo.execute('account.move', 'create', [{
            move_type: 'out_refund',
            partner_id: partnerId,
            journal_id: journalId,
            invoice_date: new Date().toISOString().split('T')[0],
            ref: 'Correction for duplicate order ' + name,
            invoice_line_ids: [[0, 0, {
              name: 'Correction for over-invoicing',
              quantity: 1,
              price_unit: diff
            }]]
          }]);

          console.log('  Created credit note ID: ' + creditNoteId);
          creditNotesCreated++;

          // Link to orders and post
          for (const order of orders) {
            const currentIds = order.invoice_ids || [];
            if (!currentIds.includes(creditNoteId)) {
              currentIds.push(creditNoteId);
              await odoo.execute('sale.order', 'write', [[order.id], {
                invoice_ids: [[6, 0, currentIds]]
              }]);
            }
          }

          await odoo.execute('account.move', 'action_post', [[creditNoteId]]);
          console.log('  Posted credit note');

          // Mark all lines as invoiced
          for (const order of orders) {
            if (order.invoice_status !== 'to invoice') continue;
            const lines = await odoo.searchRead('sale.order.line',
              [['order_id', '=', order.id]],
              ['id']
            );
            const lineIds = lines.map(l => l.id);
            if (lineIds.length > 0) {
              await odoo.execute('sale.order.line', 'write', [lineIds, { invoice_status: 'invoiced' }]);
            }
          }
          console.log('  Marked all order lines as invoiced');
          overInvoicedFixed++;
        } catch (err) {
          console.log('  ERROR: ' + err.message);
          errors++;
        }
      } else {
        console.log('  [DRY RUN] Would create credit note for EUR ' + diff.toFixed(2));
        overInvoicedFixed++;
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Amounts match fixed: ' + amountsMatchFixed);
  console.log('Over-invoiced fixed: ' + overInvoicedFixed);
  console.log('Credit notes created: ' + creditNotesCreated);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to fix.');
  }
}

main().catch(e => console.error(e));
