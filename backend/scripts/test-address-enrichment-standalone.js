/**
 * Standalone test for SP-API address enrichment
 * Tests the enrichment without needing MongoDB connection
 *
 * Usage: node scripts/test-address-enrichment-standalone.js /path/to/orders.txt
 */

require('dotenv').config();
const fs = require('fs');
const { getSellerAddressEnricher } = require('../src/services/amazon/seller/SellerAddressEnricher');

// Simple TSV parser (doesn't need database)
function parseTsv(content) {
  const lines = content.trim().split('\n');
  const headers = lines[0].split('\t');
  const headerIndex = {};
  headers.forEach((h, i) => headerIndex[h.trim()] = i);

  const orders = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const orderId = cols[headerIndex['order-id']]?.trim();
    if (!orderId || orders[orderId]) continue;

    orders[orderId] = {
      orderId,
      recipientName: cols[headerIndex['recipient-name']]?.trim() || '',
      address1: cols[headerIndex['ship-address-1']]?.trim() || '',
      address2: cols[headerIndex['ship-address-2']]?.trim() || '',
      city: cols[headerIndex['ship-city']]?.trim() || '',
      postalCode: cols[headerIndex['ship-postal-code']]?.trim() || '',
      country: cols[headerIndex['ship-country']]?.trim() || '',
      buyerCompanyName: cols[headerIndex['buyer-company-name']]?.trim() || '',
      isBusinessOrder: cols[headerIndex['is-business-order']]?.trim() === 'true'
    };
  }

  return orders;
}

async function testAddressEnrichment(tsvFilePath) {
  console.log('='.repeat(70));
  console.log('SP-API Address Enrichment Test');
  console.log('='.repeat(70));

  // Read TSV file
  if (!fs.existsSync(tsvFilePath)) {
    console.error(`File not found: ${tsvFilePath}`);
    process.exit(1);
  }

  const tsvContent = fs.readFileSync(tsvFilePath, 'utf-8');
  const orders = parseTsv(tsvContent);
  const orderIds = Object.keys(orders);

  console.log(`\nParsed ${orderIds.length} unique orders from TSV\n`);

  // Show what TSV has
  console.log('--- TSV Data (before enrichment) ---\n');
  for (const orderId of orderIds) {
    const order = orders[orderId];
    console.log(`${orderId}:`);
    console.log(`  Recipient: "${order.recipientName}"`);
    console.log(`  Address: "${order.address1}"`);
    console.log(`  Location: ${order.city}, ${order.postalCode}, ${order.country}`);
    console.log(`  TSV buyerCompanyName: "${order.buyerCompanyName || '(empty)'}"`);
    console.log(`  Is B2B: ${order.isBusinessOrder}`);
    console.log('');
  }

  // Enrich with SP-API
  console.log('-'.repeat(70));
  console.log('--- Fetching CompanyName from SP-API ---\n');

  const enricher = getSellerAddressEnricher();
  const results = [];

  for (let i = 0; i < orderIds.length; i++) {
    const orderId = orderIds[i];
    const order = orders[orderId];

    console.log(`[${i + 1}/${orderIds.length}] ${orderId}...`);

    try {
      const spApiAddress = await enricher.fetchOrderAddress(orderId);

      const result = {
        orderId,
        tsvRecipient: order.recipientName,
        tsvBuyerCompany: order.buyerCompanyName,
        spApiCompanyName: spApiAddress?.companyName || null,
        isB2B: order.isBusinessOrder || !!spApiAddress?.companyName
      };

      if (spApiAddress?.companyName) {
        console.log(`  ✅ SP-API CompanyName: "${spApiAddress.companyName}"`);
      } else {
        console.log(`  ➖ No CompanyName (B2C order)`);
      }

      results.push(result);

    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
      results.push({
        orderId,
        tsvRecipient: order.recipientName,
        tsvBuyerCompany: order.buyerCompanyName,
        spApiCompanyName: null,
        error: error.message
      });
    }
  }

  // Summary comparison table
  console.log('\n' + '='.repeat(70));
  console.log('COMPARISON: TSV vs SP-API');
  console.log('='.repeat(70));
  console.log('\n%-23s | %-30s | %-25s'.replace(/%(-?\d+)s/g, (m, n) => ''.padEnd(Math.abs(n))));
  console.log('Order ID               | TSV buyerCompanyName           | SP-API CompanyName');
  console.log('-'.repeat(23) + ' | ' + '-'.repeat(30) + ' | ' + '-'.repeat(25));

  let enrichedCount = 0;
  let b2cCount = 0;
  let errorCount = 0;

  for (const r of results) {
    const tsvCompany = (r.tsvBuyerCompany || '(empty)').substring(0, 28);
    const spApiCompany = r.error ? `ERROR: ${r.error.substring(0, 15)}` :
                         r.spApiCompanyName ? r.spApiCompanyName.substring(0, 23) : '(none - B2C)';

    console.log(`${r.orderId.padEnd(23)} | ${tsvCompany.padEnd(30)} | ${spApiCompany}`);

    if (r.error) errorCount++;
    else if (r.spApiCompanyName) enrichedCount++;
    else b2cCount++;
  }

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total orders:        ${results.length}`);
  console.log(`With CompanyName:    ${enrichedCount} (B2B orders with shipping company)`);
  console.log(`Without CompanyName: ${b2cCount} (B2C orders)`);
  console.log(`Errors:              ${errorCount}`);

  // Highlight the Daimler case
  const daimlerOrder = results.find(r => r.spApiCompanyName === 'Daimler Truck AG');
  if (daimlerOrder) {
    console.log('\n🎯 KEY FINDING:');
    console.log(`   Order ${daimlerOrder.orderId}:`);
    console.log(`   - TSV buyerCompanyName: "${daimlerOrder.tsvBuyerCompany}" (billing intermediary)`);
    console.log(`   - SP-API CompanyName:   "${daimlerOrder.spApiCompanyName}" (actual shipping destination)`);
    console.log('\n   ✅ SP-API provides the correct shipping company name!');
  }

  console.log('='.repeat(70));
}

// Get TSV file path from command line
const tsvFilePath = process.argv[2] || '/Users/nimavakil/Downloads/133248441782020476.txt';
testAddressEnrichment(tsvFilePath);
