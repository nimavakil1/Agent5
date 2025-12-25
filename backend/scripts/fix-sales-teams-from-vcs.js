/**
 * Fix Sales Teams on Odoo Orders using VCS Marketplace Data
 *
 * Reads marketplace info from MongoDB VCS orders and updates
 * the sales team on corresponding Odoo orders.
 *
 * Usage:
 *   node scripts/fix-sales-teams-from-vcs.js --dry-run    # Preview only
 *   node scripts/fix-sales-teams-from-vcs.js --limit=100  # Process first 100
 *   node scripts/fix-sales-teams-from-vcs.js              # Process all
 */

const { MongoClient } = require('mongodb');
const xmlrpc = require('xmlrpc');
require('dotenv').config();

// Odoo connection
const ODOO_URL = process.env.ODOO_URL || 'https://acropaq.odoo.com';
const ODOO_DB = process.env.ODOO_DB || 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = process.env.ODOO_USERNAME || 'info@acropaq.com';
const ODOO_PASSWORD = process.env.ODOO_API_KEY || process.env.ODOO_PASSWORD;

// Marketplace to Sales Team ID mapping
const MARKETPLACE_TO_TEAM = {
  'DE': 17,  // Amazon DE (Marketplace)
  'FR': 19,  // Amazon FR (Marketplace)
  'IT': 20,  // Amazon IT (Marketplace)
  'BE': 16,  // Amazon BE (Marketplace)
  'ES': 18,  // Amazon ES (Marketplace)
  'NL': 21,  // Amazon NL (Marketplace)
  'GB': 25,  // Amazon UK (Marketplace)
  'UK': 25,  // Amazon UK (Marketplace) - alias
  'PL': 22,  // Amazon PL (Marketplace)
  'SE': 24,  // Amazon SE (Marketplace)
};

const WRONG_TEAM_ID = 11; // "Amazon Seller" - the wrong generic team

const commonClient = xmlrpc.createSecureClient({
  host: ODOO_URL.replace('https://', ''),
  port: 443,
  path: '/xmlrpc/2/common'
});
const objectClient = xmlrpc.createSecureClient({
  host: ODOO_URL.replace('https://', ''),
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
  console.log('Fix Sales Teams from VCS Marketplace Data');
  console.log('='.repeat(60));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');
  if (limit) console.log(`*** LIMITED TO ${limit} RECORDS ***\n`);

  // Connect to MongoDB
  console.log('Connecting to MongoDB...');
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';
  const mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  const db = mongoClient.db();
  console.log('Connected to MongoDB');

  // Get unique order IDs with their marketplace from VCS
  console.log('\nFetching VCS orders with marketplace info...');
  const vcsOrders = await db.collection('amazon_vcs_orders').aggregate([
    { $match: { marketplaceId: { $exists: true, $ne: null } } },
    { $group: {
      _id: '$orderId',
      marketplace: { $first: '$marketplaceId' }
    }},
    { $project: { orderId: '$_id', marketplace: 1, _id: 0 } }
  ]).toArray();

  console.log(`Found ${vcsOrders.length} unique orders with marketplace info`);

  // Build a map of orderId -> marketplace
  const orderMarketplaceMap = new Map();
  for (const order of vcsOrders) {
    orderMarketplaceMap.set(order.orderId, order.marketplace);
  }

  // Connect to Odoo
  console.log('\nConnecting to Odoo...');
  uid = await authenticate();
  console.log(`Connected as uid: ${uid}`);

  // Get orders with wrong sales team
  console.log('\nFetching Odoo orders with "Amazon Seller" team...');
  const wrongTeamOrders = await execute('sale.order', 'search_read', [
    [['team_id', '=', WRONG_TEAM_ID]]
  ], {
    fields: ['id', 'name', 'client_order_ref', 'team_id'],
    limit: limit || 0
  });

  console.log(`Found ${wrongTeamOrders.length} orders with wrong team`);

  // Statistics
  const stats = {
    processed: 0,
    updated: 0,
    notInVcs: 0,
    unknownMarketplace: 0,
    errors: 0
  };

  const byMarketplace = {};

  // Process each order
  for (let i = 0; i < wrongTeamOrders.length; i++) {
    const order = wrongTeamOrders[i];
    let amazonOrderId = order.client_order_ref;

    // Strip common prefixes (FBM, FBA, etc.) to get the pure Amazon order ID
    if (amazonOrderId) {
      amazonOrderId = amazonOrderId.replace(/^(FBM|FBA|AMZ)/, '');
    }

    try {
      // Look up marketplace in VCS data
      const marketplace = orderMarketplaceMap.get(amazonOrderId);

      if (!marketplace) {
        stats.notInVcs++;
        if (stats.notInVcs <= 5) {
          console.log(`  [${i + 1}] ${order.name} (${amazonOrderId}): Not found in VCS data`);
        }
        continue;
      }

      // Get correct team ID
      const correctTeamId = MARKETPLACE_TO_TEAM[marketplace];

      if (!correctTeamId) {
        stats.unknownMarketplace++;
        console.log(`  [${i + 1}] ${order.name}: Unknown marketplace "${marketplace}"`);
        continue;
      }

      // Update the order
      if (!dryRun) {
        await execute('sale.order', 'write', [
          [order.id],
          { team_id: correctTeamId }
        ]);
      }

      stats.updated++;
      byMarketplace[marketplace] = (byMarketplace[marketplace] || 0) + 1;

      if (stats.updated <= 10 || stats.updated % 500 === 0) {
        console.log(`  [${i + 1}/${wrongTeamOrders.length}] ${order.name}: ${dryRun ? 'Would update' : 'Updated'} to ${marketplace} team (ID: ${correctTeamId})`);
      }

      stats.processed++;

      // Rate limiting
      await sleep(30);

      // Progress update
      if ((i + 1) % 1000 === 0) {
        console.log(`\n--- Progress: ${i + 1}/${wrongTeamOrders.length} (${Math.round((i + 1) / wrongTeamOrders.length * 100)}%) ---`);
        console.log(`    Updated: ${stats.updated}, Not in VCS: ${stats.notInVcs}`);
        console.log('');
      }

    } catch (error) {
      stats.errors++;
      console.error(`  [${i + 1}] ${order.name}: ERROR - ${error.message}`);
    }
  }

  // Close MongoDB
  await mongoClient.close();

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total orders with wrong team: ${wrongTeamOrders.length}`);
  console.log(`Successfully updated: ${stats.updated}`);
  console.log(`Not found in VCS: ${stats.notInVcs}`);
  console.log(`Unknown marketplace: ${stats.unknownMarketplace}`);
  console.log(`Errors: ${stats.errors}`);

  console.log('\nUpdates by marketplace:');
  for (const [mp, count] of Object.entries(byMarketplace).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${mp}: ${count}`);
  }

  if (dryRun) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
    console.log('Run without --dry-run to apply changes');
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
