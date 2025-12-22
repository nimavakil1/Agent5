/**
 * Process Historical VCS Reports
 *
 * This script processes VCS reports with different handling based on date:
 * - NEW (December 2024+): Create invoices in Odoo, link to sales orders
 * - OLD (November 2024 and before): Link to existing orders/invoices only, generate Excel report
 *
 * For ALL orders (old and new):
 * - Find matching Odoo sales order by Amazon Order ID
 * - Check if invoice already exists in Odoo
 * - If invoice exists → Link it to the sales order and update qty_invoiced
 *
 * Usage: node scripts/process-historical-vcs.js <vcs-report.csv> [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const xmlrpc = require('xmlrpc');
const { MongoClient } = require('mongodb');
const ExcelJS = require('exceljs');
require('dotenv').config();

// Cutoff date: December 1, 2025 - anything before this is "old"
const CUTOFF_DATE = new Date('2025-12-01T00:00:00Z');

const ODOO_URL = (process.env.ODOO_URL || 'https://acropaq.odoo.com').replace('https://', '').replace('http://', '');
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_PASSWORD || process.env.ODOO_API_KEY;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

// Marketplace receivable accounts
const MARKETPLACE_RECEIVABLE_ACCOUNTS = {
  'DE': 820, 'FR': 821, 'NL': 822, 'ES': 823, 'IT': 824,
  'SE': 825, 'PL': 826, 'GB': 827, 'UK': 827, 'BE': 828, 'TR': 829,
};

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

/**
 * Parse VCS CSV report
 */
function parseVcsReport(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);

  // Detect delimiter
  const firstLine = lines[0] || '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  // Parse headers
  const headers = parseLine(lines[0], delimiter).map(h => toCamelCase(h.trim()));

  const orders = new Map(); // Group by orderId

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseLine(line, delimiter);
    const row = {};

    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });

    // Skip if no order ID
    if (!row.orderId) continue;

    const orderId = row.orderId;

    if (!orders.has(orderId)) {
      orders.set(orderId, {
        orderId,
        transactionType: row.transactionType,
        shipmentDate: parseDate(row.shipmentDate),
        taxReportingScheme: row.taxReportingScheme,
        marketplaceId: row.marketplaceId,
        shipFromCountry: row.shipFromCountry,
        shipToCountry: row.shipToCountry,
        vatInvoiceNumber: row.vatInvoiceNumber,
        items: [],
        totalExclusive: 0,
        totalTax: 0,
        totalInclusive: 0,
      });
    }

    const order = orders.get(orderId);

    // Add item
    if (row.sku) {
      const priceExclusive = parseAmount(row.itemPriceExclTax || row.totalActivityValueExclTax || '0');
      const taxAmount = parseAmount(row.totalItemTax || row.totalActivityValueTax || '0');
      const priceInclusive = priceExclusive + taxAmount;

      order.items.push({
        sku: row.sku,
        asin: row.asin,
        quantity: parseInt(row.quantity) || 1,
        priceExclusive,
        taxAmount,
        priceInclusive,
        taxRate: parseAmount(row.itemTaxRate || row.taxRate || '0'),
      });

      order.totalExclusive += priceExclusive;
      order.totalTax += taxAmount;
      order.totalInclusive += priceInclusive;
    }
  }

  return Array.from(orders.values());
}

function parseLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function toCamelCase(str) {
  return str.replace(/[-_]([a-z])/g, (g) => g[1].toUpperCase());
}

function parseAmount(value) {
  if (!value || value === '') return 0;
  return parseFloat(value.toString().replace(/[^0-9.,\-]/g, '').replace(',', '.')) || 0;
}

function parseDate(value) {
  if (!value) return null;
  // Try various date formats
  const date = new Date(value);
  if (!isNaN(date.getTime())) return date;

  // Try DD/MM/YYYY or MM/DD/YYYY
  const parts = value.split(/[\/\-]/);
  if (parts.length === 3) {
    // Assume DD/MM/YYYY for European dates
    const d = parseInt(parts[0]);
    const m = parseInt(parts[1]) - 1;
    const y = parseInt(parts[2]);
    return new Date(y < 100 ? 2000 + y : y, m, d);
  }

  return null;
}

