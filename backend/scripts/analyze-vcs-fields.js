/**
 * Analyze VCS data fields to understand booking rules
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function analyzeVCSData() {
  await mongoose.connect(process.env.MONGO_URI);

  console.log('='.repeat(70));
  console.log('VCS DATA FIELD ANALYSIS');
  console.log('='.repeat(70));

  // Define a flexible schema
  const VcsTransaction = mongoose.model('VcsTransaction', new mongoose.Schema({}, { strict: false, collection: 'vcstransactions' }));

  // Get sample VCS records
  const samples = await VcsTransaction.find({}).limit(1000).lean();

  console.log('\nTotal VCS records sampled:', samples.length);

  // Analyze unique combinations
  const combinations = {};

  for (const vcs of samples) {
    const key = [
      'shipFrom=' + (vcs.shipFromCountry || 'N/A'),
      'shipTo=' + (vcs.shipToCountry || 'N/A'),
      'scheme=' + (vcs.taxReportingScheme || 'N/A'),
      'sellerJuris=' + (vcs.sellerTaxJurisdiction || 'N/A')
    ].join(' | ');

    if (!combinations[key]) {
      combinations[key] = { count: 0, examples: [] };
    }
    combinations[key].count++;
    if (combinations[key].examples.length < 2) {
      combinations[key].examples.push({
        orderId: vcs.orderId,
        taxRate: vcs.taxRate,
        buyerTaxReg: vcs.buyerTaxRegistration || null,
        marketplace: vcs.marketplace || vcs.channel
      });
    }
  }

  console.log('\nUnique combinations found:', Object.keys(combinations).length);
  console.log('\n' + '='.repeat(70));
  console.log('COMBINATIONS (sorted by count)');
  console.log('='.repeat(70));

  const sorted = Object.entries(combinations).sort((a, b) => b[1].count - a[1].count);

  for (const [key, data] of sorted.slice(0, 40)) {
    console.log('\n' + data.count + 'x: ' + key);
    for (const ex of data.examples) {
      console.log('   Order: ' + ex.orderId + ' | taxRate: ' + ex.taxRate + '% | buyerVAT: ' + (ex.buyerTaxReg || 'none'));
    }
  }

  // Now analyze what SHOULD happen for each combination
  console.log('\n\n' + '='.repeat(70));
  console.log('EXPECTED BOOKING RULES');
  console.log('='.repeat(70));

  const rules = [
    { shipFrom: 'FR', shipTo: 'FR', scheme: 'N/A', hasBuyerVAT: false, expected: 'VFR + FR*VAT | Régime National + FR*VAT 20%' },
    { shipFrom: 'FR', shipTo: 'FR', scheme: 'N/A', hasBuyerVAT: true, expected: 'VFR + FR*VAT | Régime Autoliquidation + FR*VAT 0% Cocont' },
    { shipFrom: 'DE', shipTo: 'FR', scheme: 'VCS_EU_OSS', hasBuyerVAT: false, expected: 'VOS + FR*OSS | B2C France + FR*OSS 20%' },
    { shipFrom: 'DE', shipTo: 'DE', scheme: 'N/A', hasBuyerVAT: false, expected: 'VDE + DE*VAT | Régime National + DE*VAT 19%' },
    { shipFrom: 'BE', shipTo: 'FR', scheme: 'VCS_EU_OSS', hasBuyerVAT: false, expected: 'VOS + FR*OSS | B2C France + FR*OSS 20%' },
    { shipFrom: 'BE', shipTo: 'BE', scheme: 'N/A', hasBuyerVAT: false, expected: 'VBE + BE*VAT | Régime National + BE*VAT 21%' },
  ];

  console.log('\nKey booking rules based on VCS fields:\n');
  for (const rule of rules) {
    console.log(`shipFrom=${rule.shipFrom}, shipTo=${rule.shipTo}, scheme=${rule.scheme}, buyerVAT=${rule.hasBuyerVAT}`);
    console.log(`  → ${rule.expected}\n`);
  }

  await mongoose.disconnect();
}

analyzeVCSData().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
