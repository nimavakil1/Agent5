/**
 * One-time script to link VCS invoices to their corresponding sales orders
 *
 * This script:
 * 1. Reads VCS CSV file and stores orders in local MongoDB
 * 2. For each SHIPMENT order (not return), checks if:
 *    - There's a matching order in Odoo
 *    - There's a matching invoice in Odoo
 * 3. If both exist, links them
 *
 * Usage: node scripts/link-vcs-invoices-to-orders.js <vcs-file.csv> [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const xmlrpc = require('xmlrpc');
require('dotenv').config();

const ODOO_URL = (process.env.ODOO_URL || 'https://acropaq.odoo.com').replace('https://', '').replace('http://', '');
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_PASSWORD || process.env.ODOO_API_KEY;

const commonClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/common' });
const objectClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/object' });

let uid = null;

function authenticate() {
  return new Promise((resolve, reject) => {
    commonClient.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function execute(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall('execute_kw', [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function parseVcsFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  // Group by order ID to deduplicate (CSV has one row per line item)
  const orderMap = new Map();

  for (const row of records) {
    // Handle both column naming conventions
    const transactionType = row['Transaction Type'] || row['TRANSACTION_TYPE'];

    // Only process SHIPMENT orders (not returns)
    if (transactionType !== 'SHIPMENT') continue;

    const orderId = row['Order ID'] || row['ORDER_ID'];
    if (!orderId) continue;

    // Only add unique order IDs
    if (!orderMap.has(orderId)) {
      orderMap.set(orderId, {
        orderId,
        transactionType,
        shipDate: row['Shipment Date'] || row['SHIPMENT_DATE'],
        marketplace: row['Marketplace ID'] || row['MARKETPLACE_ID'],
        vatInvoiceNumber: row['VAT Invoice Number'] || row['VAT_INVOICE_NUMBER'] || '',
        invoiceUrl: row['Invoice Url'] || row['INVOICE_URL'] || '',
      });
    }
  }

  return Array.from(orderMap.values());
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
  const filePaths = args.filter(a => !a.startsWith('--'));

  if (filePaths.length === 0) {
    console.log('Usage: node scripts/link-vcs-invoices-to-orders.js <vcs-file1.csv> [vcs-file2.csv] [--dry-run]');
    process.exit(1);
  }

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
  }

  if (dryRun) {
    console.log('=== DRY RUN MODE - No changes will be made ===\n');
  }

  // Parse all VCS files
  let vcsOrders = [];
  for (const filePath of filePaths) {
    console.log(`Parsing VCS file: ${filePath}`);
    const orders = parseVcsFile(filePath);
    console.log(`  Found ${orders.length} SHIPMENT orders`);
    vcsOrders.push(...orders);
  }
  console.log(`\nTotal SHIPMENT orders from all files: ${vcsOrders.length}\n`);

  // Authenticate to Odoo
  console.log('Connecting to Odoo...');
  uid = await authenticate();
  console.log('Connected to Odoo\n');

  // Get unique order IDs
  const uniqueOrderIds = [...new Set(vcsOrders.map(o => o.orderId))];
  console.log(`Unique Amazon order IDs: ${uniqueOrderIds.length}\n`);

  // Build search variations (raw + FBA + FBM prefixes)
  const allSearchIds = [];
  for (const orderId of uniqueOrderIds) {
    allSearchIds.push(orderId);
    if (!orderId.startsWith('FBA')) allSearchIds.push('FBA' + orderId);
    if (!orderId.startsWith('FBM')) allSearchIds.push('FBM' + orderId);
  }

  // Fetch all matching orders from Odoo
  console.log('Fetching orders from Odoo...');
  const BATCH_SIZE = 500;
  const odooOrders = [];

  for (let i = 0; i < allSearchIds.length; i += BATCH_SIZE) {
    const batch = allSearchIds.slice(i, i + BATCH_SIZE);
    const orders = await execute('sale.order', 'search_read', [
      [['client_order_ref', 'in', batch]]
    ], {
      fields: ['id', 'name', 'client_order_ref', 'invoice_ids', 'invoice_status', 'order_line']
    });
    odooOrders.push(...orders);
    process.stdout.write(`  Fetched ${odooOrders.length} orders...\r`);
  }
  console.log(`\nFound ${odooOrders.length} matching orders in Odoo\n`);

  // Build order map (by raw order ID without prefix)
  const orderMap = {};
  for (const order of odooOrders) {
    const rawId = order.client_order_ref.replace(/^(FBA|FBM)/, '');
    if (!orderMap[rawId]) orderMap[rawId] = [];
    orderMap[rawId].push(order);
  }

  // Fetch all invoices from Odoo that have Amazon order patterns in invoice_origin
  console.log('Fetching invoices from Odoo...');
  const odooInvoices = await execute('account.move', 'search_read', [
    [
      ['move_type', 'in', ['out_invoice']],
      ['invoice_origin', '!=', false]
    ]
  ], {
    fields: ['id', 'name', 'invoice_origin', 'state', 'ref', 'payment_reference'],
    limit: 100000
  });
  console.log(`Found ${odooInvoices.length} invoices in Odoo\n`);

  // Build invoice map by Amazon order ID
  const invoiceMap = {};
  for (const inv of odooInvoices) {
    const origin = inv.invoice_origin || '';
    // Extract Amazon order ID patterns
    const matches = origin.match(/(?:FBA|FBM)?(\d{3}-\d{7}-\d{7})/g);
    if (matches) {
      for (const match of matches) {
        const rawId = match.replace(/^(FBA|FBM)/, '');
        if (!invoiceMap[rawId]) invoiceMap[rawId] = [];
        invoiceMap[rawId].push(inv);
      }
    }
    // Also check ref/payment_reference for VCS invoice numbers
    // (This might match by VAT invoice number)
  }
  console.log(`Built invoice map with ${Object.keys(invoiceMap).length} unique order IDs\n`);

  // Process each VCS order
  const results = {
    hasOrderAndInvoice: [],
    hasOrderNoInvoice: [],
    noOrderHasInvoice: [],
    noOrderNoInvoice: [],
  };

  for (const vcsOrder of vcsOrders) {
    const orderId = vcsOrder.orderId;
    const odooOrderList = orderMap[orderId] || [];
    const odooInvoiceList = invoiceMap[orderId] || [];

    if (odooOrderList.length > 0 && odooInvoiceList.length > 0) {
      results.hasOrderAndInvoice.push({
        orderId,
        orders: odooOrderList,
        invoices: odooInvoiceList,
        vatInvoiceNumber: vcsOrder.vatInvoiceNumber,
        invoiceUrl: vcsOrder.invoiceUrl,
      });
    } else if (odooOrderList.length > 0 && odooInvoiceList.length === 0) {
      results.hasOrderNoInvoice.push({
        orderId,
        orders: odooOrderList
      });
    } else if (odooOrderList.length === 0 && odooInvoiceList.length > 0) {
      results.noOrderHasInvoice.push({
        orderId,
        invoices: odooInvoiceList
      });
    } else {
      results.noOrderNoInvoice.push({ orderId });
    }
  }

  // Summary
  console.log('=== SUMMARY ===');
  console.log(`Has order AND invoice (will link): ${results.hasOrderAndInvoice.length}`);
  console.log(`Has order, NO invoice (do nothing): ${results.hasOrderNoInvoice.length}`);
  console.log(`NO order, has invoice (mark done): ${results.noOrderHasInvoice.length}`);
  console.log(`NO order, NO invoice: ${results.noOrderNoInvoice.length}`);
  console.log('');

  // Show samples
  if (results.hasOrderAndInvoice.length > 0) {
    console.log('=== Sample: Has Order AND Invoice (first 10) ===');
    for (const item of results.hasOrderAndInvoice.slice(0, 10)) {
      const orderNames = item.orders.map(o => o.name).join(', ');
      const invoiceNames = item.invoices.map(i => i.name).join(', ');
      console.log(`  ${item.orderId} -> Order: ${orderNames} | Invoice: ${invoiceNames}`);
    }
    console.log('');
  }

  if (results.hasOrderNoInvoice.length > 0) {
    console.log('=== Sample: Has Order, NO Invoice (first 10) ===');
    for (const item of results.hasOrderNoInvoice.slice(0, 10)) {
      const orderNames = item.orders.map(o => o.name).join(', ');
      console.log(`  ${item.orderId} -> Order: ${orderNames}`);
    }
    console.log('');
  }

  // Link orders to invoices
  if (!dryRun && results.hasOrderAndInvoice.length > 0) {
    const itemsToProcess = limit ? results.hasOrderAndInvoice.slice(0, limit) : results.hasOrderAndInvoice;
    console.log(`=== LINKING ORDERS TO INVOICES (${itemsToProcess.length}${limit ? ` limited from ${results.hasOrderAndInvoice.length}` : ''}) ===\n`);
    let linked = 0;
    let errors = 0;

    for (const item of itemsToProcess) {
      try {
        // Get the first order (usually there's just one)
        const order = item.orders[0];
        const invoiceIds = item.invoices.map(i => i.id);
        const invoiceNames = item.invoices.map(i => i.name).join(', ');

        // Check if order already has these invoices linked
        const existingInvoiceIds = order.invoice_ids || [];
        const newInvoiceIds = [...new Set([...existingInvoiceIds, ...invoiceIds])];

        console.log(`\n  Linking: ${item.orderId}`);
        console.log(`    Order: ${order.name} (ID: ${order.id})`);
        console.log(`    Invoice(s): ${invoiceNames} (IDs: ${invoiceIds.join(', ')})`);
        console.log(`    Existing invoice IDs on order: ${existingInvoiceIds.length > 0 ? existingInvoiceIds.join(', ') : 'none'}`);
        console.log(`    New invoice IDs to set: ${newInvoiceIds.join(', ')}`);

        // Link invoices to order
        await execute('sale.order', 'write', [[order.id], {
          invoice_ids: [[6, 0, newInvoiceIds]]
        }]);
        console.log(`    ✓ Linked invoices to order`);

        // Update invoice with VCS data (x_vcs_invoice_number, x_vcs_invoice_url)
        if (item.vatInvoiceNumber || item.invoiceUrl) {
          const invoiceUpdate = {};
          if (item.vatInvoiceNumber) {
            invoiceUpdate.x_vcs_invoice_number = item.vatInvoiceNumber;
          }
          if (item.invoiceUrl) {
            invoiceUpdate.x_vcs_invoice_url = item.invoiceUrl;
          }

          // Update all invoices for this order
          for (const inv of item.invoices) {
            await execute('account.move', 'write', [[inv.id], invoiceUpdate]);
          }
          console.log(`    ✓ Updated invoice(s) with VCS data (number: ${item.vatInvoiceNumber || 'n/a'}, url: ${item.invoiceUrl ? 'yes' : 'no'})`);
        }

        // Update qty_delivered and qty_invoiced on order lines
        if (order.order_line && order.order_line.length > 0) {
          const lines = await execute('sale.order.line', 'search_read', [
            [['id', 'in', order.order_line]]
          ], {
            fields: ['id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'name']
          });

          let linesUpdated = 0;
          for (const line of lines) {
            if (line.qty_invoiced < line.product_uom_qty) {
              await execute('sale.order.line', 'write', [[line.id], {
                qty_delivered: line.product_uom_qty,
                qty_invoiced: line.product_uom_qty
              }]);
              linesUpdated++;
            }
          }
          console.log(`    ✓ Updated ${linesUpdated}/${lines.length} order lines (qty_delivered & qty_invoiced)`);
        }

        linked++;
        if (!limit && linked % 100 === 0) {
          console.log(`\n  Progress: Linked ${linked}/${itemsToProcess.length}...`);
        }
      } catch (error) {
        errors++;
        console.error(`  ✗ Error linking ${item.orderId}: ${error.message}`);
      }
    }

    console.log(`\nCompleted: Linked ${linked}, Errors ${errors}`);
  } else if (dryRun && results.hasOrderAndInvoice.length > 0) {
    console.log(`Would link ${results.hasOrderAndInvoice.length} orders to their invoices`);
  }

  console.log('\nDone!');
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
