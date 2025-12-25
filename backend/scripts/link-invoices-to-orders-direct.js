/**
 * Link invoices to orders using pre-matched data
 *
 * Uses the orders-to-link-to-invoices.xlsx file which already has
 * direct Odoo Order ID → Odoo Invoice ID mappings.
 *
 * This is more efficient than searching each time.
 *
 * Usage:
 *   node scripts/link-invoices-to-orders-direct.js --dry-run     # Preview only
 *   node scripts/link-invoices-to-orders-direct.js --limit=10    # Process first 10
 *   node scripts/link-invoices-to-orders-direct.js               # Process all
 */

const XLSX = require('xlsx');
const xmlrpc = require('xmlrpc');
require('dotenv').config();

// Odoo connection
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

function executeOnce(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall('execute_kw', [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

async function execute(model, method, args, kwargs = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await executeOnce(model, method, args, kwargs);
    } catch (error) {
      if (attempt === retries) throw error;
      // Wait before retry (exponential backoff)
      await sleep(1000 * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function linkInvoiceToOrder(orderId, invoiceId, amazonOrderId, dryRun = false) {
  // Get order lines with products
  const orderLines = await execute('sale.order.line', 'search_read', [
    [['order_id', '=', orderId]]
  ], {
    fields: ['id', 'product_id', 'product_uom_qty', 'invoice_lines']
  });

  // Get invoice lines with products (only product lines, not tax/payment lines)
  const invoiceLines = await execute('account.move.line', 'search_read', [
    [
      ['move_id', '=', invoiceId],
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

  return { linked, alreadyLinked, unmatched, orderLineCount: orderLines.length, invoiceLineCount: invoiceLines.length };
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
  const xlsxPath = args.find(a => a.endsWith('.xlsx')) || '/Users/nimavakil/Downloads/orders-to-link-to-invoices.xlsx';

  console.log('='.repeat(60));
  console.log('Link Invoices to Orders (Direct ID Matching)');
  console.log('='.repeat(60));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');
  if (limit) console.log(`*** LIMITED TO ${limit} RECORDS ***\n`);

  // Read xlsx file
  console.log(`Reading ${xlsxPath}...`);
  const workbook = XLSX.readFile(xlsxPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet);

  // Filter for records that have both Odoo Order ID and Odoo Invoice ID
  const validRecords = data.filter(row =>
    row['Odoo Order ID'] && row['Odoo Invoice ID']
  );
  console.log(`Found ${validRecords.length} records with valid Order ID and Invoice ID\n`);

  // Apply limit if specified
  const toProcess = limit ? validRecords.slice(0, limit) : validRecords;

  // Authenticate to Odoo
  console.log('Connecting to Odoo...');
  uid = await authenticate();
  console.log(`Connected as uid: ${uid}\n`);

  // Statistics
  const stats = {
    processed: 0,
    linked: 0,
    alreadyLinked: 0,
    noMatchingLines: 0,
    errors: 0
  };

  // Process each record
  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i];
    const amazonOrderId = row['Amazon Order Nr'];
    const orderId = row['Odoo Order ID'];
    const invoiceId = row['Odoo Invoice ID'];

    try {
      const result = await linkInvoiceToOrder(orderId, invoiceId, amazonOrderId, dryRun);

      if (result.linked > 0) {
        stats.linked++;
        console.log(`  [${i + 1}/${toProcess.length}] ${amazonOrderId}: ${dryRun ? 'Would link' : 'Linked'} ${result.linked} lines (${result.alreadyLinked} already, ${result.unmatched} unmatched)`);
      } else if (result.alreadyLinked > 0) {
        stats.alreadyLinked++;
        if (i < 10 || i % 1000 === 0) {
          console.log(`  [${i + 1}/${toProcess.length}] ${amazonOrderId}: All ${result.alreadyLinked} lines already linked`);
        }
      } else {
        stats.noMatchingLines++;
        if (i < 10 || i % 500 === 0) {
          console.log(`  [${i + 1}/${toProcess.length}] ${amazonOrderId}: No matching lines (order has ${result.orderLineCount} lines, invoice has ${result.invoiceLineCount} lines)`);
        }
      }

      stats.processed++;

      // Rate limiting - 50ms between requests (faster since no searching)
      await sleep(50);

      // Progress update every 500 records
      if ((i + 1) % 500 === 0) {
        console.log(`\n--- Progress: ${i + 1}/${toProcess.length} (${Math.round((i + 1) / toProcess.length * 100)}%) ---`);
        console.log(`    Linked: ${stats.linked}, Already linked: ${stats.alreadyLinked}`);
        console.log(`    No matching lines: ${stats.noMatchingLines}, Errors: ${stats.errors}`);
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
  console.log(`No matching lines: ${stats.noMatchingLines}`);
  console.log(`Errors: ${stats.errors}`);

  if (dryRun) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
    console.log('Run without --dry-run to apply changes');
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
