/**
 * Fix Invoice Taxes - Odoo Only Version
 *
 * This script fixes wrong taxes on Amazon Seller invoices using only Odoo data.
 * It finds invoices where BE*VAT 21% was incorrectly applied to domestic FBA sales.
 *
 * Usage:
 *   node scripts/fix-invoice-taxes-odoo-only.js --dry-run    # Preview only
 *   node scripts/fix-invoice-taxes-odoo-only.js              # Apply fixes
 */

const xmlrpc = require('xmlrpc');
require('dotenv').config();

const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

const commonClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/common' });
const objectClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/object' });

let uid;

// Belgian VAT 21% - the wrong tax being applied
const BE_VAT_21 = 1;

// Domestic VAT tax IDs by country
const DOMESTIC_TAXES = {
  'DE': 135,  // DE*VAT 19%
  'FR': 122,  // FR*VAT 20%
  'IT': 180,  // IT*VAT 22%
  'NL': 136,  // NL*VAT 21%
  'PL': 194,  // PL*VAT 23%
  'CZ': 187,  // CZ*VAT 21%
  'GB': 182,  // GB*VAT 20%
};

// Invoice prefixes to country mapping
const INVOICE_PREFIX_TO_COUNTRY = {
  'VDE': 'DE',
  'VFR': 'FR',
  'VIT': 'IT',
  'VNL': 'NL',
  'VPL': 'PL',
  'VCZ': 'CZ',
  'VGB': 'GB',
};

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

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('='.repeat(70));
  console.log('Fix Invoice Taxes - Odoo Only Version');
  console.log('='.repeat(70));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');

  // Connect to Odoo
  uid = await authenticate();
  console.log('Connected to Odoo\n');

  const stats = {
    checked: 0,
    draftFixed: 0,
    linesFixed: 0,
    skipped: 0,
    errors: 0,
  };

  // Process each country's invoices
  for (const [prefix, countryCode] of Object.entries(INVOICE_PREFIX_TO_COUNTRY)) {
    const correctTaxId = DOMESTIC_TAXES[countryCode];
    if (!correctTaxId) continue;

    console.log(`\nProcessing ${prefix} invoices (${countryCode} -> tax ID ${correctTaxId})...`);

    // Find DRAFT invoices with this prefix that may have wrong tax
    const invoices = await execute('account.move', 'search_read', [
      [
        ['name', 'like', `${prefix}%`],
        ['state', '=', 'draft'],
        ['move_type', '=', 'out_invoice'],
      ]
    ], {
      fields: ['id', 'name'],
      order: 'id desc'
    });

    console.log(`  Found ${invoices.length} draft ${prefix} invoices`);

    for (const invoice of invoices) {
      stats.checked++;

      try {
        // Get invoice lines with their current taxes
        const invoiceLines = await execute('account.move.line', 'search_read', [
          [['move_id', '=', invoice.id], ['display_type', '=', 'product']]
        ], { fields: ['id', 'name', 'tax_ids'] });

        // Check if any lines have Belgian VAT (the wrong tax)
        let linesNeedingFix = 0;
        for (const line of invoiceLines) {
          const currentTaxIds = line.tax_ids || [];
          if (currentTaxIds.includes(BE_VAT_21)) {
            linesNeedingFix++;
          }
        }

        if (linesNeedingFix === 0) {
          stats.skipped++;
          continue;
        }

        // Fix all lines with wrong tax
        let linesFixedThisInvoice = 0;
        for (const line of invoiceLines) {
          const currentTaxIds = line.tax_ids || [];
          if (currentTaxIds.includes(BE_VAT_21)) {
            if (!dryRun) {
              await execute('account.move.line', 'write', [[line.id], {
                tax_ids: [[6, 0, [correctTaxId]]]
              }]);
            }
            linesFixedThisInvoice++;
            stats.linesFixed++;
          }
        }

        if (linesFixedThisInvoice > 0) {
          stats.draftFixed++;
          if (stats.draftFixed <= 30 || stats.draftFixed % 100 === 0) {
            console.log(`    [${stats.draftFixed}] ${invoice.name}: ${dryRun ? 'Would fix' : 'Fixed'} ${linesFixedThisInvoice} lines`);
          }
        }

        // Rate limiting
        if (!dryRun && stats.draftFixed % 20 === 0) {
          await sleep(200);
        }

      } catch (error) {
        stats.errors++;
        console.error(`    ERROR processing ${invoice.name}: ${error.message}`);
      }
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Invoices checked: ${stats.checked}`);
  console.log(`Draft invoices fixed: ${stats.draftFixed}`);
  console.log(`Total lines fixed: ${stats.linesFixed}`);
  console.log(`Skipped (no fix needed): ${stats.skipped}`);
  console.log(`Errors: ${stats.errors}`);

  if (dryRun) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
    console.log('Run without --dry-run to apply changes');
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
