require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parse/sync');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkAllOrderLines() {
  // Parse VCS to get order IDs
  const content = fs.readFileSync('/tmp/vcs_report.csv', 'utf-8');
  const records = csv.parse(content, { columns: true, skip_empty_lines: true });

  const vcsOrderIds = new Set();
  for (const row of records) {
    if (row['Transaction Type'] === 'SHIPMENT' && row['Order ID']) {
      vcsOrderIds.add(row['Order ID']);
    }
  }
  console.log('VCS SHIPMENT orders:', vcsOrderIds.size);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get all Amazon sale orders that have no invoice_ids but are in VCS
  console.log('\nFetching sale orders without invoice_ids...');
  const saleOrders = await odoo.searchRead('sale.order',
    [
      ['name', '=like', 'F%-%-%'],
      ['invoice_ids', '=', false]
    ],
    ['id', 'name', 'client_order_ref', 'invoice_status'],
    { limit: 100000 }
  );

  // Filter to only those in VCS
  const ordersToCheck = saleOrders.filter(o => vcsOrderIds.has(o.client_order_ref));
  console.log('Orders in VCS without invoice_ids:', ordersToCheck.length);

  // Get all order lines for these orders
  const orderIds = ordersToCheck.map(o => o.id);
  console.log('\nFetching order lines...');

  // Fetch in batches
  const allLines = [];
  const batchSize = 1000;
  for (let i = 0; i < orderIds.length; i += batchSize) {
    const batch = orderIds.slice(i, i + batchSize);
    const lines = await odoo.searchRead('sale.order.line',
      [['order_id', 'in', batch]],
      ['id', 'order_id', 'product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'invoice_lines', 'price_unit'],
      { limit: 10000 }
    );
    allLines.push(...lines);
    process.stdout.write(`\rFetched ${allLines.length} lines...`);
  }
  console.log('\nTotal order lines:', allLines.length);

  // Build order ref lookup
  const orderRefById = {};
  for (const o of ordersToCheck) {
    orderRefById[o.id] = o.client_order_ref;
  }

  // Categorize lines
  const linesNeedingCheck = []; // qty_invoiced = 0, no invoice_lines
  const linesAlreadyInvoiced = []; // qty_invoiced > 0 or has invoice_lines

  for (const line of allLines) {
    if (line.invoice_lines && line.invoice_lines.length > 0) {
      linesAlreadyInvoiced.push(line);
    } else if (line.qty_invoiced > 0) {
      linesAlreadyInvoiced.push(line);
    } else {
      linesNeedingCheck.push(line);
    }
  }

  console.log('\nLines already invoiced (have invoice_lines or qty_invoiced > 0):', linesAlreadyInvoiced.length);
  console.log('Lines needing check (no invoice_lines, qty_invoiced = 0):', linesNeedingCheck.length);

  // Now check if invoices exist for these lines
  console.log('\n========================================');
  console.log('CHECKING FOR EXISTING UNLINKED INVOICES');
  console.log('========================================\n');

  // Get unique Amazon order IDs for lines needing check
  const amazonOrderIdsToCheck = new Set();
  for (const line of linesNeedingCheck) {
    const ref = orderRefById[line.order_id[0]];
    if (ref) amazonOrderIdsToCheck.add(ref);
  }
  console.log('Unique Amazon order IDs to check:', amazonOrderIdsToCheck.size);

  // Find all invoices that reference these Amazon order IDs
  console.log('Searching for invoices by origin...');
  const invoicesByOrigin = new Map(); // amazonOrderId -> [invoices]

  // Get ALL posted invoices with invoice_origin set, then filter in JS
  // This is more efficient than many small queries
  const allInvoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['invoice_origin', '!=', false]
    ],
    ['id', 'name', 'invoice_origin', 'state', 'amount_total'],
    { limit: 200000 }
  );
  console.log('Total posted invoices with origin:', allInvoices.length);

  // Build lookup
  for (const inv of allInvoices) {
    const origin = inv.invoice_origin || '';
    for (const amazonId of amazonOrderIdsToCheck) {
      if (origin.includes(amazonId)) {
        if (!invoicesByOrigin.has(amazonId)) {
          invoicesByOrigin.set(amazonId, []);
        }
        invoicesByOrigin.get(amazonId).push(inv);
      }
    }
  }
  console.log('Amazon orders with matching invoices:', invoicesByOrigin.size);

  // Now for each line, check if there's a matching invoice line
  console.log('\nChecking invoice lines for product matches...');

  const results = {
    hasMatchingInvoiceLine: [], // Invoice exists with matching product - needs linking
    noInvoiceExists: [],        // No invoice found - needs creation
    invoiceExistsNoMatch: []    // Invoice exists but no matching product line
  };

  // Get invoice IDs that we found
  const allInvoiceIds = new Set();
  for (const invoices of invoicesByOrigin.values()) {
    for (const inv of invoices) {
      allInvoiceIds.add(inv.id);
    }
  }

  // Fetch all invoice lines for these invoices
  console.log('Fetching invoice lines for', allInvoiceIds.size, 'invoices...');
  const invoiceIdArray = Array.from(allInvoiceIds);
  const invoiceLinesByInvoice = new Map(); // invoiceId -> [lines]

  for (let i = 0; i < invoiceIdArray.length; i += 500) {
    const batch = invoiceIdArray.slice(i, i + 500);
    const invLines = await odoo.searchRead('account.move.line',
      [['move_id', 'in', batch], ['display_type', '=', 'product']],
      ['id', 'move_id', 'product_id', 'quantity', 'price_unit', 'sale_line_ids'],
      { limit: 10000 }
    );

    for (const il of invLines) {
      const invId = il.move_id[0];
      if (!invoiceLinesByInvoice.has(invId)) {
        invoiceLinesByInvoice.set(invId, []);
      }
      invoiceLinesByInvoice.get(invId).push(il);
    }

    process.stdout.write(`\rFetched invoice lines for ${Math.min(i + 500, invoiceIdArray.length)}/${invoiceIdArray.length} invoices...`);
  }
  console.log('');

  // Now match sale order lines to invoice lines
  for (const solLine of linesNeedingCheck) {
    const amazonOrderId = orderRefById[solLine.order_id[0]];
    const productId = solLine.product_id ? solLine.product_id[0] : null;

    const invoices = invoicesByOrigin.get(amazonOrderId) || [];

    if (invoices.length === 0) {
      results.noInvoiceExists.push({
        saleOrderLineId: solLine.id,
        saleOrderId: solLine.order_id[0],
        saleOrderName: solLine.order_id[1],
        amazonOrderId,
        productId,
        productName: solLine.product_id ? solLine.product_id[1] : 'N/A',
        qty: solLine.product_uom_qty,
        price: solLine.price_unit
      });
      continue;
    }

    // Check if any invoice has a line with matching product
    let foundMatch = false;
    for (const inv of invoices) {
      const invLines = invoiceLinesByInvoice.get(inv.id) || [];
      for (const il of invLines) {
        const invProductId = il.product_id ? il.product_id[0] : null;
        if (invProductId === productId) {
          // Check if already linked
          const alreadyLinked = il.sale_line_ids && il.sale_line_ids.includes(solLine.id);

          results.hasMatchingInvoiceLine.push({
            saleOrderLineId: solLine.id,
            saleOrderId: solLine.order_id[0],
            saleOrderName: solLine.order_id[1],
            amazonOrderId,
            productId,
            productName: solLine.product_id ? solLine.product_id[1] : 'N/A',
            invoiceId: inv.id,
            invoiceName: inv.name,
            invoiceLineId: il.id,
            alreadyLinked,
            solQty: solLine.product_uom_qty,
            invQty: il.quantity
          });
          foundMatch = true;
          break;
        }
      }
      if (foundMatch) break;
    }

    if (!foundMatch) {
      results.invoiceExistsNoMatch.push({
        saleOrderLineId: solLine.id,
        saleOrderId: solLine.order_id[0],
        saleOrderName: solLine.order_id[1],
        amazonOrderId,
        productId,
        productName: solLine.product_id ? solLine.product_id[1] : 'N/A',
        invoiceCount: invoices.length,
        invoiceNames: invoices.map(i => i.name).join(', ')
      });
    }
  }

  console.log('\n========================================');
  console.log('FINAL RESULTS');
  console.log('========================================\n');

  console.log('Total order lines checked:', linesNeedingCheck.length);
  console.log('');
  console.log('Lines with MATCHING invoice line (needs linking):', results.hasMatchingInvoiceLine.length);
  console.log('Lines with NO invoice at all (needs creation):', results.noInvoiceExists.length);
  console.log('Lines with invoice but NO matching product (investigate):', results.invoiceExistsNoMatch.length);

  // Show samples
  if (results.hasMatchingInvoiceLine.length > 0) {
    console.log('\nSample lines needing LINKING (first 5):');
    for (const r of results.hasMatchingInvoiceLine.slice(0, 5)) {
      console.log('  SOL', r.saleOrderLineId, '→ Invoice', r.invoiceName, 'Line', r.invoiceLineId);
      console.log('    Product:', r.productName.substring(0, 40));
      console.log('    Already linked:', r.alreadyLinked);
    }
  }

  if (results.noInvoiceExists.length > 0) {
    console.log('\nSample lines needing INVOICE CREATION (first 5):');
    for (const r of results.noInvoiceExists.slice(0, 5)) {
      console.log('  SOL', r.saleOrderLineId, '| Order:', r.saleOrderName);
      console.log('    Product:', r.productName.substring(0, 40), '| Qty:', r.qty);
    }
  }

  if (results.invoiceExistsNoMatch.length > 0) {
    console.log('\nSample lines with INVOICE but NO PRODUCT MATCH (first 5):');
    for (const r of results.invoiceExistsNoMatch.slice(0, 5)) {
      console.log('  SOL', r.saleOrderLineId, '| Order:', r.saleOrderName);
      console.log('    Product:', r.productName.substring(0, 40));
      console.log('    Invoices:', r.invoiceNames);
    }
  }

  // Save results
  fs.writeFileSync('/tmp/order_lines_analysis.json', JSON.stringify({
    summary: {
      totalLinesChecked: linesNeedingCheck.length,
      needsLinking: results.hasMatchingInvoiceLine.length,
      needsInvoiceCreation: results.noInvoiceExists.length,
      needsInvestigation: results.invoiceExistsNoMatch.length
    },
    hasMatchingInvoiceLine: results.hasMatchingInvoiceLine,
    noInvoiceExists: results.noInvoiceExists,
    invoiceExistsNoMatch: results.invoiceExistsNoMatch
  }, null, 2));

  console.log('\nFull results saved to /tmp/order_lines_analysis.json');
}

checkAllOrderLines().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
