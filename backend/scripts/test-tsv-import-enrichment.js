/**
 * Test script for TSV import with SP-API address enrichment
 *
 * Tests the full flow:
 * 1. Parse TSV file
 * 2. Fetch CompanyName from SP-API for each order
 * 3. Verify the enrichment worked
 *
 * Usage: node scripts/test-tsv-import-enrichment.js /path/to/orders.txt
 */

require('dotenv').config();
const fs = require('fs');
const { getFbmOrderImporter } = require('../src/services/amazon/seller/FbmOrderImporter');
const { getSellerAddressEnricher } = require('../src/services/amazon/seller/SellerAddressEnricher');

async function testTsvImportWithEnrichment(tsvFilePath) {
  console.log('='.repeat(70));
  console.log('Testing TSV Import with SP-API Address Enrichment');
  console.log('='.repeat(70));

  // Read TSV file
  if (!fs.existsSync(tsvFilePath)) {
    console.error(`File not found: ${tsvFilePath}`);
    process.exit(1);
  }

  const tsvContent = fs.readFileSync(tsvFilePath, 'utf-8');
  console.log(`\nLoaded TSV file: ${tsvFilePath}`);
  console.log(`File size: ${(tsvContent.length / 1024).toFixed(1)} KB\n`);

  // Test just the enrichment for a specific order first
  console.log('--- Testing SP-API enrichment for order 028-3167661-3509940 ---\n');

  const enricher = getSellerAddressEnricher();
  const testOrderId = '028-3167661-3509940';

  try {
    const spApiAddress = await enricher.fetchOrderAddress(testOrderId);

    if (spApiAddress) {
      console.log('SP-API Address response:');
      console.log(`  CompanyName: ${spApiAddress.companyName || 'N/A'}`);
      console.log(`  Name: ${spApiAddress.name || 'N/A'}`);
      console.log(`  AddressLine1: ${spApiAddress.addressLine1 || 'N/A'}`);
      console.log(`  City: ${spApiAddress.city || 'N/A'}`);
      console.log(`  PostalCode: ${spApiAddress.postalCode || 'N/A'}`);
      console.log(`  CountryCode: ${spApiAddress.countryCode || 'N/A'}`);

      if (spApiAddress.companyName) {
        console.log(`\n  ✅ CompanyName found: "${spApiAddress.companyName}"`);
      } else {
        console.log('\n  ⚠️ No CompanyName in SP-API response');
      }
    } else {
      console.log('  ❌ No SP-API address response');
    }
  } catch (error) {
    console.error('  ❌ SP-API enrichment error:', error.message);
  }

  // Now test the full import flow
  console.log('\n' + '-'.repeat(70));
  console.log('--- Testing full TSV import with enrichment (dry run) ---\n');

  const importer = await getFbmOrderImporter();

  // Parse TSV to see what orders we have
  const orderGroups = importer.parseTsv(tsvContent);
  const orderIds = Object.keys(orderGroups);

  console.log(`Found ${orderIds.length} orders in TSV:\n`);

  for (const orderId of orderIds) {
    const order = orderGroups[orderId];
    console.log(`  ${orderId}:`);
    console.log(`    Recipient: ${order.recipientName}`);
    console.log(`    Address1: ${order.address1}`);
    console.log(`    City: ${order.city}, ${order.postalCode}, ${order.country}`);
    console.log(`    TSV buyerCompanyName: "${order.buyerCompanyName || 'N/A'}"`);
    console.log(`    Is Business Order: ${order.isBusinessOrder}`);
    console.log('');
  }

  // Test enrichment for all orders
  console.log('-'.repeat(70));
  console.log('--- Enriching all orders with SP-API CompanyName ---\n');

  const results = {
    total: orderIds.length,
    enriched: 0,
    noCompany: 0,
    errors: 0
  };

  for (let i = 0; i < orderIds.length; i++) {
    const orderId = orderIds[i];
    console.log(`[${i + 1}/${orderIds.length}] Fetching SP-API address for ${orderId}...`);

    try {
      const spApiAddress = await enricher.fetchOrderAddress(orderId);

      if (spApiAddress?.companyName) {
        console.log(`    ✅ CompanyName: "${spApiAddress.companyName}"`);
        results.enriched++;
      } else {
        console.log(`    ➖ No CompanyName (likely B2C order)`);
        results.noCompany++;
      }
    } catch (error) {
      console.log(`    ❌ Error: ${error.message}`);
      results.errors++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total orders: ${results.total}`);
  console.log(`With CompanyName: ${results.enriched}`);
  console.log(`Without CompanyName: ${results.noCompany}`);
  console.log(`Errors: ${results.errors}`);
  console.log('='.repeat(70));

  process.exit(0);
}

// Get TSV file path from command line
const tsvFilePath = process.argv[2] || '/Users/nimavakil/Downloads/133248441782020476.txt';
testTsvImportWithEnrichment(tsvFilePath);
