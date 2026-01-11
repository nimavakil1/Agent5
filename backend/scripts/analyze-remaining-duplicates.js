require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Analyzing remaining duplicate orders with to invoice status...\n');

  // Get ALL orders
  const allOrders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_status', 'invoice_ids'],
    { limit: 50000 }
  );

  // Group by name
  const byName = {};
  for (const o of allOrders) {
    if (!byName[o.name]) byName[o.name] = [];
    byName[o.name].push(o);
  }

  // Find duplicates with to invoice
  const cases = { amountsMatch: 0, underInvoiced: 0, overInvoiced: 0, allNoInvoice: 0 };
  const details = [];

  let processed = 0;
  for (const [name, orders] of Object.entries(byName)) {
    if (orders.length <= 1) continue;
    if (!orders.some(o => o.invoice_status === 'to invoice')) continue;

    processed++;
    if (processed % 10 === 0) console.log('Processed: ' + processed);

    // Get all invoice IDs
    const invoiceIds = [...new Set(orders.flatMap(o => o.invoice_ids))];
    const totalOrder = orders.reduce((s, o) => s + o.amount_total, 0);

    let netInvoiced = 0;
    if (invoiceIds.length > 0) {
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', invoiceIds]],
        ['id', 'move_type', 'state', 'amount_total']
      );
      for (const inv of invoices) {
        if (inv.state === 'posted' || inv.state === 'draft') {
          if (inv.move_type === 'out_invoice') netInvoiced += inv.amount_total;
          else if (inv.move_type === 'out_refund') netInvoiced -= inv.amount_total;
        }
      }
    }

    const diff = netInvoiced - totalOrder;
    let caseType = '';
    if (invoiceIds.length === 0) {
      caseType = 'allNoInvoice';
      cases.allNoInvoice++;
    } else if (Math.abs(diff) < 1) {
      caseType = 'amountsMatch';
      cases.amountsMatch++;
    } else if (diff > 1) {
      caseType = 'overInvoiced';
      cases.overInvoiced++;
    } else {
      caseType = 'underInvoiced';
      cases.underInvoiced++;
    }

    details.push({ name, totalOrder, netInvoiced, diff: diff.toFixed(2), caseType, orderIds: orders.map(o => o.id) });
  }

  console.log('\n=== SUMMARY OF REMAINING DUPLICATE CASES ===\n');
  console.log('Total duplicate groups with "to invoice": ' + details.length);
  console.log('');
  console.log('Amounts match (can just mark as invoiced): ' + cases.amountsMatch);
  console.log('Under-invoiced (need more invoices): ' + cases.underInvoiced);
  console.log('Over-invoiced (need credit notes): ' + cases.overInvoiced);
  console.log('All no invoice: ' + cases.allNoInvoice);

  if (cases.amountsMatch > 0) {
    console.log('\n=== AMOUNTS MATCH CASES ===');
    for (const d of details.filter(d => d.caseType === 'amountsMatch').slice(0, 10)) {
      console.log(d.name + ': Order ' + d.totalOrder.toFixed(2) + ' vs Invoiced ' + d.netInvoiced.toFixed(2));
    }
  }

  if (cases.underInvoiced > 0) {
    console.log('\n=== UNDER-INVOICED CASES ===');
    for (const d of details.filter(d => d.caseType === 'underInvoiced').slice(0, 10)) {
      console.log(d.name + ': Order ' + d.totalOrder.toFixed(2) + ' vs Invoiced ' + d.netInvoiced.toFixed(2) + ' (diff: ' + d.diff + ')');
    }
  }

  if (cases.overInvoiced > 0) {
    console.log('\n=== OVER-INVOICED CASES ===');
    for (const d of details.filter(d => d.caseType === 'overInvoiced').slice(0, 10)) {
      console.log(d.name + ': Order ' + d.totalOrder.toFixed(2) + ' vs Invoiced ' + d.netInvoiced.toFixed(2) + ' (diff: +' + d.diff + ')');
    }
  }
}

main().catch(e => console.error(e));
