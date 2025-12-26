/**
 * Verify December 2025 Amazon Seller Invoice Taxes
 *
 * This script checks ALL Amazon Seller invoices created in Odoo in December 2025
 * and verifies if the taxes are correct based on:
 *
 * 1. Ship-from and ship-to country (from VCS data)
 * 2. B2B vs B2C customer type
 *    - B2B: Local VAT (if domestic) or Reverse Charge 0% (if intra-EU with VAT number)
 *    - B2C: Local VAT (if domestic) or OSS (if cross-border EU)
 *
 * Usage:
 *   node scripts/verify-dec2025-invoice-taxes.js              # Full verification
 *   node scripts/verify-dec2025-invoice-taxes.js --summary    # Summary only
 *   node scripts/verify-dec2025-invoice-taxes.js --export     # Export to Excel
 */

const xmlrpc = require('xmlrpc');
const { MongoClient } = require('mongodb');
const XLSX = require('xlsx');
const fs = require('fs');
require('dotenv').config();

// Odoo connection - use info@acropaq.com as per CLAUDE.md
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

// Domestic VAT tax IDs by country (Acropaq's local VAT registrations)
const DOMESTIC_TAXES = {
  'BE': { 21: 1, 12: 4, 6: 6, 0: 8 },
  'DE': { 19: 135, 7: 134, 0: 163 },
  'FR': { 20: 122, 5.5: 123, 0: 144 },
  'NL': { 21: 136, 9: 137, 0: 138 },
  'IT': { 22: 180, 0: 181 },
  'CZ': { 21: 187, 15: 189, 10: 191, 0: 193 },
  'PL': { 23: 194, 8: 196, 5: 198, 0: 200 },
  'GB': { 20: 182, 5: 184, 0: 186 },
  'ES': { 21: 201, 10: 203, 4: 205, 0: 207 },
};

// OSS VAT tax IDs by destination country (cross-border B2C)
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

// Reverse Charge / Intra-EU B2B tax IDs (0%)
const REVERSE_CHARGE_TAXES = {
  'BE': 8,   // BE 0% export/reverse charge
  'DE': 163, // DE 0%
  'FR': 144, // FR 0%
  'IT': 181, // IT 0%
  'NL': 138, // NL 0%
};

// Tax ID to name mapping (for display)
const TAX_NAMES = {};

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
 * Determine expected tax ID based on VCS data and customer type
 */
