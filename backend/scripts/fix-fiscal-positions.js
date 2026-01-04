/**
 * Fix missing fiscal positions on Amazon Seller invoices
 * Uses VCS data from MongoDB to determine correct fiscal position
 *
 * Usage:
 *   ODOO_URL=... ODOO_DB=... ODOO_USERNAME=... ODOO_PASSWORD=... node scripts/fix-fiscal-positions.js
 *
 * Options:
 *   --dry-run    Show what would be updated without making changes
 *   --limit=N    Only process N invoices
 */

const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { MongoClient } = require('mongodb');

// EU countries
const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

// OSS Fiscal Position IDs by destination country
const OSS_FISCAL_POSITIONS = {
  'AT': 6,   // AT*OSS | B2C Austria
  'BG': 7,   // BG*OSS | B2C Bulgaria
  'HR': 8,   // HR*OSS | B2C Croatia
  'CY': 9,   // CY*OSS | B2C Cyprus
  'CZ': 10,  // CZ*OSS | B2C Czech Republic
  'DK': 11,  // DK*OSS | B2C Denmark
  'EE': 12,  // EE*OSS | B2C Estonia
  'FI': 13,  // FI*OSS | B2C Finland
  'FR': 14,  // FR*OSS | B2C France
  'DE': 15,  // DE*OSS | B2C Germany
  'GR': 16,  // GR*OSS | B2C Greece
  'HU': 17,  // HU*OSS | B2C Hungary
  'IE': 18,  // IE*OSS | B2C Ireland
  'IT': 19,  // IT*OSS | B2C Italy
  'LV': 20,  // LV*OSS | B2C Latvia
  'LT': 21,  // LT*OSS | B2C Lithuania
  'LU': 22,  // LU*OSS | B2C Luxembourg
  'MT': 23,  // MT*OSS | B2C Malta
  'NL': 24,  // NL*OSS | B2C Netherlands
  'PL': 25,  // PL*OSS | B2C Poland
  'PT': 26,  // PT*OSS | B2C Portugal
  'RO': 27,  // RO*OSS | B2C Romania
  'SK': 28,  // SK*OSS | B2C Slovakia
  'SI': 29,  // SI*OSS | B2C Slovenia
  'ES': 30,  // ES*OSS | B2C Spain
  'SE': 31,  // SE*OSS | B2C Sweden
  'BE': 35,  // BE*OSS | B2C Belgium
};

// Domestic Fiscal Position IDs
const DOMESTIC_FISCAL_POSITIONS = {
  'DE': 32,  // DE*VAT | Régime National
  'FR': 33,  // FR*VAT | Régime National
  'IT': 34,  // IT*VAT | Régime National
  'BE': 1,   // BE*VAT | Régime National
};

// B2B Intra-EU Fiscal Position
const B2B_INTRA_EU_FP = 2;

// Export (non-EU) Fiscal Position
const EXPORT_FP = 3;

// Amazon Seller team IDs
const AMAZON_SELLER_TEAM_IDS = [11, 5, 25, 24, 17, 18, 19, 20, 21, 22, 16];

/**
 * Determine fiscal position based on VCS data
 */
