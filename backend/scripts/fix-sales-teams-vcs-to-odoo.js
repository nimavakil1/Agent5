/**
 * Fix Sales Teams on Odoo Orders using VCS CSV Data
 *
 * Different approach: Start from VCS orders, find matching Odoo orders,
 * and update their sales team based on VCS marketplace.
 *
 * Usage:
 *   node scripts/fix-sales-teams-vcs-to-odoo.js --dry-run    # Preview only
 *   node scripts/fix-sales-teams-vcs-to-odoo.js --limit=100  # Process first 100
 *   node scripts/fix-sales-teams-vcs-to-odoo.js              # Process all
 */

const fs = require('fs');
const path = require('path');
const xmlrpc = require('xmlrpc');

// VCS CSV files
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
  console.log('Fix Sales Teams - VCS to Odoo');
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

  // Filter to only orders with valid marketplace mapping
  const validOrders = [];
  for (const [orderId, marketplace] of orderMarketplaceMap) {
    const teamId = MARKETPLACE_TO_TEAM[marketplace];
    if (teamId) {
      validOrders.push({ orderId, marketplace, teamId });
    }
  }
  console.log(`Orders with valid team mapping: ${validOrders.length}`);

  // Apply limit if specified
  const toProcess = limit ? validOrders.slice(0, limit) : validOrders;
  console.log(`Orders to process: ${toProcess.length}`);

  // Connect to Odoo
  console.log('\nConnecting to Odoo...');
  uid = await authenticate();
  console.log(`Connected as uid: ${uid}`);

  // Statistics
  const stats = {
    processed: 0,
    updated: 0,
    notFound: 0,
    alreadyCorrect: 0,
    errors: 0
  };

  const byMarketplace = {};

  // Process in batches
  const batchSize = 50;
  console.log(`\nProcessing ${toProcess.length} VCS orders...`);

  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    const orderIds = batch.map(o => o.orderId);

    try {
      // Search for all orders in this batch by amz_order_reference
      const orders = await execute('sale.order', 'search_read', [
        [['amz_order_reference', 'in', orderIds]]
      ], {
        fields: ['id', 'name', 'amz_order_reference', 'team_id']
      });

      // Create a map of amz_order_reference -> order
      const orderMap = new Map();
      for (const order of orders) {
        orderMap.set(order.amz_order_reference, order);
      }

      // Process each VCS order
      for (const vcsOrder of batch) {
        stats.processed++;
        const odooOrder = orderMap.get(vcsOrder.orderId);

        if (!odooOrder) {
          stats.notFound++;
          continue;
        }

        const currentTeamId = odooOrder.team_id ? odooOrder.team_id[0] : null;

        // Check if already has correct team
        if (currentTeamId === vcsOrder.teamId) {
          stats.alreadyCorrect++;
          continue;
        }

        // Only update if currently has wrong team (11) or no team
        if (currentTeamId === WRONG_TEAM_ID || currentTeamId === null) {
          if (!dryRun) {
            await execute('sale.order', 'write', [
              [odooOrder.id],
              { team_id: vcsOrder.teamId }
            ]);
          }
          stats.updated++;
          byMarketplace[vcsOrder.marketplace] = (byMarketplace[vcsOrder.marketplace] || 0) + 1;

          if (stats.updated <= 20 || stats.updated % 500 === 0) {
            console.log(`  [${stats.processed}] ${odooOrder.name}: ${dryRun ? 'Would update' : 'Updated'} to ${vcsOrder.marketplace} (Team ${vcsOrder.teamId})`);
          }
        } else {
          stats.alreadyCorrect++;
        }
      }

      // Rate limiting
      await sleep(100);

      // Progress update
      if ((i + batchSize) % 5000 === 0 || i + batchSize >= toProcess.length) {
        console.log(`\n--- Progress: ${Math.min(i + batchSize, toProcess.length)}/${toProcess.length} (${Math.round((i + batchSize) / toProcess.length * 100)}%) ---`);
        console.log(`    Updated: ${stats.updated}, Not found: ${stats.notFound}, Already correct: ${stats.alreadyCorrect}`);
        console.log('');
      }

    } catch (error) {
      stats.errors += batch.length;
      console.error(`  ERROR processing batch: ${error.message}`);
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total VCS orders processed: ${stats.processed}`);
  console.log(`Successfully updated: ${stats.updated}`);
  console.log(`Not found in Odoo: ${stats.notFound}`);
  console.log(`Already correct team: ${stats.alreadyCorrect}`);
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
