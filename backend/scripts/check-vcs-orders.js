require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parse/sync');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkVcsOrders() {
  // Read and parse VCS file
  console.log('Reading VCS file...');
  const content = fs.readFileSync('/tmp/vcs_report.csv', 'utf-8');
  const records = csv.parse(content, { columns: true, skip_empty_lines: true });

  // Extract unique SHIPMENT order IDs (these need invoices)
  const shipmentOrders = new Map(); // orderId -> { rows, marketplace, dates }

  for (const row of records) {
    if (row['Transaction Type'] !== 'SHIPMENT') continue;

    const orderId = row['Order ID'];
    if (!orderId) continue;

    if (!shipmentOrders.has(orderId)) {
      shipmentOrders.set(orderId, {
        marketplace: row['Marketplace ID'],
        shipmentDate: row['Shipment Date'],
        currency: row['Currency'],
        items: []
      });
    }
    shipmentOrders.get(orderId).items.push({
      sku: row['SKU'],
      quantity: row['Quantity'],
      totalPrice: row['Total Activity Value Amt Vat Incl']
    });
  }

  console.log('SHIPMENT orders in VCS:', shipmentOrders.size);

  // Connect to Odoo
  console.log('\nConnecting to Odoo...');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get all order IDs to check
  const orderIds = Array.from(shipmentOrders.keys());

  // Check in batches of 500
  const batchSize = 500;
  const results = {
    hasInvoice: [],      // Already invoiced in Odoo
    hasOrderNoInvoice: [], // Has sale order but no invoice
    noOrder: [],         // No sale order in Odoo
  };

  console.log('Checking orders in Odoo (this may take a while)...\n');

  for (let i = 0; i < orderIds.length; i += batchSize) {
    const batch = orderIds.slice(i, i + batchSize);
    const progress = Math.round((i / orderIds.length) * 100);
    process.stdout.write(`\rProgress: ${progress}% (${i}/${orderIds.length})`);

    // Check for sale orders with these Amazon order IDs
    // They could be stored as client_order_ref or in the name (FBA/FBM prefix)
    const saleOrders = await odoo.searchRead('sale.order',
      [['client_order_ref', 'in', batch]],
      ['id', 'name', 'client_order_ref', 'invoice_status', 'invoice_ids']
    );

    // Create lookup map
    const orderMap = {};
    for (const so of saleOrders) {
      orderMap[so.client_order_ref] = so;
    }

    // Categorize each order
    for (const orderId of batch) {
      if (orderMap[orderId]) {
        const so = orderMap[orderId];
        if (so.invoice_ids && so.invoice_ids.length > 0) {
          results.hasInvoice.push({
            amazonOrderId: orderId,
            odooOrderId: so.id,
            odooOrderName: so.name,
            invoiceCount: so.invoice_ids.length
          });
        } else if (so.invoice_status === 'invoiced') {
          results.hasInvoice.push({
            amazonOrderId: orderId,
            odooOrderId: so.id,
            odooOrderName: so.name,
            invoiceCount: 0,
            note: 'invoice_status=invoiced but no invoice_ids'
          });
        } else {
          results.hasOrderNoInvoice.push({
            amazonOrderId: orderId,
            odooOrderId: so.id,
            odooOrderName: so.name,
            invoiceStatus: so.invoice_status
          });
        }
      } else {
        results.noOrder.push(orderId);
      }
    }
  }

  console.log('\n\n========================================');
  console.log('RESULTS');
  console.log('========================================\n');

  console.log('VCS SHIPMENT orders:', shipmentOrders.size);
  console.log('---');
  console.log('Already have invoice in Odoo:', results.hasInvoice.length);
  console.log('Have sale order but NO invoice:', results.hasOrderNoInvoice.length);
  console.log('No sale order in Odoo:', results.noOrder.length);

  console.log('\n========================================');
  console.log('ACTION REQUIRED');
  console.log('========================================\n');

  console.log(`${results.hasOrderNoInvoice.length} orders NEED INVOICES (order exists, no invoice)`);
  console.log(`${results.noOrder.length} orders NEED SALE ORDER + INVOICE (not in Odoo at all)`);
  console.log(`\nTOTAL TO PROCESS: ${results.hasOrderNoInvoice.length + results.noOrder.length}`);

  // Sample of orders needing invoices
  if (results.hasOrderNoInvoice.length > 0) {
    console.log('\nSample orders needing invoice (first 10):');
    for (const o of results.hasOrderNoInvoice.slice(0, 10)) {
      console.log(`  ${o.amazonOrderId} -> ${o.odooOrderName} (status: ${o.invoiceStatus})`);
    }
  }

  // Sample of orders not in Odoo
  if (results.noOrder.length > 0) {
    console.log('\nSample orders NOT in Odoo (first 10):');
    for (const orderId of results.noOrder.slice(0, 10)) {
      const info = shipmentOrders.get(orderId);
      console.log(`  ${orderId} (${info.marketplace}, ${info.shipmentDate})`);
    }
  }

  // Write detailed results to file
  fs.writeFileSync('/tmp/vcs_check_results.json', JSON.stringify({
    summary: {
      totalVcsShipments: shipmentOrders.size,
      alreadyInvoiced: results.hasInvoice.length,
      needInvoice: results.hasOrderNoInvoice.length,
      noOrderInOdoo: results.noOrder.length
    },
    hasOrderNoInvoice: results.hasOrderNoInvoice,
    noOrder: results.noOrder
  }, null, 2));

  console.log('\nDetailed results saved to /tmp/vcs_check_results.json');
}

checkVcsOrders().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