function getExpectedTaxId(vcsOrder, isB2B) {
  const shipFrom = vcsOrder.shipFromCountry;
  const shipTo = vcsOrder.shipToCountry;
  const taxScheme = vcsOrder.taxReportingScheme;

  const isExport = !EU_COUNTRIES.includes(shipTo);
  const isDomestic = shipFrom === shipTo;
  const isCrossBorderEU = shipFrom !== shipTo && EU_COUNTRIES.includes(shipFrom) && EU_COUNTRIES.includes(shipTo);

  // Calculate VCS tax rate for reference
  const totalExcl = Math.abs(vcsOrder.totalExclusive || 0);
  const totalTax = Math.abs(vcsOrder.totalTax || 0);
  let vcsRatePercent = 0;
  if (totalExcl > 0 && totalTax > 0) {
    vcsRatePercent = Math.round((totalTax / totalExcl) * 100);
  }

  // 1. EXPORT (non-EU destination) - Always 0%
  if (isExport) {
    return {
      taxId: DOMESTIC_TAXES['BE']?.[0] || 8,
      reason: 'Export to non-EU',
      expectedRate: 0
    };
  }

  // 2. B2B INTRA-EU - Reverse Charge (0%)
  if (isB2B && isCrossBorderEU) {
    // B2B cross-border should be reverse charge
    const reverseChargeTaxId = REVERSE_CHARGE_TAXES[shipFrom] || 8;
    return {
      taxId: reverseChargeTaxId,
      reason: `B2B Intra-EU Reverse Charge (${shipFrom}->${shipTo})`,
      expectedRate: 0
    };
  }

  // 3. B2B DOMESTIC - Local VAT of shipping country
  if (isB2B && isDomestic) {
    const countryTaxes = DOMESTIC_TAXES[shipTo];
    if (countryTaxes) {
      const standardRate = STANDARD_VAT_RATES[shipTo];
      const taxId = countryTaxes[vcsRatePercent] || countryTaxes[standardRate] || Object.values(countryTaxes)[0];
      return {
        taxId: taxId,
        reason: `B2B Domestic (${shipTo})`,
        expectedRate: vcsRatePercent || standardRate
      };
    }
  }

  // 4. B2C DOMESTIC - Local VAT
  if (!isB2B && isDomestic) {
    const countryTaxes = DOMESTIC_TAXES[shipTo];
    if (countryTaxes) {
      const standardRate = STANDARD_VAT_RATES[shipTo];
      const taxId = countryTaxes[vcsRatePercent] || countryTaxes[standardRate] || Object.values(countryTaxes)[0];
      return {
        taxId: taxId,
        reason: `B2C Domestic (${shipTo})`,
        expectedRate: vcsRatePercent || standardRate
      };
    }
  }

  // 5. B2C CROSS-BORDER EU (OSS) - Destination country VAT
  if (!isB2B && isCrossBorderEU) {
    const countryTaxes = OSS_TAXES[shipTo];
    if (countryTaxes) {
      const standardRate = STANDARD_VAT_RATES[shipTo];
      const taxId = countryTaxes[vcsRatePercent] || countryTaxes[standardRate] || Object.values(countryTaxes)[0];
      return {
        taxId: taxId,
        reason: `B2C OSS (${shipFrom}->${shipTo})`,
        expectedRate: vcsRatePercent || standardRate
      };
    }
  }

  // 6. VCS explicit OSS scheme
  if (taxScheme === 'VCS_EU_OSS') {
    const countryTaxes = OSS_TAXES[shipTo];
    if (countryTaxes) {
      const standardRate = STANDARD_VAT_RATES[shipTo];
      const taxId = countryTaxes[vcsRatePercent] || countryTaxes[standardRate] || Object.values(countryTaxes)[0];
      return {
        taxId: taxId,
        reason: `OSS Scheme (${shipTo})`,
        expectedRate: vcsRatePercent || standardRate
      };
    }
  }

  // Fallback - can't determine
  return {
    taxId: null,
    reason: `Unknown scenario: ${shipFrom}->${shipTo}, B2B=${isB2B}, scheme=${taxScheme}`,
    expectedRate: null
  };
}

