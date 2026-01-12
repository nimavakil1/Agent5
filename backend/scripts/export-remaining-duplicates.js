require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Exporting remaining under-invoiced duplicate orders...\n');

  // Get ALL orders
  const allOrders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_status', 'invoice_ids', 'partner_id', 'date_order'],
    { limit: 50000 }
  );

  console.log('Fetched ' + allOrders.length + ' orders');

  // Group by name
  const byName = {};
  for (const o of allOrders) {
    if (!byName[o.name]) byName[o.name] = [];
    byName[o.name].push(o);
  }

  const csvRows = [];
  let processed = 0;

  for (const [name, orders] of Object.entries(byName)) {
    if (orders.length <= 1) continue;
    if (!orders.some(o => o.invoice_status === 'to invoice')) continue;

    processed++;
    if (processed % 10 === 0) console.log('Processing: ' + processed);

    // Get all invoice IDs
    const invoiceIds = [...new Set(orders.flatMap(o => o.invoice_ids))];
    const totalOrder = orders.reduce((s, o) => s + o.amount_total, 0);

    let netInvoiced = 0;
    let invoiceDetails = [];
    if (invoiceIds.length > 0) {
      const invoices = await odoo.searchRead('account.move',
        [['id', 'in', invoiceIds]],
        ['id', 'name', 'move_type', 'state', 'amount_total', 'invoice_date']
      );
      for (const inv of invoices) {
        if (inv.state === 'posted' || inv.state === 'draft') {
          if (inv.move_type === 'out_invoice') {
            netInvoiced += inv.amount_total;
            invoiceDetails.push(inv.name + ' (+' + inv.amount_total.toFixed(2) + ')');
          } else if (inv.move_type === 'out_refund') {
            netInvoiced -= inv.amount_total;
            invoiceDetails.push(inv.name + ' (-' + inv.amount_total.toFixed(2) + ')');
          }
        }
      }
    }

    const diff = netInvoiced - totalOrder;

    // Only include under-invoiced cases (diff < -1)
    if (diff >= -1) continue;

    // Get order line details
    for (const order of orders) {
      const lines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', order.id]],
        ['id', 'product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'price_subtotal', 'invoice_status']
      );

      for (const line of lines) {
        const productName = line.product_id ? line.product_id[1].replace(/,/g, ' ').replace(/"/g, "'") : 'N/A';
        const customerName = order.partner_id ? order.partner_id[1].replace(/,/g, ' ').replace(/"/g, "'") : '';

        csvRows.push({
          amazonOrder: name,
          duplicateCount: orders.length,
          odooOrderId: order.id,
          orderDate: order.date_order ? order.date_order.substring(0, 10) : '',
          customer: customerName,
          orderAmount: order.amount_total.toFixed(2),
          orderInvoiceStatus: order.invoice_status,
          orderInvoiceCount: order.invoice_ids.length,
          groupTotalOrder: totalOrder.toFixed(2),
          groupNetInvoiced: netInvoiced.toFixed(2),
          groupUnderBy: Math.abs(diff).toFixed(2),
          invoices: invoiceDetails.join(' | '),
          lineProductId: line.product_id ? line.product_id[0] : '',
          lineProductName: productName,
          lineQtyOrdered: line.product_uom_qty,
          lineQtyDelivered: line.qty_delivered,
          lineQtyInvoiced: line.qty_invoiced,
          lineSubtotal: line.price_subtotal.toFixed(2),
          lineInvoiceStatus: line.invoice_status
        });
      }
    }
  }

  // Sort by amazon order name
  csvRows.sort((a, b) => a.amazonOrder.localeCompare(b.amazonOrder));

  // Write CSV
  const header = 'Amazon Order,Duplicate Count,Odoo Order ID,Order Date,Customer,Order Amount,Order Invoice Status,Order Invoice Count,Group Total Order,Group Net Invoiced,Group Under By,Invoices,Line Product ID,Line Product Name,Line Qty Ordered,Line Qty Delivered,Line Qty Invoiced,Line Subtotal,Line Invoice Status';
  const csv = header + '\n' + csvRows.map(r =>
    [
      r.amazonOrder,
      r.duplicateCount,
      r.odooOrderId,
      r.orderDate,
      '"' + r.customer + '"',
      r.orderAmount,
      r.orderInvoiceStatus,
      r.orderInvoiceCount,
      r.groupTotalOrder,
      r.groupNetInvoiced,
      r.groupUnderBy,
      '"' + r.invoices + '"',
      r.lineProductId,
      '"' + r.lineProductName + '"',
      r.lineQtyOrdered,
      r.lineQtyDelivered,
      r.lineQtyInvoiced,
      r.lineSubtotal,
      r.lineInvoiceStatus
    ].join(',')
  ).join('\n');

  fs.writeFileSync('/Users/nimavakil/Downloads/UNDER_INVOICED_DUPLICATES.csv', csv);

  // Summary
  const uniqueOrders = new Set(csvRows.map(r => r.amazonOrder));
  const totalUnder = csvRows.reduce((sum, r, i, arr) => {
    // Only count once per amazon order
    if (i === 0 || arr[i-1].amazonOrder !== r.amazonOrder) {
      return sum + parseFloat(r.groupUnderBy);
    }
    return sum;
  }, 0);

  console.log('\n=== EXPORT COMPLETE ===');
  console.log('Unique Amazon orders (under-invoiced): ' + uniqueOrders.size);
  console.log('Total rows in CSV: ' + csvRows.length);
  console.log('Total under-invoiced amount: EUR ' + totalUnder.toFixed(2));
  console.log('\nFile saved to ~/Downloads/UNDER_INVOICED_DUPLICATES.csv');
}

main().catch(e => console.error(e));
