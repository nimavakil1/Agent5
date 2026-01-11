require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Analyzing duplicate Amazon orders in Odoo...\n');

  // Get all FBA/FBM orders
  const orders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'client_order_ref', 'date_order', 'amount_total', 'invoice_status', 'state', 'invoice_ids', 'partner_id'],
    { limit: 50000, order: 'name asc' }
  );

  console.log('Total FBA/FBM orders: ' + orders.length);

  // Group by order name
  const ordersByName = {};
  for (const order of orders) {
    if (!ordersByName[order.name]) {
      ordersByName[order.name] = [];
    }
    ordersByName[order.name].push(order);
  }

  // Find duplicates
  const duplicates = [];
  for (const [name, orderList] of Object.entries(ordersByName)) {
    if (orderList.length > 1) {
      duplicates.push({
        name,
        count: orderList.length,
        orders: orderList
      });
    }
  }

  console.log('Duplicate order groups: ' + duplicates.length + '\n');

  // Build CSV data
  const csvRows = [];
  let processed = 0;

  for (const dup of duplicates) {
    processed++;
    if (processed % 50 === 0) console.log('Processing ' + processed + '/' + duplicates.length);

    // Calculate totals for this Amazon order
    const totalOrderAmount = dup.orders.reduce((sum, o) => sum + o.amount_total, 0);
    const hasToInvoice = dup.orders.some(o => o.invoice_status === 'to invoice');
    const allInvoiced = dup.orders.every(o => o.invoice_status === 'invoiced');

    // Get all invoice IDs
    const allInvoiceIds = [];
    for (const o of dup.orders) {
      allInvoiceIds.push(...o.invoice_ids);
    }
    const uniqueInvoiceIds = [...new Set(allInvoiceIds)];

    // Get invoice details if any
    let totalInvoiced = 0;
    let totalCredited = 0;
    if (uniqueInvoiceIds.length > 0) {
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', uniqueInvoiceIds]],
        ['id', 'move_type', 'state', 'amount_total']
      );
      for (const inv of invoices) {
        if (inv.state === 'posted' || inv.state === 'draft') {
          if (inv.move_type === 'out_invoice') {
            totalInvoiced += inv.amount_total;
          } else if (inv.move_type === 'out_refund') {
            totalCredited += inv.amount_total;
          }
        }
      }
    }

    const netInvoiced = totalInvoiced - totalCredited;
    const invoiceDiff = netInvoiced - totalOrderAmount;

    // Determine status
    let status = '';
    if (allInvoiced) {
      status = 'ALL_INVOICED';
    } else if (hasToInvoice && uniqueInvoiceIds.length > 0) {
      status = 'PARTIAL_INVOICE';
    } else if (hasToInvoice && uniqueInvoiceIds.length === 0) {
      status = 'NO_INVOICE';
    } else {
      status = 'OTHER';
    }

    // Add row for each Odoo order in the group
    for (const o of dup.orders) {
      const customerName = o.partner_id ? o.partner_id[1].replace(/,/g, ' ').replace(/"/g, "'") : '';
      csvRows.push({
        amazonOrder: dup.name,
        duplicateCount: dup.count,
        odooId: o.id,
        odooAmount: o.amount_total.toFixed(2),
        invoiceStatus: o.invoice_status,
        state: o.state,
        invoiceCount: o.invoice_ids.length,
        customer: customerName,
        groupTotalOrder: totalOrderAmount.toFixed(2),
        groupTotalInvoiced: totalInvoiced.toFixed(2),
        groupTotalCredited: totalCredited.toFixed(2),
        groupNetInvoiced: netInvoiced.toFixed(2),
        groupInvoiceDiff: invoiceDiff.toFixed(2),
        groupStatus: status
      });
    }
  }

  // Sort by status (PARTIAL_INVOICE first), then by amazon order
  csvRows.sort((a, b) => {
    const statusOrder = { 'PARTIAL_INVOICE': 0, 'NO_INVOICE': 1, 'OTHER': 2, 'ALL_INVOICED': 3 };
    if (statusOrder[a.groupStatus] !== statusOrder[b.groupStatus]) {
      return statusOrder[a.groupStatus] - statusOrder[b.groupStatus];
    }
    return a.amazonOrder.localeCompare(b.amazonOrder);
  });

  // Write CSV
  const header = 'Amazon Order,Duplicate Count,Odoo ID,Odoo Amount,Invoice Status,State,Invoice Count,Customer,Group Total Order,Group Total Invoiced,Group Total Credited,Group Net Invoiced,Group Invoice Diff,Group Status';
  const csv = header + '\n' + csvRows.map(r =>
    [
      r.amazonOrder,
      r.duplicateCount,
      r.odooId,
      r.odooAmount,
      r.invoiceStatus,
      r.state,
      r.invoiceCount,
      '"' + r.customer + '"',
      r.groupTotalOrder,
      r.groupTotalInvoiced,
      r.groupTotalCredited,
      r.groupNetInvoiced,
      r.groupInvoiceDiff,
      r.groupStatus
    ].join(',')
  ).join('\n');

  fs.writeFileSync('/Users/nimavakil/Downloads/DUPLICATE_ORDERS.csv', csv);

  // Summary
  const statusCounts = {};
  const uniqueAmazonOrders = new Set();
  for (const r of csvRows) {
    if (!uniqueAmazonOrders.has(r.amazonOrder)) {
      uniqueAmazonOrders.add(r.amazonOrder);
      statusCounts[r.groupStatus] = (statusCounts[r.groupStatus] || 0) + 1;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Unique Amazon orders with duplicates: ' + uniqueAmazonOrders.size);
  console.log('Total Odoo orders in CSV: ' + csvRows.length);
  console.log('\nBy status:');
  for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + status + ': ' + count);
  }
  console.log('\nFile saved to ~/Downloads/DUPLICATE_ORDERS.csv');
}

main().catch(e => console.error(e));