async function run() {
  const args = process.argv.slice(2);
  const summaryOnly = args.includes('--summary');
  const exportExcel = args.includes('--export');

  console.log('='.repeat(80));
  console.log('AMAZON SELLER INVOICE TAX VERIFICATION - DECEMBER 2025');
  console.log('='.repeat(80));
  console.log('');

  // Connect to MongoDB
  const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await mongoClient.connect();
  const db = mongoClient.db();
  console.log('Connected to MongoDB');

  // Connect to Odoo
  uid = await authenticate();
  console.log('Connected to Odoo\n');

  // Load tax names for display
  console.log('Loading tax names from Odoo...');
  const taxes = await execute('account.tax', 'search_read', [[]], { fields: ['id', 'name'], limit: 500 });
  for (const tax of taxes) {
    TAX_NAMES[tax.id] = tax.name;
  }
  console.log(`Loaded ${taxes.length} tax definitions\n`);

  // Find all Amazon Seller invoices created in December 2025
  console.log('Fetching Amazon Seller invoices created in December 2025...');

  const invoices = await execute('account.move', 'search_read', [
    [
      ['move_type', '=', 'out_invoice'],
      ['create_date', '>=', '2025-12-01 00:00:00'],
      ['create_date', '<', '2026-01-01 00:00:00'],
      '|',
      ['invoice_origin', 'like', 'FBA%'],
      ['invoice_origin', 'like', 'FBM%']
    ]
  ], {
    fields: ['id', 'name', 'invoice_origin', 'partner_id', 'amount_total', 'amount_untaxed', 'amount_tax', 'state', 'invoice_line_ids', 'create_date'],
    order: 'create_date asc'
  });

  console.log(`Found ${invoices.length} Amazon Seller invoices created in Dec 2025\n`);

  // Statistics
  const stats = {
    total: invoices.length,
    correct: 0,
    incorrect: 0,
    noVcsData: 0,
    noTaxLines: 0,
    errors: 0,
    byScenario: {},
    incorrectDetails: []
  };

  // Process each invoice
  console.log('Verifying invoice taxes...\n');

  for (let i = 0; i < invoices.length; i++) {
    const invoice = invoices[i];

    try {
      // Extract Amazon order ID from invoice_origin
      const origin = invoice.invoice_origin || '';
      const amazonOrderId = origin.replace(/^(FBA|FBM)/, '');

      if (!amazonOrderId) {
        stats.noVcsData++;
        continue;
      }

      // Get customer info to determine B2B vs B2C
      let isB2B = false;
      if (invoice.partner_id && invoice.partner_id[0]) {
        const partners = await execute('res.partner', 'search_read', [
          [['id', '=', invoice.partner_id[0]]]
        ], { fields: ['id', 'vat', 'is_company'] });

        if (partners.length > 0) {
          const partner = partners[0];
          // B2B if has VAT number or is marked as company
          isB2B = !!(partner.vat || partner.is_company);
        }
      }

      // Find VCS data in MongoDB
      const vcsOrders = await db.collection('amazon_vcs_orders').find({
        orderId: { $regex: amazonOrderId },
        transactionType: 'SHIPMENT'
      }).toArray();

      if (vcsOrders.length === 0) {
        stats.noVcsData++;
        continue;
      }

      // Use first VCS order (they should all have same tax info)
      const vcsOrder = vcsOrders[0];

      // Get expected tax
      const expected = getExpectedTaxId(vcsOrder, isB2B);

      // Get invoice line taxes (display_type = 'product' in Odoo 16)
      const lines = await execute('account.move.line', 'search_read', [
        [['move_id', '=', invoice.id], ['display_type', '=', 'product'], ['product_id', '!=', false]]
      ], { fields: ['id', 'tax_ids', 'name', 'price_subtotal'] });

      if (lines.length === 0) {
        stats.noTaxLines++;
        continue;
      }

      // Check if any line has the wrong tax
      let hasCorrectTax = true;
      let actualTaxIds = new Set();

      for (const line of lines) {
        if (line.tax_ids && line.tax_ids.length > 0) {
          line.tax_ids.forEach(tid => actualTaxIds.add(tid));
        }
      }

      // Convert to array
      const actualTaxIdsArray = Array.from(actualTaxIds);

      // Check if expected tax is in actual taxes
      if (expected.taxId) {
        if (!actualTaxIds.has(expected.taxId)) {
          hasCorrectTax = false;
        }
      } else {
        // Can't determine expected - mark as needs review
        hasCorrectTax = false;
      }

      // Track scenario
      const scenario = expected.reason;
      stats.byScenario[scenario] = stats.byScenario[scenario] || { correct: 0, incorrect: 0 };

      if (hasCorrectTax) {
        stats.correct++;
        stats.byScenario[scenario].correct++;
      } else {
        stats.incorrect++;
        stats.byScenario[scenario].incorrect++;

        const detail = {
          invoiceId: invoice.id,
          invoiceName: invoice.name,
          orderOrigin: invoice.invoice_origin,
          amazonOrderId: amazonOrderId,
          shipFrom: vcsOrder.shipFromCountry,
          shipTo: vcsOrder.shipToCountry,
          isB2B: isB2B,
          taxScheme: vcsOrder.taxReportingScheme,
          expectedTaxId: expected.taxId,
          expectedTaxName: TAX_NAMES[expected.taxId] || `ID ${expected.taxId}`,
          expectedReason: expected.reason,
          actualTaxIds: actualTaxIdsArray,
          actualTaxNames: actualTaxIdsArray.map(id => TAX_NAMES[id] || `ID ${id}`).join(', '),
          invoiceTotal: invoice.amount_total,
          invoiceTax: invoice.amount_tax
        };

        stats.incorrectDetails.push(detail);

        if (!summaryOnly && stats.incorrect <= 50) {
          console.log(`  INCORRECT: ${invoice.name} (${amazonOrderId})`);
          console.log(`    ${vcsOrder.shipFromCountry} -> ${vcsOrder.shipToCountry}, B2B=${isB2B}`);
          console.log(`    Expected: ${detail.expectedTaxName} (${expected.reason})`);
          console.log(`    Actual: ${detail.actualTaxNames}`);
          console.log('');
        }
      }

      // Progress update
      if ((i + 1) % 500 === 0) {
        console.log(`Progress: ${i + 1}/${invoices.length} invoices checked`);
        console.log(`  Correct: ${stats.correct}, Incorrect: ${stats.incorrect}, No VCS: ${stats.noVcsData}`);
        console.log('');
      }

      // Rate limiting
      if ((i + 1) % 50 === 0) {
        await sleep(50);
      }

    } catch (error) {
      stats.errors++;
      console.error(`  ERROR processing invoice ${invoice.name}: ${error.message}`);
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total invoices checked: ${stats.total}`);
  console.log(`Correct taxes: ${stats.correct} (${(stats.correct/stats.total*100).toFixed(1)}%)`);
  console.log(`Incorrect taxes: ${stats.incorrect} (${(stats.incorrect/stats.total*100).toFixed(1)}%)`);
  console.log(`No VCS data: ${stats.noVcsData}`);
  console.log(`No tax lines: ${stats.noTaxLines}`);
  console.log(`Errors: ${stats.errors}`);

  console.log('\n' + '-'.repeat(80));
  console.log('BY SCENARIO:');
  console.log('-'.repeat(80));
  for (const [scenario, counts] of Object.entries(stats.byScenario).sort((a, b) => b[1].incorrect - a[1].incorrect)) {
    const total = counts.correct + counts.incorrect;
    const pctCorrect = (counts.correct / total * 100).toFixed(1);
    console.log(`  ${scenario}`);
    console.log(`    Correct: ${counts.correct}/${total} (${pctCorrect}%), Incorrect: ${counts.incorrect}`);
  }

  // Export to Excel if requested
  if (exportExcel && stats.incorrectDetails.length > 0) {
    console.log('\n' + '-'.repeat(80));
    console.log('EXPORTING TO EXCEL...');

    const excelData = stats.incorrectDetails.map(d => ({
      'Invoice': d.invoiceName,
      'Amazon Order': d.amazonOrderId,
      'Ship From': d.shipFrom,
      'Ship To': d.shipTo,
      'B2B': d.isB2B ? 'Yes' : 'No',
      'Tax Scheme': d.taxScheme || '',
      'Expected Tax': d.expectedTaxName,
      'Expected Reason': d.expectedReason,
      'Actual Tax': d.actualTaxNames,
      'Invoice Total': d.invoiceTotal,
      'Tax Amount': d.invoiceTax
    }));

    const worksheet = XLSX.utils.json_to_sheet(excelData);
    worksheet['!cols'] = [
      { wch: 15 }, { wch: 25 }, { wch: 10 }, { wch: 10 }, { wch: 6 },
      { wch: 15 }, { wch: 25 }, { wch: 35 }, { wch: 25 }, { wch: 12 }, { wch: 12 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Incorrect Taxes');

    const outputDir = '/Users/nimavakil/Agent5/backend/output';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = `${outputDir}/dec2025-incorrect-taxes.xlsx`;
    XLSX.writeFile(workbook, outputPath);
    console.log(`Exported ${stats.incorrectDetails.length} incorrect invoices to: ${outputPath}`);
  }

  await mongoClient.close();
  console.log('\nDone.');
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
