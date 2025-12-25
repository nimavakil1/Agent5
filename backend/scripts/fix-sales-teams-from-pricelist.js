/**
 * Fix Sales Teams on Odoo Orders using Pricelist Data
 *
 * Uses the pricelist field to determine the marketplace and updates
 * the sales team on corresponding Odoo orders.
 *
 * Usage:
 *   node scripts/fix-sales-teams-from-pricelist.js --dry-run    # Preview only
 *   node scripts/fix-sales-teams-from-pricelist.js --limit=100  # Process first 100
 *   node scripts/fix-sales-teams-from-pricelist.js              # Process all
 */

const xmlrpc = require('xmlrpc');
require('dotenv').config();

// Odoo connection
const ODOO_URL = process.env.ODOO_URL || 'https://acropaq.odoo.com';
const ODOO_DB = process.env.ODOO_DB || 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = process.env.ODOO_USERNAME || 'info@acropaq.com';
const ODOO_PASSWORD = process.env.ODOO_API_KEY || process.env.ODOO_PASSWORD;

// Pricelist ID to Sales Team ID mapping
// These IDs need to be discovered first
const PRICELIST_TO_TEAM = {};

// Marketplace to Sales Team ID mapping (for reference)
const MARKETPLACE_TO_TEAM = {
  'de': 17,  // Amazon DE (Marketplace)
  'fr': 19,  // Amazon FR (Marketplace)
  'it': 20,  // Amazon IT (Marketplace)
  'be': 16,  // Amazon BE (Marketplace)
  'es': 18,  // Amazon ES (Marketplace)
  'nl': 21,  // Amazon NL (Marketplace)
  'uk': 25,  // Amazon UK (Marketplace)
  'pl': 22,  // Amazon PL (Marketplace)
  'se': 24,  // Amazon SE (Marketplace)
  'tr': null, // Amazon TR - no team yet
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

/**
 * Parse pricelist name to extract marketplace code
 */
function getMarketplaceFromPricelist(pricelistName) {
  if (!pricelistName) return null;

  const name = pricelistName.toLowerCase();

  if (name.includes('amazon.de')) return 'de';
  if (name.includes('amazon.fr')) return 'fr';
  if (name.includes('amazon.it')) return 'it';
  if (name.includes('amazon.com.be') || name.includes('amazon.be')) return 'be';
  if (name.includes('amazon.es')) return 'es';
  if (name.includes('amazon.nl')) return 'nl';
  if (name.includes('amazon.co.uk') || name.includes('amazon.uk')) return 'uk';
  if (name.includes('amazon.pl')) return 'pl';
  if (name.includes('amazon.se')) return 'se';
  if (name.includes('amazon.com.tr') || name.includes('amazon.tr')) return 'tr';

  return null;
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

  console.log('='.repeat(60));
  console.log('Fix Sales Teams from Pricelist Data');
  console.log('='.repeat(60));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');
  if (limit) console.log(`*** LIMITED TO ${limit} RECORDS ***\n`);

  // Connect to Odoo
  console.log('Connecting to Odoo...');
  uid = await authenticate();
  console.log(`Connected as uid: ${uid}\n`);

  // Get orders with wrong sales team, grouped by pricelist
  console.log('Fetching Odoo orders with "Amazon Seller" team...');
  const pricelistGroups = await execute('sale.order', 'read_group', [
    [['team_id', '=', WRONG_TEAM_ID]]
  ], { fields: ['pricelist_id'], groupby: ['pricelist_id'] });

  console.log('Pricelist distribution:');
  let totalOrders = 0;
  const pricelistMapping = {};

  for (const group of pricelistGroups) {
    const pricelistId = group.pricelist_id ? group.pricelist_id[0] : null;
    const pricelistName = group.pricelist_id ? group.pricelist_id[1] : 'None';
    const count = group.pricelist_id_count;
    const marketplace = getMarketplaceFromPricelist(pricelistName);
    const teamId = marketplace ? MARKETPLACE_TO_TEAM[marketplace] : null;

    console.log(`  ${pricelistName}: ${count} orders → ${marketplace ? marketplace.toUpperCase() : 'SKIP'} → Team ${teamId || 'N/A'}`);

    if (pricelistId && teamId) {
      pricelistMapping[pricelistId] = { name: pricelistName, marketplace, teamId, count };
    }

    totalOrders += count;
  }

  console.log(`\nTotal orders with wrong team: ${totalOrders}`);
  console.log(`Pricelists with valid mapping: ${Object.keys(pricelistMapping).length}`);

  // Statistics
  const stats = {
    processed: 0,
    updated: 0,
    skipped: 0,
    errors: 0
  };

  const byMarketplace = {};

  // Process each pricelist group
  for (const [pricelistId, mapping] of Object.entries(pricelistMapping)) {
    console.log(`\nProcessing ${mapping.name} (${mapping.count} orders) → Team ${mapping.teamId}...`);

    // Get order IDs for this pricelist with wrong team
    const orderIds = await execute('sale.order', 'search', [
      [
        ['team_id', '=', WRONG_TEAM_ID],
        ['pricelist_id', '=', parseInt(pricelistId)]
      ]
    ], { limit: limit || 0 });

    console.log(`  Found ${orderIds.length} orders to update`);

    // Update in batches
    const batchSize = 100;
    for (let i = 0; i < orderIds.length; i += batchSize) {
      const batch = orderIds.slice(i, i + batchSize);

      try {
        if (!dryRun) {
          await execute('sale.order', 'write', [
            batch,
            { team_id: mapping.teamId }
          ]);
        }

        stats.updated += batch.length;
        byMarketplace[mapping.marketplace.toUpperCase()] = (byMarketplace[mapping.marketplace.toUpperCase()] || 0) + batch.length;

        if ((i + batchSize) % 1000 === 0 || i + batchSize >= orderIds.length) {
          console.log(`    ${dryRun ? 'Would update' : 'Updated'} ${Math.min(i + batchSize, orderIds.length)}/${orderIds.length}`);
        }

        // Rate limiting
        await sleep(50);

      } catch (error) {
        stats.errors += batch.length;
        console.error(`    ERROR updating batch: ${error.message}`);
      }

      stats.processed += batch.length;

      // Apply global limit if specified
      if (limit && stats.processed >= limit) {
        console.log(`\nReached global limit of ${limit} records`);
        break;
      }
    }

    // Check global limit
    if (limit && stats.processed >= limit) break;
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total processed: ${stats.processed}`);
  console.log(`Successfully updated: ${stats.updated}`);
  console.log(`Skipped (no mapping): ${stats.skipped}`);
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
