/**
 * Generate Excel report of VCS orders with their Odoo status
 *
 * Columns:
 * A: Amazon Order Nr
 * B: Status (BOTH, Order only, Invoice only, NONE)
 * C: Type (Order, Return)
 * D: Date (order date or return date)
 *
 * Usage: node scripts/generate-vcs-status-excel.js <vcs-file1.csv> [vcs-file2.csv] ...
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const xmlrpc = require('xmlrpc');
const ExcelJS = require('exceljs');
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

    // Process both SHIPMENT and RETURN
    if (transactionType !== 'SHIPMENT' && transactionType !== 'RETURN') continue;

    const orderId = row['Order ID'] || row['ORDER_ID'];
    if (!orderId) continue;

    // Create unique key: orderId + transactionType (same order can have both shipment and return)
    const key = `${orderId}_${transactionType}`;

    if (!orderMap.has(key)) {
      // Get date based on type
      let date;
      if (transactionType === 'SHIPMENT') {
        date = row['Shipment Date'] || row['SHIPMENT_DATE'];
      } else {
        date = row['Return Date'] || row['RETURN_DATE'];
      }

      orderMap.set(key, {
        orderId,
        transactionType,
        date,
        marketplace: row['Marketplace ID'] || row['MARKETPLACE_ID'],
      });
    }
  }

  return Array.from(orderMap.values());
}

async function run() {
  const args = process.argv.slice(2);
  const filePaths = args.filter(a => !a.startsWith('--'));

  if (filePaths.length === 0) {
    console.log('Usage: node scripts/generate-vcs-status-excel.js <vcs-file1.csv> [vcs-file2.csv] ...');
    process.exit(1);
  }

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
  }

  // Parse all VCS files
  let vcsOrders = [];
  for (const filePath of filePaths) {
    console.log(`Parsing VCS file: ${filePath}`);
    const orders = parseVcsFile(filePath);
    console.log(`  Found ${orders.length} orders (SHIPMENT + RETURN)`);
    vcsOrders.push(...orders);
  }
  console.log(`\nTotal orders from all files: ${vcsOrders.length}\n`);

  // Authenticate to Odoo
  console.log('Connecting to Odoo...');
  uid = await authenticate();
  console.log('Connected to Odoo\n');

  // Get unique order IDs (without transaction type suffix)
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
      fields: ['id', 'name', 'client_order_ref', 'invoice_ids']
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
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['invoice_origin', '!=', false]
    ]
  ], {
    fields: ['id', 'name', 'invoice_origin', 'state', 'move_type'],
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
  }
  console.log(`Built invoice map with ${Object.keys(invoiceMap).length} unique order IDs\n`);

  // Process each VCS order and determine status
  console.log('Processing orders...');
  const rows = [];

  for (const vcsOrder of vcsOrders) {
    const orderId = vcsOrder.orderId;
    const odooOrderList = orderMap[orderId] || [];
    const odooInvoiceList = invoiceMap[orderId] || [];

    let status;
    if (odooOrderList.length > 0 && odooInvoiceList.length > 0) {
      status = 'BOTH';
    } else if (odooOrderList.length > 0 && odooInvoiceList.length === 0) {
      status = 'Order only';
    } else if (odooOrderList.length === 0 && odooInvoiceList.length > 0) {
      status = 'Invoice only';
    } else {
      status = 'NONE';
    }

    const type = vcsOrder.transactionType === 'SHIPMENT' ? 'Order' : 'Return';

    rows.push({
      amazonOrderNr: orderId,
      status,
      type,
      date: vcsOrder.date || ''
    });
  }

  // Create Excel workbook
  console.log('\nGenerating Excel file...');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('VCS Status Report');

  // Add headers
  worksheet.columns = [
    { header: 'Amazon Order Nr', key: 'amazonOrderNr', width: 25 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Type', key: 'type', width: 10 },
    { header: 'Date', key: 'date', width: 15 }
  ];

  // Style headers
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };

  // Add data rows
  for (const row of rows) {
    worksheet.addRow(row);
  }

  // Add conditional formatting colors for status
  for (let i = 2; i <= rows.length + 1; i++) {
    const cell = worksheet.getCell(`B${i}`);
    const status = cell.value;
    if (status === 'BOTH') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF90EE90' } }; // Light green
    } else if (status === 'Order only') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFA500' } }; // Orange
    } else if (status === 'Invoice only') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }; // Yellow
    } else if (status === 'NONE') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6347' } }; // Red
    }
  }

  // Save file
  const outputPath = path.join(process.env.HOME || '/tmp', 'Downloads', 'vcs-status-report.xlsx');
  await workbook.xlsx.writeFile(outputPath);
  console.log(`\nExcel file saved to: ${outputPath}`);

  // Summary
  const summary = {
    BOTH: rows.filter(r => r.status === 'BOTH').length,
    'Order only': rows.filter(r => r.status === 'Order only').length,
    'Invoice only': rows.filter(r => r.status === 'Invoice only').length,
    NONE: rows.filter(r => r.status === 'NONE').length
  };

  console.log('\n=== SUMMARY ===');
  console.log(`BOTH (has order and invoice): ${summary.BOTH}`);
  console.log(`Order only: ${summary['Order only']}`);
  console.log(`Invoice only: ${summary['Invoice only']}`);
  console.log(`NONE: ${summary.NONE}`);
  console.log(`\nTotal rows: ${rows.length}`);
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
