require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parse/sync');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkOrders() {
  // Parse VCS
  const content = fs.readFileSync('/tmp/vcs_report.csv', 'utf-8');
  const records = csv.parse(content, { columns: true, skip_empty_lines: true });

  // Get SHIPMENT orders from VCS
  const vcsOrderIds = new Set();
  for (const row of records) {
    if (row['Transaction Type'] === 'SHIPMENT' && row['Order ID']) {
      vcsOrderIds.add(row['Order ID']);
    }
  }
  console.log('VCS SHIPMENT orders:', vcsOrderIds.size);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get all Amazon orders from Odoo
  console.log('\nFetching Odoo orders...');
  const allOrders = await odoo.searchRead('sale.order',
    [['name', '=like', 'F%-%-%']],
    ['id', 'name', 'client_order_ref', 'invoice_ids', 'invoice_status', 'state'],
    { limit: 100000 }
  );

  // Find orders that are in VCS but have no invoice
  const ordersNeedingInvoice = [];
  const seenRefs = new Map(); // Track duplicates

  for (const o of allOrders) {
    if (!o.client_order_ref) continue;
    if (!vcsOrderIds.has(o.client_order_ref)) continue;
    if (o.invoice_ids && o.invoice_ids.length > 0) continue;

    // Track duplicates
    if (seenRefs.has(o.client_order_ref)) {
      seenRefs.get(o.client_order_ref).push(o);
    } else {
      seenRefs.set(o.client_order_ref, [o]);
    }

    ordersNeedingInvoice.push(o);
  }

  console.log('\n========================================');
  console.log('ORDERS NEEDING INVOICE:', ordersNeedingInvoice.length);
  console.log('========================================\n');

  // Check for duplicates
  const duplicates = [];
  for (const [ref, orders] of seenRefs) {
    if (orders.length > 1) {
      duplicates.push({ ref, orders: orders.map(o => ({ id: o.id, name: o.name })) });
    }
  }

  console.log('DUPLICATE CHECK:');
  console.log('  Unique client_order_refs:', seenRefs.size);
  console.log('  Total orders:', ordersNeedingInvoice.length);
  console.log('  Duplicates found:', duplicates.length);

  if (duplicates.length > 0) {
    console.log('\n  Duplicate examples (first 10):');
    for (const dup of duplicates.slice(0, 10)) {
      console.log('    ' + dup.ref + ':');
      for (const o of dup.orders) {
        console.log('      - ' + o.name + ' (ID: ' + o.id + ')');
      }
    }
  }

  // Now check order lines for a sample
  console.log('\n========================================');
  console.log('CHECKING ORDER LINES');
  console.log('========================================\n');

  // Get order IDs to check (limit for performance)
  const orderIdsToCheck = ordersNeedingInvoice.slice(0, 500).map(o => o.id);

  console.log('Checking', orderIdsToCheck.length, 'orders...');

  const orderLines = await odoo.searchRead('sale.order.line',
    [['order_id', 'in', orderIdsToCheck]],
    ['id', 'order_id', 'product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'invoice_lines', 'price_unit', 'name'],
    { limit: 10000 }
  );

  console.log('Total order lines found:', orderLines.length);

  // Analyze lines
  let linesWithInvoiceLinks = 0;
  let linesWithoutInvoiceLinks = 0;
  let linesQtyZero = 0;
  let linesQtyNegative = 0;
  let linesQtyPositive = 0;
  let linesNotDelivered = 0;
  let linesPartiallyInvoiced = 0;

  const problemLines = [];

  for (const line of orderLines) {
    // Check invoice links
    if (line.invoice_lines && line.invoice_lines.length > 0) {
      linesWithInvoiceLinks++;
      problemLines.push({
        lineId: line.id,
        orderId: line.order_id[0],
        orderName: line.order_id[1],
        product: line.product_id ? line.product_id[1] : 'N/A',
        invoiceLineCount: line.invoice_lines.length,
        issue: 'HAS_INVOICE_LINKS'
      });
    } else {
      linesWithoutInvoiceLinks++;
    }

    // Check quantities
    if (line.product_uom_qty === 0) {
      linesQtyZero++;
    } else if (line.product_uom_qty < 0) {
      linesQtyNegative++;
    } else {
      linesQtyPositive++;
    }

    // Check delivery status
    if (line.qty_delivered === 0 && line.product_uom_qty > 0) {
      linesNotDelivered++;
    }

    // Check if partially invoiced
    if (line.qty_invoiced > 0 && line.qty_invoiced < line.product_uom_qty) {
      linesPartiallyInvoiced++;
    }
  }

  console.log('\nLINE ANALYSIS:');
  console.log('  Lines WITH invoice links:', linesWithInvoiceLinks, linesWithInvoiceLinks > 0 ? '⚠️ PROBLEM!' : '✅');
  console.log('  Lines WITHOUT invoice links:', linesWithoutInvoiceLinks);
  console.log('');
  console.log('  Qty > 0 (sales):', linesQtyPositive);
  console.log('  Qty < 0 (returns/credits):', linesQtyNegative);
  console.log('  Qty = 0:', linesQtyZero);
  console.log('');
  console.log('  Not delivered (qty_delivered=0):', linesNotDelivered);
  console.log('  Partially invoiced:', linesPartiallyInvoiced);

  if (problemLines.length > 0) {
    console.log('\n========================================');
    console.log('PROBLEM LINES (have invoice links but order shows no invoice)');
    console.log('========================================\n');
    console.log('First 20 problem lines:');
    for (const p of problemLines.slice(0, 20)) {
      console.log('  Order:', p.orderName, '| Line:', p.lineId, '| Product:', p.product.substring(0, 30), '| Invoice links:', p.invoiceLineCount);
    }
  }

  // Save full results
  fs.writeFileSync('/tmp/orders_needing_invoice.json', JSON.stringify({
    summary: {
      totalOrders: ordersNeedingInvoice.length,
      uniqueRefs: seenRefs.size,
      duplicates: duplicates.length,
      linesChecked: orderLines.length,
      linesWithInvoiceLinks,
      linesWithoutInvoiceLinks,
      linesQtyPositive,
      linesQtyNegative,
      linesQtyZero,
      linesNotDelivered
    },
    duplicates,
    problemLines: problemLines.slice(0, 100),
    orders: ordersNeedingInvoice.map(o => ({
      id: o.id,
      name: o.name,
      ref: o.client_order_ref,
      state: o.state,
      invoiceStatus: o.invoice_status
    }))
  }, null, 2));

  console.log('\nFull results saved to /tmp/orders_needing_invoice.json');
}

checkOrders().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
