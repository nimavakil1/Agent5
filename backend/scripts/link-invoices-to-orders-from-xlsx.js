/**
 * Link VCS invoices to their corresponding sales orders in Odoo
 *
 * Reads the vcs-status-report.xlsx file and for orders with status "BOTH",
 * links the invoice lines to the order lines via sale_line_ids.
 *
 * Usage:
 *   node scripts/link-invoices-to-orders-from-xlsx.js --dry-run     # Preview only
 *   node scripts/link-invoices-to-orders-from-xlsx.js --limit=10    # Process first 10
 *   node scripts/link-invoices-to-orders-from-xlsx.js               # Process all
 */

const XLSX = require('xlsx');
const xmlrpc = require('xmlrpc');
require('dotenv').config();

// Odoo connection - use admin account
const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

const commonClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/common' });
const objectClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/object' });

let uid = null;

function authenticate() {
  return new Promise((resolve, reject) => {
    commonClient.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function execute(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall('execute_kw', [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findOrderByAmazonRef(amazonOrderId) {
  // Try different formats: raw, FBA prefix, FBM prefix
  const searchVariants = [
    amazonOrderId,
    'FBA' + amazonOrderId,
    'FBM' + amazonOrderId
  ];

  const orders = await execute('sale.order', 'search_read', [
    [['client_order_ref', 'in', searchVariants]]
  ], {
    fields: ['id', 'name', 'client_order_ref', 'order_line', 'invoice_ids']
  });

  return orders.length > 0 ? orders[0] : null;
}

async function findInvoiceByAmazonRef(amazonOrderId) {
  // Search for invoice with matching invoice_origin
  const invoices = await execute('account.move', 'search_read', [
    [
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['invoice_origin', 'ilike', amazonOrderId]
    ]
  ], {
    fields: ['id', 'name', 'invoice_origin', 'state', 'line_ids']
  });

  return invoices.length > 0 ? invoices[0] : null;
}

async function linkInvoiceToOrder(order, invoice, dryRun = false) {
  // Get order lines with products
  const orderLines = await execute('sale.order.line', 'search_read', [
    [['order_id', '=', order.id]]
  ], {
    fields: ['id', 'product_id', 'product_uom_qty', 'invoice_lines']
  });

  // Get invoice lines with products (only product lines, not tax/payment lines)
  const invoiceLines = await execute('account.move.line', 'search_read', [
    [
      ['move_id', '=', invoice.id],
      ['display_type', '=', 'product']
    ]
  ], {
    fields: ['id', 'product_id', 'quantity', 'sale_line_ids']
  });

  let linked = 0;
  let alreadyLinked = 0;
  let unmatched = 0;

  // Match invoice lines to order lines by product_id
  for (const invLine of invoiceLines) {
    // Skip if already linked
    if (invLine.sale_line_ids && invLine.sale_line_ids.length > 0) {
      alreadyLinked++;
      continue;
    }

    // Find matching order line by product
    const matchingOrderLine = orderLines.find(ol =>
      ol.product_id && invLine.product_id &&
      ol.product_id[0] === invLine.product_id[0]
    );

    if (matchingOrderLine) {
      if (!dryRun) {
        // Link invoice line to order line
        await execute('account.move.line', 'write', [
          [invLine.id],
          { sale_line_ids: [[4, matchingOrderLine.id]] }
        ]);
      }
      linked++;
    } else {
      unmatched++;
    }
  }

  return { linked, alreadyLinked, unmatched };
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
  const xlsxPath = args.find(a => a.endsWith('.xlsx')) || '/Users/nimavakil/Downloads/vcs-status-report.xlsx';

  console.log('='.repeat(60));
  console.log('Link VCS Invoices to Orders');
  console.log('='.repeat(60));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');
  if (limit) console.log(`*** LIMITED TO ${limit} RECORDS ***\n`);

  // Read xlsx file
  console.log(`Reading ${xlsxPath}...`);
  const workbook = XLSX.readFile(xlsxPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet);

  // Filter for "BOTH" status only
  const bothOrders = data.filter(row => row.Status === 'BOTH');
  console.log(`Found ${bothOrders.length} orders with status "BOTH"\n`);

  // Apply limit if specified
  const toProcess = limit ? bothOrders.slice(0, limit) : bothOrders;

  // Authenticate to Odoo
  console.log('Connecting to Odoo...');
  uid = await authenticate();
  console.log(`Connected as uid: ${uid}\n`);

  // Statistics
  const stats = {
    processed: 0,
    linked: 0,
    alreadyLinked: 0,
    orderNotFound: 0,
    invoiceNotFound: 0,
    noMatchingLines: 0,
    errors: 0
  };

  // Process each order
  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i];
    const amazonOrderId = row['Amazon Order Nr'];

    try {
      // Find order
      const order = await findOrderByAmazonRef(amazonOrderId);
      if (!order) {
        stats.orderNotFound++;
        if (i < 10 || i % 1000 === 0) {
          console.log(`  [${i + 1}/${toProcess.length}] ${amazonOrderId}: Order not found`);
        }
        continue;
      }

      // Check if already has invoices linked
      if (order.invoice_ids && order.invoice_ids.length > 0) {
        stats.alreadyLinked++;
        if (i < 10 || i % 1000 === 0) {
          console.log(`  [${i + 1}/${toProcess.length}] ${amazonOrderId}: Already linked to invoice(s)`);
        }
        continue;
      }

      // Find invoice
      const invoice = await findInvoiceByAmazonRef(amazonOrderId);
      if (!invoice) {
        stats.invoiceNotFound++;
        if (i < 10 || i % 1000 === 0) {
          console.log(`  [${i + 1}/${toProcess.length}] ${amazonOrderId}: Invoice not found`);
        }
        continue;
      }

      // Link them
      const result = await linkInvoiceToOrder(order, invoice, dryRun);

      if (result.linked > 0) {
        stats.linked++;
        console.log(`  [${i + 1}/${toProcess.length}] ${amazonOrderId}: ${dryRun ? 'Would link' : 'Linked'} ${result.linked} lines (${result.alreadyLinked} already linked, ${result.unmatched} unmatched)`);
      } else if (result.alreadyLinked > 0) {
        stats.alreadyLinked++;
        if (i < 10 || i % 1000 === 0) {
          console.log(`  [${i + 1}/${toProcess.length}] ${amazonOrderId}: All lines already linked`);
        }
      } else {
        stats.noMatchingLines++;
        if (i < 10 || i % 1000 === 0) {
          console.log(`  [${i + 1}/${toProcess.length}] ${amazonOrderId}: No matching lines found`);
        }
      }

      stats.processed++;

      // Rate limiting - 100ms between requests
      await sleep(100);

      // Progress update every 100 records
      if ((i + 1) % 100 === 0) {
        console.log(`\n--- Progress: ${i + 1}/${toProcess.length} (${Math.round((i + 1) / toProcess.length * 100)}%) ---`);
        console.log(`    Linked: ${stats.linked}, Already linked: ${stats.alreadyLinked}`);
        console.log(`    Order not found: ${stats.orderNotFound}, Invoice not found: ${stats.invoiceNotFound}`);
        console.log('');
      }

    } catch (error) {
      stats.errors++;
      console.error(`  [${i + 1}/${toProcess.length}] ${amazonOrderId}: ERROR - ${error.message}`);
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total processed: ${stats.processed}`);
  console.log(`Successfully linked: ${stats.linked}`);
  console.log(`Already linked: ${stats.alreadyLinked}`);
  console.log(`Order not found: ${stats.orderNotFound}`);
  console.log(`Invoice not found: ${stats.invoiceNotFound}`);
  console.log(`No matching lines: ${stats.noMatchingLines}`);
  console.log(`Errors: ${stats.errors}`);

  if (dryRun) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
