/**
 * Fix Sales Teams on Odoo Orders using VCS CSV Data
 *
 * Reads marketplace info from VCS CSV tax reports and updates
 * the sales team on corresponding Odoo orders.
 *
 * Usage:
 *   node scripts/fix-sales-teams-from-csv.js --dry-run    # Preview only
 *   node scripts/fix-sales-teams-from-csv.js --limit=100  # Process first 100
 *   node scripts/fix-sales-teams-from-csv.js              # Process all
 */

const fs = require('fs');
const path = require('path');
const xmlrpc = require('xmlrpc');
require('dotenv').config();

// VCS CSV files - include all available VCS reports
const CSV_FILES = [
  '/Users/nimavakil/Downloads/taxReport_b930c16923c5d7ee8719dd58ee705deae651fc97.csv',
  '/Users/nimavakil/Downloads/taxReport_26d500b6286a5da5e0ede3254acfeb0aa7455fa5.csv',
  '/Users/nimavakil/Downloads/taxReport_0698c52b1096d6836af13897b3fb83b0875c5f69.csv',
  '/Users/nimavakil/Downloads/taxReport_215e247ebb3e44932a7391b91f0bce17ab440acb.csv',
  '/Users/nimavakil/Downloads/taxReport_6cdc49eebf63e0c86f966447c7b8b89e7163613f.csv',
  '/Users/nimavakil/Downloads/taxReport_c317843f8031538f43ebf1cb5e8d5f371c8cfa02.csv',
  '/Users/nimavakil/Downloads/taxReport_ef71dfc433c6059a4c81088ea67abfdfac140cc0.csv',
];

// Odoo connection
const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

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
  host: ODOO_URL,
  port: 443,
  path: '/xmlrpc/2/common'
});
const objectClient = xmlrpc.createSecureClient({
  host: ODOO_URL,
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
 * Parse CSV line handling quoted fields
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

/**
 * Parse VCS CSV file and extract Order ID -> Marketplace mapping
 */
function parseVcsCsvFile(filePath) {
  console.log(`  Reading ${path.basename(filePath)}...`);

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const orderMarketplaceMap = new Map();
  let skipped = 0;

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);

    // Column 0: Marketplace ID (e.g., GB, DE, FR)
    // Column 5: Order ID (e.g., 206-5957787-6786710)
    const marketplace = fields[0];
    const orderId = fields[5];

    if (!marketplace || !orderId) {
      skipped++;
      continue;
    }

    // Only store if we don't have this order yet (first occurrence wins)
    if (!orderMarketplaceMap.has(orderId)) {
      orderMarketplaceMap.set(orderId, marketplace);
    }
  }

  console.log(`    Parsed ${orderMarketplaceMap.size} unique orders (${skipped} lines skipped)`);
  return orderMarketplaceMap;
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

  console.log('='.repeat(60));
  console.log('Fix Sales Teams from VCS CSV Data');
  console.log('='.repeat(60));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');
  if (limit) console.log(`*** LIMITED TO ${limit} RECORDS ***\n`);

  // Parse VCS CSV files
  console.log('Parsing VCS CSV files...');
  const orderMarketplaceMap = new Map();

  for (const csvFile of CSV_FILES) {
    if (fs.existsSync(csvFile)) {
      const fileMap = parseVcsCsvFile(csvFile);
      for (const [orderId, marketplace] of fileMap) {
        if (!orderMarketplaceMap.has(orderId)) {
          orderMarketplaceMap.set(orderId, marketplace);
        }
      }
    } else {
      console.log(`  WARNING: File not found: ${csvFile}`);
    }
  }

  console.log(`\nTotal unique orders from VCS: ${orderMarketplaceMap.size}`);

  // Show marketplace distribution
  const marketplaceCount = {};
  for (const mp of orderMarketplaceMap.values()) {
    marketplaceCount[mp] = (marketplaceCount[mp] || 0) + 1;
  }
  console.log('\nMarketplace distribution:');
  for (const [mp, count] of Object.entries(marketplaceCount).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${mp}: ${count}`);
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
    fields: ['id', 'name', 'amz_order_reference', 'team_id'],
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
  const notFoundSample = [];

  // Process each order
  for (let i = 0; i < wrongTeamOrders.length; i++) {
    const order = wrongTeamOrders[i];
    // Use amz_order_reference field - this is the pure Amazon order ID
    const amazonOrderId = order.amz_order_reference;

    try {
      // Look up marketplace in VCS data
      const marketplace = orderMarketplaceMap.get(amazonOrderId);

      if (!marketplace) {
        stats.notInVcs++;
        if (notFoundSample.length < 10) {
          notFoundSample.push(amazonOrderId);
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

      if (stats.updated <= 20 || stats.updated % 500 === 0) {
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

  if (notFoundSample.length > 0) {
    console.log('\nSample orders NOT in VCS (first 10):');
    notFoundSample.forEach(id => console.log(`  - ${id}`));
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
