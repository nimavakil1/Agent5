/**
 * Fix qty_delivered for all invoiced SHIPMENT orders
 *
 * This script:
 * 1. Gets all SHIPMENT orders that are invoiced from MongoDB
 * 2. For each order, updates qty_delivered on the Odoo sale order lines
 *
 * Run with: node scripts/fix-qty-delivered-today.js [--dry-run]
 */

const xmlrpc = require('xmlrpc');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const ODOO_URL = (process.env.ODOO_URL || 'https://acropaq.odoo.com').replace('https://', '').replace('http://', '');
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_PASSWORD || process.env.ODOO_API_KEY;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

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
  if (dryRun) {
    console.log('=== DRY RUN MODE - No changes will be made ===\n');
  }

  // Connect to MongoDB
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  console.log('Connected to MongoDB');

  // Authenticate to Odoo
  const uid = await authenticate();
  console.log('Connected to Odoo');

  // Get ALL invoiced SHIPMENT orders with odooSaleOrderId
  console.log(`\nFinding all invoiced SHIPMENT orders with Odoo sale order IDs...`);

  const orders = await db.collection('amazon_vcs_orders').find({
    transactionType: 'SHIPMENT',
    status: 'invoiced',
    odooSaleOrderId: { $exists: true, $ne: null }
  }).toArray();

  console.log(`Found ${orders.length} invoiced SHIPMENT orders`);

  // Get unique Odoo sale order IDs
  const saleOrderIds = [...new Set(orders.map(o => o.odooSaleOrderId))];
  console.log(`Unique Odoo sale orders: ${saleOrderIds.length}`);

  if (saleOrderIds.length === 0) {
    console.log('No orders to update');
    await mongoClient.close();
    return;
  }

  // Get order lines for all these orders
  console.log('\nFetching order lines from Odoo...');
  const orderLines = await execute(uid, 'sale.order.line', 'search_read', [
    [['order_id', 'in', saleOrderIds]]
  ], {
    fields: ['id', 'order_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced']
  });

  console.log(`Found ${orderLines.length} order lines`);

  // Find lines where qty_delivered < product_uom_qty
  const linesToUpdate = orderLines.filter(l => l.qty_delivered < l.product_uom_qty);
  console.log(`Lines needing qty_delivered update: ${linesToUpdate.length}`);

  if (linesToUpdate.length === 0) {
    console.log('All order lines already have correct qty_delivered');
    await mongoClient.close();
    return;
  }

  // Show sample
  console.log('\n=== Sample lines to update (first 20) ===');
  for (const line of linesToUpdate.slice(0, 20)) {
    console.log(`  Line ${line.id} (Order ${line.order_id[1]}): qty=${line.product_uom_qty}, delivered=${line.qty_delivered}, invoiced=${line.qty_invoiced}`);
  }
  if (linesToUpdate.length > 20) {
    console.log(`  ... and ${linesToUpdate.length - 20} more`);
  }

  if (!dryRun) {
    console.log('\n=== Updating qty_delivered ===');
    let updated = 0;
    let errors = 0;

    for (const line of linesToUpdate) {
      try {
        await execute(uid, 'sale.order.line', 'write', [[line.id], {
          qty_delivered: line.product_uom_qty
        }]);
        updated++;

        if (updated % 100 === 0) {
          console.log(`  Updated ${updated}/${linesToUpdate.length}...`);
        }
      } catch (error) {
        errors++;
        console.error(`  Error updating line ${line.id}: ${error.message}`);
      }
    }

    console.log(`\nCompleted: Updated ${updated}, Errors ${errors}`);
  } else {
    console.log('\n=== Dry run - no changes made ===');
    console.log(`Would update ${linesToUpdate.length} order lines`);
  }

  await mongoClient.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
