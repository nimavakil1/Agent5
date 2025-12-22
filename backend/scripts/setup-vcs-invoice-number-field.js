/**
 * Setup VCS Invoice Number field in Odoo
 *
 * Creates the x_vcs_invoice_number field on account.move (if not exists)
 * This is our independent field, separate from Amazon EPT's vcs_invoice_number
 *
 * Usage: node scripts/setup-vcs-invoice-number-field.js
 */

const xmlrpc = require('xmlrpc');
require('dotenv').config();

// Odoo connection settings - from .env file
const ODOO_URL = (process.env.ODOO_URL || 'https://acropaq.odoo.com').replace('https://', '').replace('http://', '');
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
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
  console.log('Setup VCS Invoice Number Field in Odoo');
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
  console.log('Step 2: Checking if x_vcs_invoice_number field exists...');
  const existingFields = await execute(uid, 'ir.model.fields', 'search_read', [
    [['model', '=', 'account.move'], ['name', '=', 'x_vcs_invoice_number']]
  ], { fields: ['id', 'name', 'field_description'] });

  let fieldId;
  if (existingFields.length > 0) {
    fieldId = existingFields[0].id;
    console.log(`Field already exists with ID: ${fieldId}`);
  } else {
    // Create the field
    console.log('Creating x_vcs_invoice_number field...');
    fieldId = await execute(uid, 'ir.model.fields', 'create', [{
      name: 'x_vcs_invoice_number',
      model_id: accountMoveModelId,
      field_description: 'VCS Invoice Number',
      ttype: 'char',
      copied: false,
      store: true,
    }]);
    console.log(`Created field with ID: ${fieldId}`);
  }
  console.log('');

  console.log('='.repeat(60));
  console.log('Setup Complete!');
  console.log('='.repeat(60));
  console.log('');
  console.log('The x_vcs_invoice_number field is now available on account.move.');
  console.log('Agent5 can read/write this field via XML-RPC.');
}

setup().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
