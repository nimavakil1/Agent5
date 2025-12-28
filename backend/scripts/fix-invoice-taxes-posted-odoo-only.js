/**
 * Fix Invoice Taxes - Posted Invoices (Odoo Only)
 *
 * This script fixes wrong taxes on POSTED Amazon Seller invoices using only Odoo data.
 * It finds posted invoices where BE*VAT 21% was incorrectly applied to domestic FBA sales.
 *
 * Process:
 * 1. Reset invoice to draft
 * 2. Fix the tax on invoice lines
 * 3. Re-post the invoice
 *
 * Usage:
 *   node scripts/fix-invoice-taxes-posted-odoo-only.js --dry-run    # Preview only
 *   node scripts/fix-invoice-taxes-posted-odoo-only.js              # Apply fixes
 */

const xmlrpc = require('xmlrpc');
require('dotenv').config();

const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

const commonClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/common' });
const objectClient = xmlrpc.createSecureClient({ host: ODOO_URL, port: 443, path: '/xmlrpc/2/object' });

// Configure XML-RPC to handle None/null values from Odoo
commonClient.options = { ...commonClient.options, responseParser: { allowNone: true } };
objectClient.options = { ...objectClient.options, responseParser: { allowNone: true } };

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
  console.log('Fix Invoice Taxes - Posted Invoices (Odoo Only)');
  console.log('='.repeat(70));
  if (dryRun) console.log('*** DRY RUN MODE - No changes will be made ***\n');

  // Connect to Odoo
  uid = await authenticate();
  console.log('Connected to Odoo\n');

  const stats = {
    checked: 0,
    postedFixed: 0,
    linesFixed: 0,
    skipped: 0,
    resetErrors: 0,
    repostErrors: 0,
    errors: 0,
  };

  // Process each country's invoices
  for (const [prefix, countryCode] of Object.entries(INVOICE_PREFIX_TO_COUNTRY)) {
    const correctTaxId = DOMESTIC_TAXES[countryCode];
    if (!correctTaxId) continue;

    console.log(`\nProcessing ${prefix} POSTED invoices (${countryCode} -> tax ID ${correctTaxId})...`);

    // Find POSTED invoices with this prefix - Only Nov and Dec 2025
    const invoices = await execute('account.move', 'search_read', [
      [
        ['name', 'like', `${prefix}%`],
        ['state', '=', 'posted'],
        ['move_type', '=', 'out_invoice'],
        ['invoice_date', '>=', '2025-11-01'],
        ['invoice_date', '<=', '2025-12-31'],
      ]
    ], {
      fields: ['id', 'name'],
      order: 'id desc'
    });

    console.log(`  Found ${invoices.length} posted ${prefix} invoices`);

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

        // Reset to draft first
        if (!dryRun) {
          try {
            await execute('account.move', 'button_draft', [[invoice.id]]);
          } catch (resetError) {
            stats.resetErrors++;
            console.error(`    ERROR resetting ${invoice.name} to draft: ${resetError.message}`);
            continue;
          }
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

        // Re-post the invoice
        if (!dryRun) {
          try {
            await execute('account.move', 'action_post', [[invoice.id]]);
          } catch (repostError) {
            stats.repostErrors++;
            console.error(`    ERROR re-posting ${invoice.name}: ${repostError.message}`);
            // Invoice is now in draft with correct taxes - continue anyway
          }
        }

        if (linesFixedThisInvoice > 0) {
          stats.postedFixed++;
          if (stats.postedFixed <= 50 || stats.postedFixed % 100 === 0) {
            console.log(`    [${stats.postedFixed}] ${invoice.name}: ${dryRun ? 'Would fix' : 'Fixed'} ${linesFixedThisInvoice} lines`);
          }
        }

        // Rate limiting
        if (!dryRun && stats.postedFixed % 20 === 0) {
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
  console.log(`Posted invoices fixed: ${stats.postedFixed}`);
  console.log(`Total lines fixed: ${stats.linesFixed}`);
  console.log(`Skipped (no fix needed): ${stats.skipped}`);
  console.log(`Reset-to-draft errors: ${stats.resetErrors}`);
  console.log(`Re-post errors: ${stats.repostErrors}`);
  console.log(`General errors: ${stats.errors}`);

  if (dryRun) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
    console.log('Run without --dry-run to apply changes');
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
