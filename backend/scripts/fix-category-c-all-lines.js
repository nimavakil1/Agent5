/**
 * Fix Category C Orders - Mark ALL Lines as Fully Invoiced
 *
 * For orders where VCS total matches invoice total (Category C),
 * mark ALL lines as fully invoiced by setting qty_invoiced = product_uom_qty
 *
 * This fixes the root cause: split shipment lines where only some lines
 * were marked as invoiced.
 *
 * Usage:
 *   node scripts/fix-category-c-all-lines.js --dry-run    # Preview only
 *   node scripts/fix-category-c-all-lines.js              # Apply fixes
 */

const xmlrpc = require('xmlrpc');
const { MongoClient } = require('mongodb');
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('='.repeat(70));
  console.log('Fix Category C Orders - Mark ALL Lines as Fully Invoiced');
  console.log('='.repeat(70));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');

  // Connect to MongoDB
  const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await mongoClient.connect();
  const db = mongoClient.db();

  // Connect to Odoo
  uid = await authenticate();
  console.log('Connected to Odoo and MongoDB\n');

  // Get orders with "to invoice" status that have invoice_ids
  console.log('Finding orders with "to invoice" status and linked invoices...\n');

  const toInvoiceOrders = await execute('sale.order', 'search_read', [
    [['invoice_status', '=', 'to invoice'], ['invoice_ids', '!=', false]]
  ], {
    fields: ['id', 'name', 'invoice_ids', 'amount_untaxed'],
    order: 'id desc'
  });

  console.log(`Found ${toInvoiceOrders.length} orders with "to invoice" status and invoices\n`);

  // Identify Category C orders (VCS total matches invoice total)
  console.log('Identifying Category C orders (VCS total ≈ invoice total)...\n');

  const categoryC = [];
  let processed = 0;

  for (const order of toInvoiceOrders) {
    processed++;
    if (processed % 500 === 0) {
      console.log(`  Analyzed ${processed}/${toInvoiceOrders.length}...`);
    }

    // Skip orders with multiple invoices (Category E)
    if (order.invoice_ids.length > 1) continue;

    const amazonOrderId = order.name.replace(/^(FBA|FBM)/, '');

    // Get VCS data
    const vcsOrders = await db.collection('amazon_vcs_orders').find({
      orderId: { $regex: amazonOrderId }
    }).toArray();

    // Skip if no VCS data (Category D)
    if (vcsOrders.length === 0) continue;

    // Calculate VCS total
    let vcsTotal = 0;
    for (const vcs of vcsOrders) {
      if (vcs.items) {
        for (const item of vcs.items) {
          vcsTotal += item.priceExclusive || 0;
        }
      }
    }

    // Get invoice total
    const invoices = await execute('account.move', 'search_read', [
      [['id', 'in', order.invoice_ids]]
    ], { fields: ['amount_untaxed'] });

    const invoiceTotal = invoices.reduce((sum, inv) => sum + inv.amount_untaxed, 0);

    // Check if totals match (Category C)
    const diff = Math.abs(invoiceTotal - vcsTotal);
    if (diff < 1) {
      categoryC.push({
        orderId: order.id,
        orderName: order.name,
        vcsTotal: vcsTotal.toFixed(2),
        invoiceTotal: invoiceTotal.toFixed(2)
      });
    }
  }

  console.log(`\nFound ${categoryC.length} Category C orders (totals match)\n`);

  // Fix ALL lines for each Category C order
  console.log('='.repeat(70));
  console.log('FIXING ALL LINES FOR CATEGORY C ORDERS');
  console.log('='.repeat(70));

  const stats = {
    ordersFixed: 0,
    linesFixed: 0,
    errors: 0
  };

  for (let i = 0; i < categoryC.length; i++) {
    const order = categoryC[i];

    try {
      // Get ALL lines for this order (not just negative ones)
      const allLines = await execute('sale.order.line', 'search_read', [
        [['order_id', '=', order.orderId]]
      ], {
        fields: ['id', 'product_id', 'product_uom_qty', 'qty_invoiced', 'qty_to_invoice']
      });

      // Fix any line where qty_invoiced != product_uom_qty
      let orderLinesFixed = 0;
      for (const line of allLines) {
        if (line.qty_invoiced !== line.product_uom_qty) {
          if (!dryRun) {
            await execute('sale.order.line', 'write', [
              [line.id],
              { qty_invoiced: line.product_uom_qty }
            ]);
          }
          orderLinesFixed++;
          stats.linesFixed++;
        }
      }

      if (orderLinesFixed > 0) {
        stats.ordersFixed++;
        if (stats.ordersFixed <= 20 || stats.ordersFixed % 200 === 0) {
          console.log(`  [${stats.ordersFixed}] ${order.orderName}: ${dryRun ? 'Would fix' : 'Fixed'} ${orderLinesFixed} lines`);
        }
      }

      // Rate limiting
      if (!dryRun && stats.ordersFixed % 50 === 0) {
        await sleep(100);
      }

    } catch (error) {
      stats.errors++;
      console.error(`  ERROR processing ${order.orderName}: ${error.message}`);
    }

    // Progress update
    if ((i + 1) % 200 === 0) {
      console.log(`\n--- Progress: ${i + 1}/${categoryC.length} orders ---`);
      console.log(`    Orders fixed: ${stats.ordersFixed}`);
      console.log(`    Lines fixed: ${stats.linesFixed}`);
      console.log('');
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Category C orders found: ${categoryC.length}`);
  console.log(`Orders with lines fixed: ${stats.ordersFixed}`);
  console.log(`Total lines fixed: ${stats.linesFixed}`);
  console.log(`Errors: ${stats.errors}`);

  if (dryRun) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
    console.log('Run without --dry-run to apply changes');
  }

  await mongoClient.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
