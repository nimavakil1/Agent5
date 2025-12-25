/**
 * Fix Over-Invoiced Order Lines
 *
 * For orders that have invoice_ids but still show "to invoice",
 * fix lines where qty_invoiced > product_uom_qty (causing negative qty_to_invoice)
 * by setting qty_invoiced = product_uom_qty
 *
 * Usage:
 *   node scripts/fix-over-invoiced-lines.js --dry-run    # Preview only
 *   node scripts/fix-over-invoiced-lines.js --limit=100  # Process first 100
 *   node scripts/fix-over-invoiced-lines.js              # Process all
 */

const xmlrpc = require('xmlrpc');

// Odoo connection
const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

const commonClient = xmlrpc.createSecureClient({
  host: ODOO_URL,
  port: 443,
  path: '/xmlrpc/2/common'
});
const objectClient = xmlrpc.createSecureClient({
  host: ODOO_URL,
  port: 443,
  path: '/xmlrpc/2/object'
});

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

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

  console.log('='.repeat(60));
  console.log('Fix Over-Invoiced Lines (qty_invoiced > qty)');
  console.log('='.repeat(60));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');
  if (limit) console.log(`*** LIMITED TO ${limit} RECORDS ***\n`);

  // Connect to Odoo
  console.log('Connecting to Odoo...');
  uid = await authenticate();
  console.log(`Connected as uid: ${uid}\n`);

  // Get orders with "to invoice" status that HAVE invoice_ids
  console.log('Fetching orders with "to invoice" status and linked invoices...');

  const toInvoiceOrders = await execute('sale.order', 'search_read', [
    [['invoice_status', '=', 'to invoice']]
  ], {
    fields: ['id', 'name', 'invoice_ids', 'order_line'],
    limit: limit || 0,
    order: 'id desc'
  });

  console.log(`Found ${toInvoiceOrders.length} orders with "to invoice" status`);

  // Filter to only orders that have invoices linked
  const ordersWithInvoices = toInvoiceOrders.filter(o => o.invoice_ids && o.invoice_ids.length > 0);
  console.log(`Of these, ${ordersWithInvoices.length} have invoice_ids linked\n`);

  if (ordersWithInvoices.length === 0) {
    console.log('No orders to process.');
    return;
  }

  // Statistics
  const stats = {
    ordersProcessed: 0,
    ordersWithOverInvoiced: 0,
    linesFixed: 0,
    errors: 0
  };

  // Process each order
  for (let i = 0; i < ordersWithInvoices.length; i++) {
    const order = ordersWithInvoices[i];

    try {
      // Get all order lines with negative qty_to_invoice (over-invoiced)
      const overInvoicedLines = await execute('sale.order.line', 'search_read', [
        [
          ['order_id', '=', order.id],
          ['qty_to_invoice', '<', 0]  // Negative qty_to_invoice means over-invoiced
        ]
      ], {
        fields: ['id', 'name', 'product_uom_qty', 'qty_invoiced', 'qty_to_invoice', 'product_id']
      });

      if (overInvoicedLines.length > 0) {
        stats.ordersWithOverInvoiced++;

        for (const line of overInvoicedLines) {
          if (!dryRun) {
            // Set qty_invoiced = product_uom_qty (so qty_to_invoice becomes 0)
            await execute('sale.order.line', 'write', [
              [line.id],
              { qty_invoiced: line.product_uom_qty }
            ]);
          }

          stats.linesFixed++;

          if (stats.linesFixed <= 20 || stats.linesFixed % 500 === 0) {
            const productName = line.product_id ? line.product_id[1].substring(0, 30) : 'N/A';
            console.log(`  [${stats.linesFixed}] ${order.name}: ${dryRun ? 'Would fix' : 'Fixed'} "${productName}" (qty=${line.product_uom_qty}, was invoiced=${line.qty_invoiced})`);
          }
        }

        // Rate limiting
        if (!dryRun && stats.ordersWithOverInvoiced % 50 === 0) {
          await sleep(100);
        }
      }

      stats.ordersProcessed++;

    } catch (error) {
      stats.errors++;
      console.error(`  ERROR processing ${order.name}: ${error.message}`);
    }

    // Progress update
    if ((i + 1) % 2000 === 0) {
      console.log(`\n--- Progress: ${i + 1}/${ordersWithInvoices.length} orders ---`);
      console.log(`    Orders with over-invoiced lines: ${stats.ordersWithOverInvoiced}`);
      console.log(`    Lines fixed: ${stats.linesFixed}`);
      console.log('');
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Orders with invoices checked: ${ordersWithInvoices.length}`);
  console.log(`Orders with over-invoiced lines: ${stats.ordersWithOverInvoiced}`);
  console.log(`Total over-invoiced lines fixed: ${stats.linesFixed}`);
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
