require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Analyzing orders with invoices but "to invoice" status...\n');

  // Get orders that are 'to invoice' but have invoices linked
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_ids', 'date_order', 'partner_id'],
    { limit: 3000, order: 'date_order asc' }
  );

  console.log('Found ' + orders.length + ' orders to analyze\n');

  const results = {
    amountsMatch: [],      // Net invoiced matches order total (within tolerance)
    underInvoiced: [],     // Net invoiced < order total
    overInvoiced: [],      // Net invoiced > order total
    noPostedInvoice: []    // Has invoice IDs but none are posted
  };

  let processed = 0;
  for (const order of orders) {
    processed++;
    if (processed % 200 === 0) console.log('Processed: ' + processed + '/' + orders.length);

    // Get invoice details
    const invoices = await odoo.searchRead('account.move',
      [['id', 'in', order.invoice_ids]],
      ['id', 'name', 'move_type', 'state', 'amount_total']
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

    const record = {
      orderName: order.name,
      orderId: order.id,
      orderDate: order.date_order ? order.date_order.substring(0, 10) : '',
      orderTotal: order.amount_total,
      netInvoiced: netInvoiced,
      diff: diff,
      invoiceCount: order.invoice_ids.length,
      customer: order.partner_id ? order.partner_id[1] : ''
    };

    if (!hasPosted) {
      results.noPostedInvoice.push(record);
    } else if (Math.abs(diff) < 1) {
      results.amountsMatch.push(record);
    } else if (diff > 1) {
      results.overInvoiced.push(record);
    } else {
      results.underInvoiced.push(record);
    }
  }

  // Summary
  console.log('\n=== ANALYSIS SUMMARY ===\n');
  console.log('Total analyzed: ' + orders.length);
  console.log('');
  console.log('1. AMOUNTS MATCH (safe to mark as invoiced): ' + results.amountsMatch.length);
  console.log('2. NO POSTED INVOICES (draft only): ' + results.noPostedInvoice.length);
  console.log('3. UNDER-INVOICED (missing invoice amount): ' + results.underInvoiced.length);
  console.log('4. OVER-INVOICED (too much invoiced): ' + results.overInvoiced.length);

  if (results.underInvoiced.length > 0) {
    const totalUnder = results.underInvoiced.reduce((s, r) => s + Math.abs(r.diff), 0);
    console.log('   Total under-invoiced: EUR ' + totalUnder.toFixed(2));
  }

  if (results.overInvoiced.length > 0) {
    const totalOver = results.overInvoiced.reduce((s, r) => s + r.diff, 0);
    console.log('   Total over-invoiced: EUR ' + totalOver.toFixed(2));
  }

  // Export to CSV for review
  const allRecords = [
    ...results.amountsMatch.map(r => ({ ...r, category: 'AMOUNTS_MATCH' })),
    ...results.noPostedInvoice.map(r => ({ ...r, category: 'NO_POSTED_INVOICE' })),
    ...results.underInvoiced.map(r => ({ ...r, category: 'UNDER_INVOICED' })),
    ...results.overInvoiced.map(r => ({ ...r, category: 'OVER_INVOICED' }))
  ];

  const header = 'Category,Order Name,Order ID,Order Date,Order Total,Net Invoiced,Difference,Invoice Count,Customer';
  const csv = header + '\n' + allRecords.map(r =>
    [
      r.category,
      r.orderName,
      r.orderId,
      r.orderDate,
      r.orderTotal.toFixed(2),
      r.netInvoiced.toFixed(2),
      r.diff.toFixed(2),
      r.invoiceCount,
      '"' + (r.customer || '').replace(/"/g, "'").replace(/,/g, ' ') + '"'
    ].join(',')
  ).join('\n');

  fs.writeFileSync('/Users/nimavakil/Downloads/ORDERS_WITH_INVOICE_DISCREPANCY.csv', csv);
  console.log('\nCSV exported to ~/Downloads/ORDERS_WITH_INVOICE_DISCREPANCY.csv');

  // Show examples
  console.log('\n=== EXAMPLES ===\n');

  if (results.underInvoiced.length > 0) {
    console.log('UNDER-INVOICED (first 5):');
    for (const r of results.underInvoiced.slice(0, 5)) {
      console.log('  ' + r.orderName + ': Order EUR ' + r.orderTotal.toFixed(2) + ' vs Invoiced EUR ' + r.netInvoiced.toFixed(2) + ' (diff: ' + r.diff.toFixed(2) + ')');
    }
  }

  if (results.overInvoiced.length > 0) {
    console.log('\nOVER-INVOICED (first 5):');
    for (const r of results.overInvoiced.slice(0, 5)) {
      console.log('  ' + r.orderName + ': Order EUR ' + r.orderTotal.toFixed(2) + ' vs Invoiced EUR ' + r.netInvoiced.toFixed(2) + ' (diff: +' + r.diff.toFixed(2) + ')');
    }
  }
}

main().catch(e => console.error(e));
