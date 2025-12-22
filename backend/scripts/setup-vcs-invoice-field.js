/**
 * Setup VCS Invoice URL field in Odoo
 *
 * This script:
 * 1. Creates the x_vcs_invoice_url field on account.move (if not exists)
 * 2. Adds the field to the invoice form view
 *
 * No Odoo module required - just direct field and view modifications.
 *
 * Usage: node scripts/setup-vcs-invoice-field.js
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

async function setup() {
  console.log('='.repeat(60));
  console.log('Setup VCS Invoice URL Field in Odoo');
  console.log('='.repeat(60));
  console.log('');

  // Authenticate
  console.log('Connecting to Odoo...');
  const uid = await authenticate();
  console.log(`Authenticated as user ID: ${uid}`);
  console.log('');

  // Step 1: Get the account.move model ID
  console.log('Step 1: Finding account.move model...');
  const models = await execute(uid, 'ir.model', 'search_read', [
    [['model', '=', 'account.move']]
  ], { fields: ['id', 'name', 'model'] });

  if (models.length === 0) {
    throw new Error('account.move model not found!');
  }
  const accountMoveModelId = models[0].id;
  console.log(`Found account.move model ID: ${accountMoveModelId}`);
  console.log('');

  // Step 2: Check if field already exists
  console.log('Step 2: Checking if x_vcs_invoice_url field exists...');
  const existingFields = await execute(uid, 'ir.model.fields', 'search_read', [
    [['model', '=', 'account.move'], ['name', '=', 'x_vcs_invoice_url']]
  ], { fields: ['id', 'name', 'field_description'] });

  let fieldId;
  if (existingFields.length > 0) {
    fieldId = existingFields[0].id;
    console.log(`Field already exists with ID: ${fieldId}`);
  } else {
    // Create the field
    console.log('Creating x_vcs_invoice_url field...');
    fieldId = await execute(uid, 'ir.model.fields', 'create', [{
      name: 'x_vcs_invoice_url',
      model_id: accountMoveModelId,
      field_description: 'VCS Invoice URL',
      ttype: 'char',
      copied: false,
      store: true,
    }]);
    console.log(`Created field with ID: ${fieldId}`);
  }
  console.log('');

  // Step 3: Find the Amazon EPT inherited view that has invoice_url
  // We'll modify that view directly to also show x_vcs_invoice_url
  console.log('Step 3: Finding Amazon EPT invoice view...');
  const eptViews = await execute(uid, 'ir.ui.view', 'search_read', [
    [['model', '=', 'account.move'], ['name', 'ilike', 'ept']]
  ], { fields: ['id', 'name', 'arch_db'] });

  console.log(`Found ${eptViews.length} EPT views for account.move`);
  for (const v of eptViews) {
    console.log(`  - ${v.name} (ID: ${v.id})`);
  }
  console.log('');

  // Also find the main invoice form view
  console.log('Finding main invoice form view...');
  const mainViews = await execute(uid, 'ir.ui.view', 'search_read', [
    [['model', '=', 'account.move'], ['type', '=', 'form'], ['inherit_id', '=', false]]
  ], { fields: ['id', 'name', 'arch_db'], limit: 10 });

  for (const v of mainViews) {
    console.log(`  - ${v.name} (ID: ${v.id})`);
  }
  console.log('');

  // Find view that contains invoice_url (to understand where it's placed)
  const viewWithInvoiceUrl = eptViews.find(v => v.arch_db && v.arch_db.includes('invoice_url'));
  if (viewWithInvoiceUrl) {
    console.log(`Found view with invoice_url: ${viewWithInvoiceUrl.name} (ID: ${viewWithInvoiceUrl.id})`);
    console.log('Current arch:');
    console.log(viewWithInvoiceUrl.arch_db);
    console.log('');

    // Add x_vcs_invoice_url next to invoice_url in the same view
    if (!viewWithInvoiceUrl.arch_db.includes('x_vcs_invoice_url')) {
      console.log('Adding x_vcs_invoice_url to the view...');
      const newArch = viewWithInvoiceUrl.arch_db.replace(
        '<field name="invoice_url"',
        '<field name="x_vcs_invoice_url" widget="url" readonly="1"/>\n                <field name="invoice_url"'
      );

      await execute(uid, 'ir.ui.view', 'write', [[viewWithInvoiceUrl.id], {
        arch_db: newArch
      }]);
      console.log('View updated!');
    } else {
      console.log('x_vcs_invoice_url already in the view');
    }
  } else {
    console.log('No view found with invoice_url field.');
    console.log('');
    console.log('To add the field manually:');
    console.log('1. Go to Settings → Technical → User Interface → Views');
    console.log('2. Search for "account.move" form views');
    console.log('3. Edit the arch XML to add: <field name="x_vcs_invoice_url" widget="url" readonly="1"/>');
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Setup Complete!');
  console.log('='.repeat(60));
  console.log('');
  console.log('The x_vcs_invoice_url field is now available on account.move.');
  console.log('Agent5 can read/write this field via XML-RPC.');
}

setup().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
