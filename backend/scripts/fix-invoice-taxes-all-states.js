/**
 * Fix Invoice Taxes - All States (Draft & Posted)
 *
 * This script fixes wrong taxes on Amazon Seller invoices by:
 * 1. Finding invoices with BE*VAT 21% that should have local/OSS VAT
 * 2. For draft invoices: directly update the tax
 * 3. For posted invoices: reset to draft, fix tax, re-post
 *
 * Usage:
 *   node scripts/fix-invoice-taxes-all-states.js --dry-run    # Preview only
 *   node scripts/fix-invoice-taxes-all-states.js              # Apply fixes
 */

const xmlrpc = require('xmlrpc');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

const commonClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/common' });
const objectClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/object' });

let uid;

// EU countries
const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

// Standard VAT rates by country
const STANDARD_VAT_RATES = {
  'AT': 20, 'BE': 21, 'BG': 20, 'HR': 25, 'CY': 19, 'CZ': 21, 'DK': 25, 'EE': 22,
  'FI': 24, 'FR': 20, 'DE': 19, 'GR': 24, 'HU': 27, 'IE': 23, 'IT': 22, 'LV': 21,
  'LT': 21, 'LU': 17, 'MT': 18, 'NL': 21, 'PL': 23, 'PT': 23, 'RO': 19, 'SK': 20,
  'SI': 22, 'ES': 21, 'SE': 25, 'GB': 20
};

// Domestic VAT tax IDs by country
const DOMESTIC_TAXES = {
  'BE': { 21: 1, 12: 4, 6: 6, 0: 8 },
  'DE': { 19: 135, 7: 134, 0: 163 },
  'FR': { 20: 122, 5.5: 123, 0: 144 },
  'NL': { 21: 136, 9: 137 },
  'IT': { 22: 180 },
  'CZ': { 21: 187, 15: 189, 10: 191, 0: 193 },
  'PL': { 23: 194, 8: 196, 5: 198, 0: 200 },
  'GB': { 20: 182, 5: 184, 0: 186 },
};

// OSS VAT tax IDs by country
const OSS_TAXES = {
  'AT': { 20: 9 },
  'BG': { 20: 11 },
  'HR': { 25: 13 },
  'CY': { 19: 15 },
  'CZ': { 21: 17, 15: 18, 10: 19, 0: 20 },
  'DK': { 25: 21 },
  'EE': { 22: 23 },
  'FI': { 24: 25 },
  'FR': { 20: 27, 5.5: 28 },
  'DE': { 19: 29, 7: 30 },
  'GR': { 24: 31 },
  'HU': { 27: 33 },
  'IE': { 23: 35 },
  'IT': { 22: 37 },
  'LV': { 21: 39 },
  'LT': { 21: 41 },
  'LU': { 17: 43, 8: 44, 3: 45 },
  'MT': { 18: 47 },
  'NL': { 21: 49, 9: 50 },
  'PL': { 23: 51, 8: 52, 5: 53, 0: 54 },
  'PT': { 23: 55 },
  'RO': { 19: 57 },
  'SK': { 20: 59 },
  'SI': { 22: 61 },
  'ES': { 21: 63 },
  'SE': { 25: 65 },
  'GB': { 20: 67 },
  'BE': { 21: 69 },
};

// Belgian VAT 21% (the wrong one being applied)
const BE_VAT_21 = 1;