/**
 * Find Odoo sales order by Amazon Order ID
 */
async function findOdooSalesOrder(uid, amazonOrderId) {
  // Try with and without FBA/FBM prefix
  const cleanOrderId = amazonOrderId.replace(/^(FBA|FBM)/, '');

  const orders = await execute(uid, 'sale.order', 'search_read', [
    ['|', '|',
      ['client_order_ref', '=', amazonOrderId],
      ['client_order_ref', '=', cleanOrderId],
      ['client_order_ref', '=', `FBA${cleanOrderId}`]
    ]
  ], {
    fields: ['id', 'name', 'client_order_ref', 'order_line', 'invoice_ids', 'invoice_status', 'state'],
    limit: 5
  });

  return orders.length > 0 ? orders[0] : null;
}

/**
 * Find existing invoice by Amazon Order ID in invoice_origin
 */
async function findExistingInvoice(uid, amazonOrderId) {
  const cleanOrderId = amazonOrderId.replace(/^(FBA|FBM)/, '');

  const invoices = await execute(uid, 'account.move', 'search_read', [
    [
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      '|', '|',
      ['invoice_origin', 'ilike', amazonOrderId],
      ['invoice_origin', 'ilike', cleanOrderId],
      ['invoice_origin', 'ilike', `FBA${cleanOrderId}`]
    ]
  ], {
    fields: ['id', 'name', 'invoice_origin', 'state', 'move_type'],
    limit: 5
  });

  return invoices.length > 0 ? invoices[0] : null;
}

/**
 * Link invoice to sales order and update qty_invoiced
 */
async function linkInvoiceToOrder(uid, order, invoice, dryRun) {
  if (dryRun) {
    console.log(`  [DRY RUN] Would link invoice ${invoice.name} to order ${order.name}`);
    return true;
  }

  try {
    // Add invoice to order's invoice_ids
    const currentInvoiceIds = order.invoice_ids || [];
    if (!currentInvoiceIds.includes(invoice.id)) {
      await execute(uid, 'sale.order', 'write', [[order.id], {
        invoice_ids: [[4, invoice.id, 0]]  // Add to Many2many
      }]);
    }

    // Update qty_invoiced on order lines
    const orderLines = await execute(uid, 'sale.order.line', 'search_read', [
      [['order_id', '=', order.id]]
    ], {
      fields: ['id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced']
    });

    for (const line of orderLines) {
      const qtyToInvoice = line.qty_delivered > 0 ? line.qty_delivered : line.product_uom_qty;
      if (line.qty_invoiced < qtyToInvoice) {
        await execute(uid, 'sale.order.line', 'write', [[line.id], {
          qty_invoiced: qtyToInvoice
        }]);
      }
    }

    console.log(`  ✓ Linked invoice ${invoice.name} to order ${order.name}`);
    return true;
  } catch (error) {
    console.error(`  ✗ Error linking invoice ${invoice.name} to order ${order.name}: ${error.message}`);
    return false;
  }
}

/**
 * Generate Excel report for historical orders
 */
