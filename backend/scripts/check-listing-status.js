#!/usr/bin/env node
/**
 * Check listing status and current inventory
 */
require('dotenv').config();
const { getSellerClient } = require('../src/services/amazon/seller/SellerClient');

const BE_MARKETPLACE = 'AMEN7PMS3EDWL';
const SELLER_ID = process.env.AMAZON_SELLER_ID || 'A1GJ5ZORIRYSYA';

async function run() {
  console.log('Initializing Seller Client...');
  const sellerClient = getSellerClient();
  await sellerClient.init();
  const spClient = await sellerClient.getClient();

  const testSku = 'P0014';

  console.log(`\nChecking listing for SKU: ${testSku}`);
  console.log(`Marketplace: BE (${BE_MARKETPLACE})`);
  console.log(`Seller ID: ${SELLER_ID}`);

  try {
    // Get current listing details
    const response = await spClient.callAPI({
      operation: 'listingsItems.getListingsItem',
      path: {
        sellerId: SELLER_ID,
        sku: testSku
      },
      query: {
        marketplaceIds: [BE_MARKETPLACE],
        includedData: ['summaries', 'attributes', 'fulfillmentAvailability', 'issues']
      }
    });

    console.log('\n=== Listing Details ===');
    console.log('SKU:', response.sku);

    if (response.summaries) {
      console.log('\nSummaries:');
      for (const summary of response.summaries) {
        console.log(`  Marketplace: ${summary.marketplaceId}`);
        console.log(`  ASIN: ${summary.asin}`);
        console.log(`  Product Type: ${summary.productType}`);
        console.log(`  Status: ${summary.status}`);
      }
    }

    if (response.fulfillmentAvailability) {
      console.log('\nFulfillment Availability:');
      for (const fa of response.fulfillmentAvailability) {
        console.log(`  Channel: ${fa.fulfillmentChannelCode}`);
        console.log(`  Quantity: ${fa.quantity}`);
      }
    }

    if (response.issues && response.issues.length > 0) {
      console.log('\nIssues:');
      for (const issue of response.issues) {
        console.log(`  - ${issue.code}: ${issue.message}`);
      }
    }

  } catch (error) {
    console.error('Error:', error.message);

    // Try alternative: get from reports/listings
    console.log('\nTrying to get from recent listings report...');
  }
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