function authenticate() {
  return new Promise((resolve, reject) => {
    commonClient.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

function execute(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall('execute_kw', [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs], (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determine correct tax ID from VCS order data
 */
function getCorrectTaxId(vcsOrder) {
  const shipFrom = vcsOrder.shipFromCountry;
  const shipTo = vcsOrder.shipToCountry;
  const totalExcl = Math.abs(vcsOrder.totalExclusive || 0);
  const totalTax = Math.abs(vcsOrder.totalTax || 0);

  // Calculate actual tax rate from VCS data
  let vcsRatePercent = 0;
  if (totalExcl > 0 && totalTax > 0) {
    vcsRatePercent = Math.round((totalTax / totalExcl) * 100);
  }

  // Determine the VAT scenario
  const isOSS = vcsOrder.taxReportingScheme === 'VCS_EU_OSS';
  const isExport = !EU_COUNTRIES.includes(shipTo);
  const isDomestic = shipFrom === shipTo && EU_COUNTRIES.includes(shipTo);
  const isCrossBorderEU = shipFrom !== shipTo && EU_COUNTRIES.includes(shipFrom) && EU_COUNTRIES.includes(shipTo);

  // 1. Export orders - use BE 0% export tax
  if (isExport) {
    const beTaxes = DOMESTIC_TAXES['BE'];
    return beTaxes?.[0] || null;
  }

  // 2. Explicit OSS scheme OR cross-border EU sale
  if (isOSS || isCrossBorderEU) {
    const countryTaxes = OSS_TAXES[shipTo];
    if (countryTaxes) {
      if (countryTaxes[vcsRatePercent]) {
        return countryTaxes[vcsRatePercent];
      }
      const standardRate = STANDARD_VAT_RATES[shipTo];
      if (standardRate && countryTaxes[standardRate]) {
        return countryTaxes[standardRate];
      }
      const rates = Object.keys(countryTaxes);
      if (rates.length > 0) {
        return countryTaxes[rates[0]];
      }
    }
  }

  // 3. Domestic sale (same country) - use domestic VAT
  if (isDomestic) {
    const countryTaxes = DOMESTIC_TAXES[shipTo];
    if (countryTaxes) {
      if (countryTaxes[vcsRatePercent]) {
        return countryTaxes[vcsRatePercent];
      }
      const standardRate = STANDARD_VAT_RATES[shipTo];
      if (standardRate && countryTaxes[standardRate]) {
        return countryTaxes[standardRate];
      }
      const rates = Object.keys(countryTaxes);
      if (rates.length > 0) {
        return countryTaxes[rates[0]];
      }
    }
  }

  return null;
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('='.repeat(70));
  console.log('Fix Invoice Taxes - All States (Draft & Posted)');
  console.log('='.repeat(70));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');

  // Connect to MongoDB
  const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await mongoClient.connect();
  const db = mongoClient.db();

  // Connect to Odoo
  uid = await authenticate();
  console.log('Connected to Odoo and MongoDB\n');

  // Find VCS orders where shipFrom === shipTo (domestic FBA) and have been invoiced
  console.log('Finding domestic FBA orders that may have wrong taxes...\n');

  const domesticOrders = await db.collection('amazon_vcs_orders').find({
    transactionType: 'SHIPMENT',
    status: 'invoiced',
    $expr: { $eq: ['$shipFromCountry', '$shipToCountry'] },
    shipFromCountry: { $in: ['IT', 'DE', 'FR', 'NL', 'PL', 'CZ', 'GB'] },
  }).toArray();

  console.log(`Found ${domesticOrders.length} domestic FBA orders to check\n`);

  const stats = {
    checked: 0,
    draftFixed: 0,
    postedFixed: 0,
    linesFixed: 0,
    skipped: 0,
    errors: 0,
    resetErrors: 0,
    repostErrors: 0,
  };

  for (let i = 0; i < domesticOrders.length; i++) {
    const vcsOrder = domesticOrders[i];
    const amazonOrderId = vcsOrder.orderId;

    try {
      // Find the order in Odoo
      const orders = await execute('sale.order', 'search_read', [
        [['name', 'ilike', amazonOrderId]]
      ], { fields: ['id', 'name', 'invoice_ids'], limit: 1 });

      if (orders.length === 0 || !orders[0].invoice_ids || orders[0].invoice_ids.length === 0) {
        stats.skipped++;
        continue;
      }

      const order = orders[0];
      const invoiceId = order.invoice_ids[0];

      // Get the invoice
      const invoices = await execute('account.move', 'search_read', [
        [['id', '=', invoiceId]]
      ], { fields: ['id', 'name', 'state'] });

      if (invoices.length === 0) {
        stats.skipped++;
        continue;
      }

      const invoice = invoices[0];
      const isPosted = invoice.state === 'posted';
      const isDraft = invoice.state === 'draft';

      // Skip if not draft or posted
      if (!isDraft && !isPosted) {
        stats.skipped++;
        continue;
      }

      // Get invoice lines with their current taxes
      const invoiceLines = await execute('account.move.line', 'search_read', [
        [['move_id', '=', invoiceId], ['display_type', '=', 'product']]
      ], { fields: ['id', 'name', 'tax_ids'] });

      // Determine the correct tax ID for this order
      const correctTaxId = getCorrectTaxId(vcsOrder);
      if (!correctTaxId) {
        stats.skipped++;
        continue;
      }

      // Check if any lines have Belgian VAT (the wrong tax)
      let linesNeedingFix = 0;
      for (const line of invoiceLines) {
        const currentTaxIds = line.tax_ids || [];
        if (currentTaxIds.includes(BE_VAT_21) && correctTaxId !== BE_VAT_21) {
          linesNeedingFix++;
        }
      }

      if (linesNeedingFix === 0) {
        stats.skipped++;
        continue;
      }

      stats.checked++;

      // For posted invoices, we need to reset to draft first
      if (isPosted && !dryRun) {
        try {
          await execute('account.move', 'button_draft', [[invoiceId]]);
        } catch (resetError) {
          stats.resetErrors++;
          console.error(`  ERROR resetting ${invoice.name} to draft: ${resetError.message}`);
          continue;
        }
      }

      // Fix all lines with wrong tax
      let linesFixedThisInvoice = 0;
      for (const line of invoiceLines) {
        const currentTaxIds = line.tax_ids || [];
        if (currentTaxIds.includes(BE_VAT_21) && correctTaxId !== BE_VAT_21) {
          if (!dryRun) {
            await execute('account.move.line', 'write', [[line.id], {
              tax_ids: [[6, 0, [correctTaxId]]]
            }]);
          }
          linesFixedThisInvoice++;
          stats.linesFixed++;
        }
      }

      // For posted invoices, re-post after fixing
      if (isPosted && !dryRun) {
        try {
          await execute('account.move', 'action_post', [[invoiceId]]);
        } catch (repostError) {
          stats.repostErrors++;
          console.error(`  ERROR re-posting ${invoice.name}: ${repostError.message}`);
          // Continue anyway, invoice is now in draft state with correct taxes
        }
      }

      if (linesFixedThisInvoice > 0) {
        if (isDraft) {
          stats.draftFixed++;
        } else {
          stats.postedFixed++;
        }
        const totalFixed = stats.draftFixed + stats.postedFixed;
        if (totalFixed <= 20 || totalFixed % 100 === 0) {
          console.log(`  [${totalFixed}] ${invoice.name} (${order.name}): ${dryRun ? 'Would fix' : 'Fixed'} ${linesFixedThisInvoice} lines (${invoice.state} -> ${vcsOrder.shipFromCountry} tax ID ${correctTaxId})`);
        }
      }

      // Rate limiting
      if (!dryRun && (stats.draftFixed + stats.postedFixed) % 20 === 0) {
        await sleep(200);
      }

    } catch (error) {
      stats.errors++;
      console.error(`  ERROR processing ${amazonOrderId}: ${error.message}`);
    }

    // Progress update
    if ((i + 1) % 500 === 0) {
      console.log(`\n--- Progress: ${i + 1}/${domesticOrders.length} orders ---`);
      console.log(`    Draft invoices fixed: ${stats.draftFixed}`);
      console.log(`    Posted invoices fixed: ${stats.postedFixed}`);
      console.log(`    Lines fixed: ${stats.linesFixed}`);
      console.log('');
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Domestic FBA orders checked: ${domesticOrders.length}`);
  console.log(`Invoices with wrong tax found: ${stats.checked}`);
  console.log(`Draft invoices fixed: ${stats.draftFixed}`);
  console.log(`Posted invoices fixed: ${stats.postedFixed}`);
  console.log(`Total lines fixed: ${stats.linesFixed}`);
  console.log(`Skipped (no fix needed or other state): ${stats.skipped}`);
  console.log(`General errors: ${stats.errors}`);
  console.log(`Reset-to-draft errors: ${stats.resetErrors}`);
  console.log(`Re-post errors: ${stats.repostErrors}`);

  if (dryRun) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
    console.log('Run without --dry-run to apply changes');
  }

  await mongoClient.close();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
