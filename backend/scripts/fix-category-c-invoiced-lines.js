/**
 * Fix Category C Orders - Totals Match but qty_invoiced is wrong
 *
 * For orders where VCS total matches invoice total, but qty_invoiced
 * values are incorrect (causing negative qty_to_invoice).
 *
 * Solution: For each order line with negative qty_to_invoice,
 * set qty_invoiced = product_uom_qty (so qty_to_invoice becomes 0)
 *
 * Usage:
 *   node scripts/fix-category-c-invoiced-lines.js --dry-run    # Preview only
 *   node scripts/fix-category-c-invoiced-lines.js              # Apply fixes
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
  console.log('Fix Category C Orders - Totals Match, qty_invoiced Wrong');
  console.log('='.repeat(70));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');

  // Connect to MongoDB
  const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await mongoClient.connect();
  const db = mongoClient.db();

  // Connect to Odoo
  uid = await authenticate();
  console.log('Connected to Odoo and MongoDB\n');

  // Step 1: Find all orders with negative qty_to_invoice
  console.log('Finding orders with negative qty_to_invoice...\n');

  const negativeLines = await execute('sale.order.line', 'search_read', [
    [['qty_to_invoice', '<', 0]]
  ], {
    fields: ['order_id', 'product_id', 'product_uom_qty', 'qty_invoiced', 'qty_to_invoice'],
    order: 'order_id'
  });

  console.log(`Found ${negativeLines.length} lines with negative qty_to_invoice\n`);

  // Group by order
  const orderIds = [...new Set(negativeLines.map(l => l.order_id[0]))];
  console.log(`Across ${orderIds.length} unique orders\n`);

  // Get order details
  const orders = await execute('sale.order', 'search_read', [
    [['id', 'in', orderIds]]
  ], {
    fields: ['id', 'name', 'invoice_ids', 'amz_order_reference', 'amount_untaxed']
  });

  const orderMap = {};
  for (const o of orders) {
    orderMap[o.id] = o;
  }

  // Step 2: Identify Category C orders (totals match)
  console.log('Identifying Category C orders (VCS total matches invoice total)...\n');

  const categoryC = [];
  let processed = 0;

  for (const orderId of orderIds) {
    const order = orderMap[orderId];
    if (!order) continue;

    processed++;
    if (processed % 100 === 0) {
      console.log(`  Analyzed ${processed}/${orderIds.length}...`);
    }

    const amazonOrderId = order.name.replace(/^(FBA|FBM)/, '');

    // Get VCS data
    const vcsOrders = await db.collection('amazon_vcs_orders').find({
      orderId: { $regex: amazonOrderId }
    }).toArray();

    // Skip if no VCS data
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
    let invoiceTotal = 0;
    if (order.invoice_ids && order.invoice_ids.length > 0) {
      // Skip if multiple invoices (Category E)
      if (order.invoice_ids.length > 1) continue;

      const invoices = await execute('account.move', 'search_read', [
        [['id', 'in', order.invoice_ids]]
      ], {
        fields: ['id', 'name', 'amount_untaxed']
      });

      for (const inv of invoices) {
        invoiceTotal += inv.amount_untaxed;
      }
    } else {
      // No invoice (Category F)
      continue;
    }

    // Check if totals match (Category C)
    const diff = Math.abs(invoiceTotal - vcsTotal);
    if (diff < 1) {
      // Get the problematic lines for this order
      const orderNegativeLines = negativeLines.filter(l => l.order_id[0] === orderId);
      categoryC.push({
        orderId: orderId,
        orderName: order.name,
        vcsTotal: vcsTotal.toFixed(2),
        invoiceTotal: invoiceTotal.toFixed(2),
        linesToFix: orderNegativeLines
      });
    }
  }

  console.log(`\nFound ${categoryC.length} Category C orders (totals match)\n`);

  // Step 3: Fix the lines
  console.log('='.repeat(70));
  console.log('FIXING CATEGORY C ORDERS');
  console.log('='.repeat(70));

  const stats = {
    ordersFixed: 0,
    linesFixed: 0,
    errors: 0
  };

  for (let i = 0; i < categoryC.length; i++) {
    const order = categoryC[i];

    try {
      for (const line of order.linesToFix) {
        if (!dryRun) {
          // Set qty_invoiced = product_uom_qty (so qty_to_invoice becomes 0)
          await execute('sale.order.line', 'write', [
            [line.id],
            { qty_invoiced: line.product_uom_qty }
          ]);
        }

        stats.linesFixed++;

        if (stats.linesFixed <= 20 || stats.linesFixed % 200 === 0) {
          const productName = line.product_id ? line.product_id[1].substring(0, 35) : 'N/A';
          console.log(`  [${stats.linesFixed}] ${order.orderName}: ${dryRun ? 'Would fix' : 'Fixed'} "${productName}" (qty=${line.product_uom_qty}, was invoiced=${line.qty_invoiced})`);
        }
      }

      stats.ordersFixed++;

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
      console.log(`    Lines fixed: ${stats.linesFixed}`);
      console.log('');
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Category C orders found: ${categoryC.length}`);
  console.log(`Orders fixed: ${stats.ordersFixed}`);
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
