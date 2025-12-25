/**
 * Export Category E Orders - Multiple Invoices per Order
 *
 * Creates an Excel file with orders that have 2+ invoices linked
 */

const xmlrpc = require('xmlrpc');
const XLSX = require('xlsx');
require('dotenv').config();

const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

const commonClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/common' });
const objectClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/object' });

let uid;

function authenticate() {
  return new Promise((resolve, reject) => {
    commonClient.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

function execute(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall('execute_kw', [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs], (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

async function run() {
  console.log('Connecting to Odoo...');
  uid = await authenticate();
  console.log('Connected to Odoo\n');

  // Find all Amazon orders with multiple invoices
  console.log('Finding orders with multiple invoices...\n');

  // Get all sale orders with invoice_ids
  const orders = await execute('sale.order', 'search_read', [
    [
      ['invoice_ids', '!=', false],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ]
  ], {
    fields: ['id', 'name', 'date_order', 'invoice_ids', 'client_order_ref'],
    order: 'date_order desc'
  });

  console.log(`Found ${orders.length} Amazon orders with invoices`);

  // Filter to only orders with multiple invoices
  const multiInvoiceOrders = orders.filter(o => o.invoice_ids && o.invoice_ids.length > 1);
  console.log(`Found ${multiInvoiceOrders.length} orders with 2+ invoices\n`);

  // Get invoice details for all these orders
  const allInvoiceIds = [];
  for (const order of multiInvoiceOrders) {
    allInvoiceIds.push(...order.invoice_ids);
  }
  const uniqueInvoiceIds = [...new Set(allInvoiceIds)];

  console.log(`Fetching details for ${uniqueInvoiceIds.length} invoices...`);

  // Fetch invoices in batches
  const invoiceMap = {};
  const batchSize = 200;
  for (let i = 0; i < uniqueInvoiceIds.length; i += batchSize) {
    const batch = uniqueInvoiceIds.slice(i, i + batchSize);
    const invoices = await execute('account.move', 'search_read', [
      [['id', 'in', batch]]
    ], {
      fields: ['id', 'name', 'state', 'amount_total']
    });

    for (const inv of invoices) {
      invoiceMap[inv.id] = inv;
    }

    if ((i + batchSize) % 500 === 0) {
      console.log(`  Fetched ${Math.min(i + batchSize, uniqueInvoiceIds.length)} invoices...`);
    }
  }

  console.log(`\nBuilding Excel data...`);

  // Build Excel data
  const excelData = [];

  for (const order of multiInvoiceOrders) {
    // Extract Amazon order ID from Odoo order name
    const amazonOrderId = order.name.replace(/^(FBA|FBM)/, '') || order.client_order_ref || '';

    // Get invoice names
    const invoiceNames = [];
    for (const invId of order.invoice_ids) {
      const inv = invoiceMap[invId];
      if (inv) {
        invoiceNames.push(inv.name);
      }
    }

    excelData.push({
      'Amazon Order Nr': amazonOrderId,
      'Odoo Order Nr': order.name,
      'Order Date': order.date_order ? order.date_order.split(' ')[0] : '',
      'Number of Invoices': order.invoice_ids.length,
      'Odoo Invoice Numbers': invoiceNames.join(', ')
    });
  }

  // Sort by order date descending
  excelData.sort((a, b) => b['Order Date'].localeCompare(a['Order Date']));

  console.log(`\nCreating Excel file with ${excelData.length} rows...`);

  // Create Excel workbook
  const worksheet = XLSX.utils.json_to_sheet(excelData);

  // Set column widths
  worksheet['!cols'] = [
    { wch: 25 },  // Amazon Order Nr
    { wch: 25 },  // Odoo Order Nr
    { wch: 12 },  // Order Date
    { wch: 18 },  // Number of Invoices
    { wch: 50 },  // Odoo Invoice Numbers
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Multiple Invoices');

  // Save file
  const outputPath = '/Users/nimavakil/Agent5/backend/output/category-e-multiple-invoices.xlsx';

  // Ensure output directory exists
  const fs = require('fs');
  const outputDir = '/Users/nimavakil/Agent5/backend/output';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  XLSX.writeFile(workbook, outputPath);

  console.log(`\n=== COMPLETE ===`);
  console.log(`Total orders with multiple invoices: ${excelData.length}`);
  console.log(`Excel file saved to: ${outputPath}`);
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
