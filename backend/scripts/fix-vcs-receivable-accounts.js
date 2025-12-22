/**
 * Fix receivable accounts for all VCS invoices
 *
 * This script:
 * 1. Gets all VCS invoices from Odoo (those with x_vcs_invoice_url set)
 * 2. Matches them with MongoDB to get the marketplace
 * 3. Checks if the receivable line has the correct marketplace-specific account
 * 4. Updates the ones that have wrong accounts
 */

const xmlrpc = require('xmlrpc');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const ODOO_URL = (process.env.ODOO_URL || 'https://acropaq.odoo.com').replace('https://', '').replace('http://', '');
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_PASSWORD || process.env.ODOO_API_KEY;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

// Marketplace receivable accounts (same as in VcsOdooInvoicer)
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

// Default receivable account that needs to be replaced
const DEFAULT_RECEIVABLE_ACCOUNT = 180; // 400000 Trade debtors within one year - Customer

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

  // Get all VCS invoices from Odoo (those with x_vcs_invoice_url set)
  console.log('\nFetching VCS invoices from Odoo...');
  const invoices = await execute(uid, 'account.move', 'search_read', [
    [['x_vcs_invoice_url', '!=', false], ['state', '=', 'draft']]
  ], {
    fields: ['id', 'name', 'move_type', 'invoice_origin'],
    limit: 5000
  });
  console.log(`Found ${invoices.length} draft VCS invoices/credit notes`);

  // Build a map of Amazon order IDs to marketplaces from MongoDB
  console.log('\nBuilding marketplace map from MongoDB...');
  const vcsOrders = await db.collection('amazon_vcs_orders').find({
    status: { $in: ['invoiced', 'credit_noted', 'pending'] }
  }, {
    projection: { orderId: 1, marketplaceId: 1, odooInvoiceId: 1 }
  }).toArray();

  const marketplaceMap = {};
  const invoiceIdToMarketplace = {};

  for (const order of vcsOrders) {
    // Store by orderId (without FBA/FBM prefix)
    const cleanOrderId = order.orderId.replace(/^(FBA|FBM)/, '');
    marketplaceMap[cleanOrderId] = order.marketplaceId;
    marketplaceMap[order.orderId] = order.marketplaceId;

    // Also store by Odoo invoice ID if available
    if (order.odooInvoiceId) {
      invoiceIdToMarketplace[order.odooInvoiceId] = order.marketplaceId;
    }
  }
  console.log(`Built marketplace map with ${Object.keys(marketplaceMap).length} orders`);

  // Check each invoice's receivable line
  let needsUpdate = 0;
  let alreadyCorrect = 0;
  let noMarketplace = 0;
  let updated = 0;
  let errors = 0;

  const toUpdate = [];

  for (const invoice of invoices) {
    // Get marketplace from origin or invoice ID
    const origin = invoice.invoice_origin || '';
    const cleanOrigin = origin.replace(/^(FBA|FBM)/, '');

    let marketplace = invoiceIdToMarketplace[invoice.id] ||
                      marketplaceMap[origin] ||
                      marketplaceMap[cleanOrigin];

    if (!marketplace) {
      // Try to find by partial match
      for (const [orderId, mp] of Object.entries(marketplaceMap)) {
        if (orderId.includes(cleanOrigin) || cleanOrigin.includes(orderId)) {
          marketplace = mp;
          break;
        }
      }
    }

    if (!marketplace) {
      noMarketplace++;
      continue;
    }

    const expectedAccountId = MARKETPLACE_RECEIVABLE_ACCOUNTS[marketplace];
    if (!expectedAccountId) {
      noMarketplace++;
      continue;
    }

    // Get the receivable line for this invoice
    const lines = await execute(uid, 'account.move.line', 'search_read', [
      [['move_id', '=', invoice.id]]
    ], {
      fields: ['id', 'account_id', 'account_type']
    });

    const receivableLine = lines.find(l =>
      l.account_type === 'asset_receivable' ||
      (l.account_id && l.account_id[0] === DEFAULT_RECEIVABLE_ACCOUNT)
    );

    if (!receivableLine) {
      continue;
    }

    const currentAccountId = receivableLine.account_id[0];

    if (currentAccountId === expectedAccountId) {
      alreadyCorrect++;
    } else {
      needsUpdate++;
      toUpdate.push({
        invoiceId: invoice.id,
        origin: origin,
        marketplace: marketplace,
        lineId: receivableLine.id,
        currentAccount: receivableLine.account_id,
        expectedAccountId: expectedAccountId
      });
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`Need update: ${needsUpdate}`);
  console.log(`No marketplace found: ${noMarketplace}`);

  if (toUpdate.length > 0) {
    console.log('\n=== Invoices to Update ===');
    for (const item of toUpdate.slice(0, 20)) {
      console.log(`  Invoice ${item.invoiceId} (${item.origin}): ${item.marketplace} | ${item.currentAccount[1]} -> Account ${item.expectedAccountId}`);
    }
    if (toUpdate.length > 20) {
      console.log(`  ... and ${toUpdate.length - 20} more`);
    }

    if (!dryRun) {
      console.log('\n=== Updating receivable accounts ===');

      for (const item of toUpdate) {
        try {
          await execute(uid, 'account.move.line', 'write', [[item.lineId], {
            account_id: item.expectedAccountId
          }]);
          updated++;

          if (updated % 50 === 0) {
            console.log(`  Updated ${updated}/${toUpdate.length}...`);
          }
        } catch (error) {
          errors++;
          console.error(`  Error updating invoice ${item.invoiceId}: ${error.message}`);
        }
      }

      console.log(`\nCompleted: Updated ${updated}, Errors ${errors}`);
    } else {
      console.log('\n=== Dry run - no changes made ===');
      console.log(`Would update ${toUpdate.length} invoices`);
    }
  }

  await mongoClient.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
