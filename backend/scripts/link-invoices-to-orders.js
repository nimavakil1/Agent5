/**
 * Link existing VCS invoices to their corresponding sales orders
 *
 * This script:
 * 1. Finds all Amazon sales orders with invoice_status = 'to invoice'
 * 2. For each order, searches for existing invoices by Amazon Order ID (client_order_ref)
 * 3. If found, links the invoice to the order and updates qty_invoiced
 *
 * Run with: node scripts/link-invoices-to-orders.js [--dry-run]
 */

const xmlrpc = require('xmlrpc');
require('dotenv').config();

const ODOO_URL = (process.env.ODOO_URL || 'https://acropaq.odoo.com').replace('https://', '').replace('http://', '');
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_PASSWORD || process.env.ODOO_API_KEY;

const commonClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/common' });
const objectClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/object' });

function authenticate() {
  return new Promise((resolve, reject) => {
    commonClient.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}], (err, uid) => {
      if (err) reject(err);
      else resolve(uid);
    });
  });
}

function execute(uid, model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall('execute_kw', [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const verbose = process.argv.includes('--verbose');

  if (dryRun) {
    console.log('=== DRY RUN MODE - No changes will be made ===\n');
  }

  const uid = await authenticate();
  console.log('Connected to Odoo\n');

  // Step 1: Get all Amazon sales orders with "to invoice" status
  console.log('Fetching Amazon sales orders with "to invoice" status...');

  const orders = await execute(uid, 'sale.order', 'search_read', [
    [
      ['invoice_status', '=', 'to invoice'],
      ['client_order_ref', '!=', false],  // Has Amazon Order ID
      ['state', 'in', ['sale', 'done']]   // Confirmed orders
    ]
  ], {
    fields: ['id', 'name', 'client_order_ref', 'order_line', 'invoice_ids'],
    limit: 10000,
    order: 'id asc'
  });

  console.log(`Found ${orders.length} orders with "to invoice" status\n`);

  // Step 2: Build a map of Amazon Order IDs to invoices
  console.log('Building invoice map from Odoo...');

  // Get all invoices with invoice_origin containing Amazon order patterns
  const invoices = await execute(uid, 'account.move', 'search_read', [
    [
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['invoice_origin', '!=', false]
    ]
  ], {
    fields: ['id', 'name', 'invoice_origin', 'state', 'move_type'],
    limit: 50000
  });

  console.log(`Found ${invoices.length} invoices with invoice_origin\n`);

  // Build map: Amazon Order ID -> Invoice(s)
  const invoiceMap = {};
  for (const inv of invoices) {
    const origin = inv.invoice_origin || '';
    // Extract Amazon order ID patterns (e.g., "FBA302-1234567-8901234" or "302-1234567-8901234")
    const matches = origin.match(/(?:FBA|FBM)?(\d{3}-\d{7}-\d{7})/g);
    if (matches) {
      for (const match of matches) {
        const cleanId = match.replace(/^(FBA|FBM)/, '');
        if (!invoiceMap[cleanId]) {
          invoiceMap[cleanId] = [];
        }
        invoiceMap[cleanId].push(inv);
        // Also store with prefix
        if (!invoiceMap[match]) {
          invoiceMap[match] = [];
        }
        invoiceMap[match].push(inv);
      }
    }
  }

  console.log(`Built invoice map with ${Object.keys(invoiceMap).length} unique order IDs\n`);

  // Step 3: Process each order
  let linked = 0;
  let alreadyLinked = 0;
  let noInvoiceFound = 0;
  let errors = 0;

  const toLink = [];
  const notFound = [];

  for (const order of orders) {
    const amazonOrderId = order.client_order_ref;
    const cleanOrderId = amazonOrderId.replace(/^(FBA|FBM)/, '');

    // Check if order already has invoices
    if (order.invoice_ids && order.invoice_ids.length > 0) {
      alreadyLinked++;
      continue;
    }

    // Find matching invoice(s)
    const matchingInvoices = invoiceMap[amazonOrderId] || invoiceMap[cleanOrderId] || [];

    if (matchingInvoices.length === 0) {
      noInvoiceFound++;
      notFound.push({ orderId: order.id, orderName: order.name, amazonOrderId });
      continue;
    }

    toLink.push({
      order,
      invoices: matchingInvoices
    });
  }

  console.log('=== Summary ===');
  console.log(`Already linked: ${alreadyLinked}`);
  console.log(`To link: ${toLink.length}`);
  console.log(`No invoice found: ${noInvoiceFound}`);
  console.log('');

  if (toLink.length > 0) {
    console.log('=== Orders to Link (first 20) ===');
    for (const item of toLink.slice(0, 20)) {
      const invoiceNames = item.invoices.map(i => `${i.name} (${i.state})`).join(', ');
      console.log(`  ${item.order.name} (${item.order.client_order_ref}) -> ${invoiceNames}`);
    }
    if (toLink.length > 20) {
      console.log(`  ... and ${toLink.length - 20} more`);
    }
    console.log('');
  }

  if (notFound.length > 0 && verbose) {
    console.log('=== Orders without invoices (first 50) ===');
    for (const item of notFound.slice(0, 50)) {
      console.log(`  ${item.orderName} (${item.amazonOrderId})`);
    }
    if (notFound.length > 50) {
      console.log(`  ... and ${notFound.length - 50} more`);
    }
    console.log('');
  }

  if (!dryRun && toLink.length > 0) {
    console.log('=== Linking invoices to orders ===\n');

    for (const item of toLink) {
      try {
        const order = item.order;
        const invoiceIds = item.invoices.map(i => i.id);

        // Step 3a: Link invoices to order (add to invoice_ids Many2many)
        await execute(uid, 'sale.order', 'write', [[order.id], {
          invoice_ids: [[6, 0, invoiceIds]]  // Replace with these invoice IDs
        }]);

        // Step 3b: Get order lines and update qty_invoiced
        const orderLines = await execute(uid, 'sale.order.line', 'search_read', [
          [['order_id', '=', order.id]]
        ], {
          fields: ['id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced']
        });

        for (const line of orderLines) {
          // Set qty_invoiced to qty_delivered (or product_uom_qty if not delivered)
          const qtyToInvoice = line.qty_delivered > 0 ? line.qty_delivered : line.product_uom_qty;

          if (line.qty_invoiced < qtyToInvoice) {
            await execute(uid, 'sale.order.line', 'write', [[line.id], {
              qty_invoiced: qtyToInvoice
            }]);
          }
        }

        linked++;
        if (linked % 100 === 0) {
          console.log(`  Linked ${linked}/${toLink.length}...`);
        }

      } catch (error) {
        errors++;
        console.error(`  Error linking order ${item.order.name}: ${error.message}`);
      }
    }

    console.log(`\nCompleted: Linked ${linked}, Errors ${errors}`);
  } else if (dryRun) {
    console.log('=== Dry run - no changes made ===');
    console.log(`Would link ${toLink.length} orders to their invoices`);
  }

  // Summary of orders without invoices
  if (notFound.length > 0) {
    console.log(`\n${notFound.length} orders have no matching invoice in Odoo.`);
    console.log('These orders may need VCS invoices created.');
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
