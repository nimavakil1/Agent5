/**
 * Update receivable accounts for VCS invoices to use marketplace-specific accounts
 *
 * This script updates all draft invoices/credit notes created by Agent5
 * to use the correct marketplace-specific receivable account (400102XX)
 */

const xmlrpc = require('xmlrpc');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const ODOO_URL = (process.env.ODOO_URL || 'https://acropaq.odoo.com').replace('https://', '').replace('http://', '');
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_PASSWORD || process.env.ODOO_API_KEY;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

// Marketplace receivable accounts
const MARKETPLACE_RECEIVABLE_ACCOUNTS = {
  'DE': 820,  // 400102DE
  'FR': 821,  // 400102FR
  'NL': 822,  // 400102NL
  'ES': 823,  // 400102ES
  'IT': 824,  // 400102IT
  'SE': 825,  // 400102SE
  'PL': 826,  // 400102PL
  'GB': 827,  // 400102UK
  'UK': 827,
  'BE': 828,  // 400102BE
  'TR': 829,  // 400102TR
};

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
  // Connect to MongoDB to get marketplace info
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  console.log('Connected to MongoDB');

  const uid = await authenticate();
  console.log('Connected to Odoo');

  // Get all draft invoices with x_vcs_invoice_url
  const invoices = await execute(uid, 'account.move', 'search_read', [
    [
      ['x_vcs_invoice_url', '!=', false],
      ['state', '=', 'draft']
    ]
  ], {
    fields: ['id', 'name', 'move_type', 'invoice_origin'],
    limit: 500
  });

  console.log(`\nFound ${invoices.length} draft invoices to update\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const invoice of invoices) {
    try {
      // Extract Amazon order ID from invoice_origin (strip FBA/FBM prefix)
      const origin = invoice.invoice_origin || '';
      let amazonOrderId = origin;
      if (origin.startsWith('FBA') || origin.startsWith('FBM')) {
        amazonOrderId = origin.substring(3);
      }

      // Find VCS order in MongoDB
      const vcsOrder = await db.collection('amazon_vcs_orders').findOne({
        orderId: { $regex: amazonOrderId }
      });

      if (!vcsOrder) {
        console.log(`  ${invoice.id}: No VCS order found for ${amazonOrderId}`);
        skipped++;
        continue;
      }

      const marketplace = vcsOrder.marketplaceId;
      const accountId = MARKETPLACE_RECEIVABLE_ACCOUNTS[marketplace];

      if (!accountId) {
        console.log(`  ${invoice.id}: No account for marketplace ${marketplace}`);
        skipped++;
        continue;
      }

      // Find and update the receivable line
      const allLines = await execute(uid, 'account.move.line', 'search_read', [
        [['move_id', '=', invoice.id]]
      ], {
        fields: ['id', 'account_id', 'account_type']
      });

      const receivableLine = allLines.find(line =>
        line.account_type === 'asset_receivable' ||
        (line.account_id && line.account_id[1] && line.account_id[1].includes('400'))
      );

      if (receivableLine) {
        // Check if already correct
        if (receivableLine.account_id[0] === accountId) {
          skipped++;
          continue; // Already correct
        }

        await execute(uid, 'account.move.line', 'write', [[receivableLine.id], {
          account_id: accountId
        }]);
        updated++;
        console.log(`  Updated invoice ${invoice.id} (${amazonOrderId}) -> marketplace ${marketplace} -> account ${accountId}`);
      }

    } catch (error) {
      errors++;
      console.error(`  Error on invoice ${invoice.id}: ${error.message}`);
    }
  }

  // Also update the credit note (ID 357022)
  console.log('\nUpdating credit note 357022...');
  try {
    const creditNoteLines = await execute(uid, 'account.move.line', 'search_read', [
      [['move_id', '=', 357022]]
    ], {
      fields: ['id', 'account_id', 'account_type']
    });

    const cnReceivable = creditNoteLines.find(line =>
      line.account_type === 'asset_receivable' ||
      (line.account_id && line.account_id[1] && line.account_id[1].includes('400'))
    );

    if (cnReceivable) {
      // The return was for FR marketplace
      const frAccountId = MARKETPLACE_RECEIVABLE_ACCOUNTS['FR'];
      if (cnReceivable.account_id[0] !== frAccountId) {
        await execute(uid, 'account.move.line', 'write', [[cnReceivable.id], {
          account_id: frAccountId
        }]);
        console.log(`  Updated credit note 357022 receivable line to FR account ${frAccountId}`);
        updated++;
      } else {
        console.log(`  Credit note 357022 already has correct FR account`);
      }
    }
  } catch (error) {
    console.error(`  Error updating credit note: ${error.message}`);
    errors++;
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Summary: Updated ${updated}, Skipped ${skipped}, Errors ${errors}`);

  await mongoClient.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