function determineFiscalPosition(vcs) {
  const shipFrom = vcs.shipFromCountry;
  const shipTo = vcs.shipToCountry;
  const hasBuyerVat = !!vcs.buyerTaxRegistration;

  // Export to non-EU country
  if (!EU_COUNTRIES.includes(shipTo)) {
    return { id: EXPORT_FP, name: 'Export (non-EU)' };
  }

  // Domestic sale (same country)
  if (shipFrom === shipTo && EU_COUNTRIES.includes(shipTo)) {
    const fpId = DOMESTIC_FISCAL_POSITIONS[shipTo];
    if (fpId) {
      return { id: fpId, name: `${shipTo}*VAT Domestic` };
    }
    return null; // No domestic FP defined for this country
  }

  // Cross-border EU
  if (EU_COUNTRIES.includes(shipFrom) && EU_COUNTRIES.includes(shipTo) && shipFrom !== shipTo) {
    // B2B with buyer VAT
    if (hasBuyerVat) {
      return { id: B2B_INTRA_EU_FP, name: 'B2B Intra-EU' };
    }
    // B2C - OSS
    const fpId = OSS_FISCAL_POSITIONS[shipTo];
    if (fpId) {
      return { id: fpId, name: `${shipTo}*OSS B2C` };
    }
  }

  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

  console.log('=== Fix Missing Fiscal Positions ===\n');
  console.log('Mode:', dryRun ? 'DRY RUN (no changes)' : 'LIVE (will update)');
  if (limit) console.log('Limit:', limit, 'invoices');
  console.log('');

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const mongo = new MongoClient(mongoUri);
  await mongo.connect();
  const db = mongo.db('agent5');
  console.log('Connected to MongoDB');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Build VCS index
  console.log('\nBuilding VCS index...');
  const vcsOrders = await db.collection('amazon_vcs_orders').find({}).toArray();
  const vcsIndex = {};
  for (const vcs of vcsOrders) {
    vcsIndex[vcs.orderId] = vcs;
  }
  console.log('VCS orders indexed:', Object.keys(vcsIndex).length);

  // Fetch invoices without fiscal position
  console.log('\nFetching invoices without fiscal position...');
  let allInvoices = [];
  let offset = 0;

  while (true) {
    const batch = await odoo.searchRead('account.move',
      [
        ['move_type', '=', 'out_invoice'],
        ['team_id', 'in', AMAZON_SELLER_TEAM_IDS],
        ['fiscal_position_id', '=', false],
        ['state', '=', 'posted']
      ],
      ['id', 'name', 'ref'],
      { limit: 2000, offset }
    );

    if (batch.length === 0) break;
    allInvoices = allInvoices.concat(batch);
    offset += batch.length;

    if (limit && allInvoices.length >= limit) {
      allInvoices = allInvoices.slice(0, limit);
      break;
    }
    if (batch.length < 2000) break;
  }

  console.log('Invoices to process:', allInvoices.length);

  // Process invoices
  const stats = {
    updated: 0,
    skipped_no_vcs: 0,
    skipped_no_fp: 0,
    errors: 0,
    byFiscalPosition: {}
  };

  console.log('\nProcessing invoices...\n');

  for (let i = 0; i < allInvoices.length; i++) {
    const inv = allInvoices[i];
    const orderId = inv.ref;

    // Get VCS data
    const vcs = vcsIndex[orderId];
    if (!vcs) {
      stats.skipped_no_vcs++;
      continue;
    }

    // Determine fiscal position
    const fp = determineFiscalPosition(vcs);
    if (!fp) {
      stats.skipped_no_fp++;
      continue;
    }

    // Track by fiscal position
    stats.byFiscalPosition[fp.name] = (stats.byFiscalPosition[fp.name] || 0) + 1;

    // Update invoice
    if (!dryRun) {
      try {
        await odoo.write('account.move', [inv.id], {
          fiscal_position_id: fp.id
        });
        stats.updated++;
      } catch (err) {
        console.error(`Error updating ${inv.name}:`, err.message);
        stats.errors++;
      }
    } else {
      stats.updated++;
    }

    // Progress
    if ((i + 1) % 500 === 0) {
      console.log(`Processed: ${i + 1} | Updated: ${stats.updated} | Skipped (no VCS): ${stats.skipped_no_vcs}`);
    }
  }

  // Final report
  console.log('\n=== RESULTS ===\n');
  console.log('Total processed:', allInvoices.length);
  console.log('Updated:', stats.updated, dryRun ? '(dry run)' : '');
  console.log('Skipped (no VCS data):', stats.skipped_no_vcs);
  console.log('Skipped (no FP match):', stats.skipped_no_fp);
  console.log('Errors:', stats.errors);

  console.log('\nBy Fiscal Position:');
  const sorted = Object.entries(stats.byFiscalPosition).sort((a, b) => b[1] - a[1]);
  for (const [fp, count] of sorted) {
    console.log(`  ${fp}: ${count}`);
  }

  await mongo.close();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