async function generateExcelReport(historicalOrders, outputPath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Historical VCS Orders');

  // Define columns
  sheet.columns = [
    { header: 'Amazon Order ID', key: 'orderId', width: 25 },
    { header: 'Shipment Date', key: 'shipmentDate', width: 15 },
    { header: 'Transaction Type', key: 'transactionType', width: 15 },
    { header: 'Tax Scheme', key: 'taxScheme', width: 15 },
    { header: 'Marketplace', key: 'marketplace', width: 12 },
    { header: 'From Country', key: 'fromCountry', width: 12 },
    { header: 'To Country', key: 'toCountry', width: 12 },
    { header: 'VCS Invoice #', key: 'vcsInvoiceNumber', width: 20 },
    { header: 'SKU', key: 'sku', width: 20 },
    { header: 'ASIN', key: 'asin', width: 15 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Price Excl Tax', key: 'priceExclusive', width: 15 },
    { header: 'Tax Amount', key: 'taxAmount', width: 12 },
    { header: 'Tax Rate', key: 'taxRate', width: 10 },
    { header: 'Price Incl Tax', key: 'priceInclusive', width: 15 },
    { header: 'Odoo Order', key: 'odooOrder', width: 15 },
    { header: 'Odoo Invoice', key: 'odooInvoice', width: 15 },
    { header: 'Status', key: 'status', width: 20 },
  ];

  // Style header row
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };

  // Add data rows
  for (const order of historicalOrders) {
    for (const item of order.items) {
      sheet.addRow({
        orderId: order.orderId,
        shipmentDate: order.shipmentDate ? order.shipmentDate.toISOString().split('T')[0] : '',
        transactionType: order.transactionType,
        taxScheme: order.taxReportingScheme,
        marketplace: order.marketplaceId,
        fromCountry: order.shipFromCountry,
        toCountry: order.shipToCountry,
        vcsInvoiceNumber: order.vatInvoiceNumber,
        sku: item.sku,
        asin: item.asin,
        quantity: item.quantity,
        priceExclusive: item.priceExclusive,
        taxAmount: item.taxAmount,
        taxRate: item.taxRate,
        priceInclusive: item.priceInclusive,
        odooOrder: order.odooOrderName || '',
        odooInvoice: order.odooInvoiceName || '',
        status: order.status,
      });
    }
  }

  // Add summary section
  sheet.addRow([]);
  sheet.addRow(['SUMMARY']);
  sheet.addRow(['Total Orders', historicalOrders.length]);
  sheet.addRow(['Total Items', historicalOrders.reduce((sum, o) => sum + o.items.length, 0)]);
  sheet.addRow(['Total Excl Tax', historicalOrders.reduce((sum, o) => sum + o.totalExclusive, 0).toFixed(2)]);
  sheet.addRow(['Total Tax', historicalOrders.reduce((sum, o) => sum + o.totalTax, 0).toFixed(2)]);
  sheet.addRow(['Total Incl Tax', historicalOrders.reduce((sum, o) => sum + o.totalInclusive, 0).toFixed(2)]);

  await workbook.xlsx.writeFile(outputPath);
  console.log(`\nExcel report saved to: ${outputPath}`);
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const vcsFilePath = args.find(a => !a.startsWith('--'));

  if (!vcsFilePath) {
    console.error('Usage: node scripts/process-historical-vcs.js <vcs-report.csv> [--dry-run]');
    process.exit(1);
  }

  if (!fs.existsSync(vcsFilePath)) {
    console.error(`File not found: ${vcsFilePath}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('=== DRY RUN MODE - No changes will be made ===\n');
  }

  console.log(`Processing VCS report: ${vcsFilePath}`);
  console.log(`Cutoff date: ${CUTOFF_DATE.toISOString()} (December 2025+ = new)\n`);

  // Parse VCS report
  const vcsOrders = parseVcsReport(vcsFilePath);
  console.log(`Parsed ${vcsOrders.length} orders from VCS report\n`);

  // Connect to MongoDB and Odoo
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  console.log('Connected to MongoDB');

  const uid = await authenticate();
  console.log('Connected to Odoo\n');

  // Process statistics
  const stats = {
    total: vcsOrders.length,
    newOrders: 0,
    oldOrders: 0,
    linkedToExistingInvoice: 0,
    invoiceCreated: 0,
    orderNotFound: 0,
    alreadyLinked: 0,
    errors: 0,
  };

  const historicalOrders = []; // For Excel report
  const newOrdersToProcess = []; // For invoice creation

  console.log('=== Processing Orders ===\n');

  for (let i = 0; i < vcsOrders.length; i++) {
    const vcsOrder = vcsOrders[i];
    const shipmentDate = vcsOrder.shipmentDate;
    const isNew = shipmentDate && shipmentDate >= CUTOFF_DATE;

    if (isNew) {
      stats.newOrders++;
    } else {
      stats.oldOrders++;
    }

    // Progress indicator
    if ((i + 1) % 100 === 0) {
      console.log(`Processing ${i + 1}/${vcsOrders.length}...`);
    }

    // Step 1: Find Odoo sales order
    const odooOrder = await findOdooSalesOrder(uid, vcsOrder.orderId);

    if (!odooOrder) {
      stats.orderNotFound++;
      vcsOrder.status = 'No Odoo order found';
      if (!isNew) {
        historicalOrders.push(vcsOrder);
      }
      continue;
    }

    vcsOrder.odooOrderId = odooOrder.id;
    vcsOrder.odooOrderName = odooOrder.name;

    // Step 2: Check if invoice already exists
    const existingInvoice = await findExistingInvoice(uid, vcsOrder.orderId);

    if (existingInvoice) {
      vcsOrder.odooInvoiceId = existingInvoice.id;
      vcsOrder.odooInvoiceName = existingInvoice.name;

      // Check if already linked
      if (odooOrder.invoice_ids && odooOrder.invoice_ids.includes(existingInvoice.id)) {
        stats.alreadyLinked++;
        vcsOrder.status = 'Already linked';
      } else {
        // Link invoice to order
        const linked = await linkInvoiceToOrder(uid, odooOrder, existingInvoice, dryRun);
        if (linked) {
          stats.linkedToExistingInvoice++;
          vcsOrder.status = 'Linked to existing invoice';
        } else {
          stats.errors++;
          vcsOrder.status = 'Error linking';
        }
      }

      if (!isNew) {
        historicalOrders.push(vcsOrder);
      }
      continue;
    }

    // No existing invoice found
    if (isNew) {
      // For new orders: queue for invoice creation
      newOrdersToProcess.push(vcsOrder);
      vcsOrder.status = 'Pending invoice creation';
    } else {
      // For old orders: just report, don't create invoice
      vcsOrder.status = 'Historical - no invoice exists';
      historicalOrders.push(vcsOrder);
    }
  }

  // Step 3: Create invoices for new orders (using existing VcsOdooInvoicer logic)
  if (newOrdersToProcess.length > 0 && !dryRun) {
    console.log(`\n=== Creating invoices for ${newOrdersToProcess.length} new orders ===\n`);

    // Store orders in MongoDB first
    for (const order of newOrdersToProcess) {
      await db.collection('amazon_vcs_orders').updateOne(
        { orderId: order.orderId },
        {
          $set: {
            ...order,
            source: 'historical-upload',
            status: 'pending',
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );
    }

    console.log(`Stored ${newOrdersToProcess.length} new orders in MongoDB for processing.`);
    console.log('Run the VCS processor to create invoices: POST /api/amazon/vcs/process-to-odoo');
    stats.invoiceCreated = newOrdersToProcess.length;
  } else if (newOrdersToProcess.length > 0 && dryRun) {
    console.log(`\n[DRY RUN] Would create ${newOrdersToProcess.length} invoices for new orders`);
  }

  // Step 4: Generate Excel report for historical orders
  if (historicalOrders.length > 0) {
    const reportFileName = `vcs-historical-report-${new Date().toISOString().split('T')[0]}.xlsx`;
    const reportPath = path.join(path.dirname(vcsFilePath), reportFileName);
    await generateExcelReport(historicalOrders, reportPath);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total orders in VCS report: ${stats.total}`);
  console.log(`  - New orders (Dec 2025+): ${stats.newOrders}`);
  console.log(`  - Old orders (before Dec 2025): ${stats.oldOrders}`);
  console.log('');
  console.log(`Linked to existing invoices: ${stats.linkedToExistingInvoice}`);
  console.log(`Already linked: ${stats.alreadyLinked}`);
  console.log(`Orders not found in Odoo: ${stats.orderNotFound}`);
  console.log(`Errors: ${stats.errors}`);

  if (newOrdersToProcess.length > 0) {
    console.log('');
    console.log(`New orders queued for invoice creation: ${newOrdersToProcess.length}`);
  }

  if (historicalOrders.length > 0) {
    console.log('');
    console.log(`Historical orders in Excel report: ${historicalOrders.length}`);
  }

  await mongoClient.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
