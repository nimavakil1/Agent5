/**
 * Migration script: Copy VCS data from Amazon EPT fields to Acropaq fields
 *
 * This script copies:
 * - invoice_url -> x_vcs_invoice_url
 * - vcs_invoice_number -> x_vcs_invoice_number
 *
 * Run this AFTER creating the x_vcs_invoice_url field in Odoo.
 *
 * Usage: node scripts/migrate-vcs-fields-to-acropaq.js [--dry-run]
 */

const xmlrpc = require('xmlrpc');
require('dotenv').config();

// Odoo connection settings - from .env file
const ODOO_URL = (process.env.ODOO_URL || 'https://acropaq.odoo.com').replace('https://', '').replace('http://', '');
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;  // Should be info@acropaq.com
const ODOO_API_KEY = process.env.ODOO_PASSWORD || process.env.ODOO_API_KEY;

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

async function migrate() {
  console.log('='.repeat(60));
  console.log('VCS Fields Migration: Amazon EPT -> Acropaq');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
  console.log('');

  // Authenticate
  console.log('Connecting to Odoo...');
  const uid = await authenticate();
  console.log(`Authenticated as user ID: ${uid}`);
  console.log('');

  // First check if our new fields exist
  console.log('Checking if x_vcs_invoice_url field exists...');
  try {
    const testRead = await execute(uid, 'account.move', 'search_read', [
      [['id', '=', 1]],
    ], { fields: ['x_vcs_invoice_url'], limit: 1 });
    console.log('Field x_vcs_invoice_url exists!');
  } catch (error) {
    console.error('ERROR: Field x_vcs_invoice_url does not exist!');
    console.error('Please install the acropaq_amazon module first.');
    process.exit(1);
  }

  // Find all invoices with invoice_url set (from Amazon EPT)
  console.log('');
  console.log('Finding invoices with Amazon EPT invoice_url...');

  const invoices = await execute(uid, 'account.move', 'search_read', [
    [
      ['invoice_url', '!=', false],
      ['invoice_url', '!=', ''],
    ],
  ], {
    // Note: Only requesting fields that exist
    // x_vcs_invoice_url is our new independent field
    // invoice_url is from Amazon EPT (the source to migrate from)
    fields: ['id', 'name', 'invoice_url', 'x_vcs_invoice_url'],
    limit: 5000
  });

  console.log(`Found ${invoices.length} invoices with Amazon EPT invoice_url`);
  console.log('');

  // Filter: only migrate those that don't already have x_vcs_invoice_url set
  const toMigrate = invoices.filter(inv => !inv.x_vcs_invoice_url);
  const alreadyMigrated = invoices.length - toMigrate.length;

  console.log(`Already migrated: ${alreadyMigrated}`);
  console.log(`To migrate: ${toMigrate.length}`);
  console.log('');

  if (toMigrate.length === 0) {
    console.log('Nothing to migrate!');
    return;
  }

  // Migrate in batches
  const batchSize = 100;
  let migrated = 0;
  let errors = 0;

  console.log(`Migrating ${toMigrate.length} invoices...`);
  console.log('');

  for (let i = 0; i < toMigrate.length; i += batchSize) {
    const batch = toMigrate.slice(i, i + batchSize);

    for (const invoice of batch) {
      try {
        // Only migrate invoice_url -> x_vcs_invoice_url
        const updateData = {
          x_vcs_invoice_url: invoice.invoice_url,
        };

        if (!dryRun) {
          await execute(uid, 'account.move', 'write', [[invoice.id], updateData]);
        }

        migrated++;

        if (migrated % 100 === 0 || migrated === toMigrate.length) {
          console.log(`  Progress: ${migrated}/${toMigrate.length}`);
        }
      } catch (error) {
        errors++;
        console.error(`  ERROR migrating invoice ${invoice.name} (ID ${invoice.id}): ${error.message}`);
      }
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Migration Summary');
  console.log('='.repeat(60));
  console.log(`Total found: ${invoices.length}`);
  console.log(`Already migrated: ${alreadyMigrated}`);
  console.log(`Successfully migrated: ${migrated}`);
  console.log(`Errors: ${errors}`);

  if (dryRun) {
    console.log('');
    console.log('This was a DRY RUN. No changes were made.');
    console.log('Run without --dry-run to apply changes.');
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
