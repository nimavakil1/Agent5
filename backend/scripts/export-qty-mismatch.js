require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Fetching orders...');

  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'invoice_ids', 'amount_total', 'date_order', 'partner_id'],
    { limit: 3000, order: 'date_order asc' }
  );

  console.log('Processing ' + orders.length + ' orders...');

  const results = [];
  let processed = 0;

  for (const order of orders) {
    processed++;
    if (processed % 300 === 0) console.log('Progress: ' + processed + '/' + orders.length);

    if (order.invoice_ids.length !== 1) continue;

    const invoiceId = order.invoice_ids[0];

    const invoices = await odoo.searchRead('account.move',
      [['id', '=', invoiceId]],
      ['id', 'name', 'move_type', 'state', 'amount_total']
    );

    if (invoices.length === 0) continue;
    const invoice = invoices[0];
    if (invoice.move_type !== 'out_invoice' || invoice.state !== 'posted') continue;

    // Get order lines with product names
    const orderLines = await odoo.searchRead('sale.order.line',
      [['order_id', '=', order.id]],
      ['id', 'product_id', 'product_uom_qty', 'qty_delivered']
    );

    // Get invoice lines with product names
    const invoiceLines = await odoo.searchRead('account.move.line',
      [['move_id', '=', invoiceId], ['display_type', '=', 'product']],
      ['id', 'product_id', 'quantity']
    );

    // Sum quantities per product for order
    const orderQtyByProduct = {};
    const productNames = {};
    for (const line of orderLines) {
      if (!line.product_id) continue;
      const productId = line.product_id[0];
      if ([16401, 16402, 16403, 16404].includes(productId)) continue;
      orderQtyByProduct[productId] = (orderQtyByProduct[productId] || 0) + line.qty_delivered;
      productNames[productId] = line.product_id[1];
    }

    // Sum quantities per product for invoice
    const invoiceQtyByProduct = {};
    for (const line of invoiceLines) {
      if (!line.product_id) continue;
      const productId = line.product_id[0];
      if ([16401, 16402, 16403, 16404].includes(productId)) continue;
      invoiceQtyByProduct[productId] = (invoiceQtyByProduct[productId] || 0) + line.quantity;
      if (!productNames[productId]) productNames[productId] = line.product_id[1];
    }

    // Compare quantities
    const allProducts = new Set([...Object.keys(orderQtyByProduct), ...Object.keys(invoiceQtyByProduct)]);

    for (const productId of allProducts) {
      const orderQty = orderQtyByProduct[productId] || 0;
      const invoiceQty = invoiceQtyByProduct[productId] || 0;

      if (Math.abs(orderQty - invoiceQty) > 0.01) {
        const diff = invoiceQty - orderQty;
        let caseType = '';

        if (diff > 0) {
          // Over-invoiced
          if (orderQty === 0) {
            if (productId === '1' || productId === 1) {
              caseType = 'OVER - Product ID 1 on invoice (not on order)';
            } else {
              caseType = 'OVER - Product on invoice but not on order';
            }
          } else {
            caseType = 'OVER - Invoice qty exceeds order qty';
          }
        } else {
          // Under-invoiced
          if (invoiceQty === 0) {
            caseType = 'UNDER - Product on order but not invoiced';
          } else {
            caseType = 'UNDER - Invoice qty less than order qty';
          }
        }

        const customerName = order.partner_id ? order.partner_id[1].replace(/,/g, ' ').replace(/"/g, "'") : '';
        const productName = (productNames[productId] || 'Unknown').replace(/,/g, ' ').replace(/"/g, "'");

        results.push({
          order: order.name,
          date: order.date_order ? order.date_order.substring(0, 10) : '',
          customer: customerName,
          invoice: invoice.name,
          orderTotal: order.amount_total.toFixed(2),
          invoiceTotal: invoice.amount_total.toFixed(2),
          productId: productId,
          productName: productName,
          orderQty: orderQty,
          invoiceQty: invoiceQty,
          qtyDiff: diff.toFixed(0),
          caseType: caseType
        });
      }
    }
  }

  // Sort by case type then date
  results.sort((a, b) => {
    if (a.caseType !== b.caseType) return a.caseType.localeCompare(b.caseType);
    return a.date.localeCompare(b.date);
  });

  // Create CSV
  const header = 'Case Type,Order,Date,Customer,Invoice,Order Total,Invoice Total,Product ID,Product Name,Order Qty,Invoice Qty,Qty Difference';
  const csv = header + '\n' + results.map(r =>
    [
      '"' + r.caseType + '"',
      r.order,
      r.date,
      '"' + r.customer + '"',
      r.invoice,
      r.orderTotal,
      r.invoiceTotal,
      r.productId,
      '"' + r.productName + '"',
      r.orderQty,
      r.invoiceQty,
      r.qtyDiff
    ].join(',')
  ).join('\n');

  fs.writeFileSync('/Users/nimavakil/Downloads/QUANTITY_MISMATCH_ORDERS.csv', csv);

  // Summary
  const caseTypes = {};
  for (const r of results) {
    caseTypes[r.caseType] = (caseTypes[r.caseType] || 0) + 1;
  }

  console.log('\n=== SUMMARY BY CASE TYPE ===');
  for (const [type, count] of Object.entries(caseTypes).sort((a, b) => b[1] - a[1])) {
    console.log(count + ' - ' + type);
  }

  console.log('\nTotal rows: ' + results.length);
  console.log('File saved to ~/Downloads/QUANTITY_MISMATCH_ORDERS.csv');
}

main().catch(e => console.error(e));
