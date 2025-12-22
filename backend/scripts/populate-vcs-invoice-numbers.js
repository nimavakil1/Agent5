/**
 * Populate x_vcs_invoice_number in Odoo from MongoDB VCS data
 *
 * This script copies vatInvoiceNumber from MongoDB amazon_vcs_orders
 * to x_vcs_invoice_number on the corresponding Odoo account.move records.
 *
 * Usage: node scripts/populate-vcs-invoice-numbers.js [--dry-run]
 */

const xmlrpc = require('xmlrpc');
const { MongoClient } = require('mongodb');
require('dotenv').config();

// Odoo connection settings
const ODOO_URL = (process.env.ODOO_URL || 'https://acropaq.odoo.com').replace('https://', '').replace('http://', '');
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_PASSWORD || process.env.ODOO_API_KEY;

// MongoDB connection
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

if (!ODOO_DB || !ODOO_USERNAME || !ODOO_API_KEY) {
  console.error('Missing Odoo credentials in .env file!');
  console.error('Required: ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

// Create XML-RPC clients
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

async function populate() {
  console.log('='.repeat(60));
  console.log('Populate x_vcs_invoice_number from MongoDB VCS data');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
  console.log('');

  // Connect to MongoDB
  console.log('Connecting to MongoDB...');
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  console.log('Connected to MongoDB');
  console.log('');

  // Authenticate with Odoo
  console.log('Connecting to Odoo...');
  const uid = await authenticate();
  console.log(`Authenticated as user ID: ${uid}`);
  console.log('');

  // Get all VCS orders with vatInvoiceNumber and odooInvoiceId
  console.log('Finding VCS orders with vatInvoiceNumber and odooInvoiceId...');
  const vcsOrders = await db.collection('amazon_vcs_orders').find({
    vatInvoiceNumber: { $exists: true, $ne: null, $ne: '' },
    odooInvoiceId: { $exists: true, $ne: null }
  }).toArray();

  console.log(`Found ${vcsOrders.length} VCS orders to process`);
  console.log('');

  if (vcsOrders.length === 0) {
    console.log('Nothing to process!');
    await mongoClient.close();
    return;
  }

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches
  const batchSize = 50;
  for (let i = 0; i < vcsOrders.length; i += batchSize) {
    const batch = vcsOrders.slice(i, i + batchSize);

    for (const order of batch) {
      try {
        // Check if invoice exists and needs updating
        const invoice = await execute(uid, 'account.move', 'search_read', [
          [['id', '=', order.odooInvoiceId]]
        ], { fields: ['id', 'name', 'x_vcs_invoice_number'] });

        if (invoice.length === 0) {
          console.log(`  Invoice ID ${order.odooInvoiceId} not found - skipping`);
          skipped++;
          continue;
        }

        // Skip if already has the correct value
        if (invoice[0].x_vcs_invoice_number === order.vatInvoiceNumber) {
          skipped++;
          continue;
        }

        if (!dryRun) {
          await execute(uid, 'account.move', 'write', [[order.odooInvoiceId], {
            x_vcs_invoice_number: order.vatInvoiceNumber
          }]);
        }

        updated++;

        if (updated % 100 === 0) {
          console.log(`  Progress: ${updated} updated, ${skipped} skipped`);
        }
      } catch (error) {
        errors++;
        console.error(`  ERROR processing order ${order.orderId}: ${error.message}`);
      }
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Total processed: ${vcsOrders.length}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped (already set): ${skipped}`);
  console.log(`Errors: ${errors}`);

  if (dryRun) {
    console.log('');
    console.log('This was a DRY RUN. No changes were made.');
    console.log('Run without --dry-run to apply changes.');
  }

  await mongoClient.close();
}

populate().catch(err => {
  console.error('Population failed:', err);
  process.exit(1);
});
