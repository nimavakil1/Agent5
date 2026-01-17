#!/usr/bin/env node
/**
 * Test stock update using Listings Items API (modern approach)
 * instead of legacy Feeds API
 */
require('dotenv').config();
const { getSellerClient } = require('../src/services/amazon/seller/SellerClient');

// BE marketplace ID
const BE_MARKETPLACE = 'AMEN7PMS3EDWL';
const SELLER_ID = process.env.AMAZON_SELLER_ID || 'A1GJ5ZORIRYSYA';

async function run() {
  console.log('Initializing Seller Client...');
  const sellerClient = getSellerClient();
  await sellerClient.init();
  const spClient = await sellerClient.getClient();

  const testSku = 'P0014';
  const testQuantity = 3;

  console.log(`\nTest: Update ${testSku} to quantity ${testQuantity} using Listings Items API`);

  try {
    // Method 1: Try patchListingsItem (PATCH)
    console.log('\nMethod 1: Trying patchListingsItem...');

    const patchBody = {
      productType: 'PRODUCT', // Generic product type
      patches: [
        {
          op: 'replace',
          path: '/attributes/fulfillment_availability',
          value: [
            {
              fulfillment_channel_code: 'DEFAULT', // FBM
              quantity: testQuantity
            }
          ]
        }
      ]
    };

    const patchResponse = await spClient.callAPI({
      operation: 'listingsItems.patchListingsItem',
      path: {
        sellerId: SELLER_ID,
        sku: testSku
      },
      query: {
        marketplaceIds: [BE_MARKETPLACE]
      },
      body: patchBody
    });

    console.log('\n=== SUCCESS ===');
    console.log('Response:', JSON.stringify(patchResponse, null, 2));

  } catch (error) {
    console.error('\nMethod 1 failed:', error.message);

    // Method 2: Try using inventory API directly
    console.log('\nMethod 2: Trying FBA Inventory API...');

    try {
      // This is for checking inventory, not updating FBM
      const inventoryResponse = await spClient.callAPI({
        operation: 'fbaInventory.getInventorySummaries',
        query: {
          granularityType: 'Marketplace',
          granularityId: BE_MARKETPLACE,
          marketplaceIds: [BE_MARKETPLACE],
          sellerSkus: [testSku]
        }
      });

      console.log('FBA Inventory check:', JSON.stringify(inventoryResponse, null, 2));
    } catch (err2) {
      console.error('Method 2 also failed:', err2.message);
    }

    // Method 3: Check if we can at least read the listing
    console.log('\nMethod 3: Checking if we can read the listing...');

    try {
      const getResponse = await spClient.callAPI({
        operation: 'listingsItems.getListingsItem',
        path: {
          sellerId: SELLER_ID,
          sku: testSku
        },
        query: {
          marketplaceIds: [BE_MARKETPLACE],
          includedData: ['summaries', 'attributes', 'fulfillmentAvailability']
        }
      });

      console.log('\n=== Listing Details ===');
      console.log('SKU:', getResponse.sku);
      console.log('Summaries:', JSON.stringify(getResponse.summaries, null, 2));
      console.log('Fulfillment Availability:', JSON.stringify(getResponse.fulfillmentAvailability, null, 2));

    } catch (err3) {
      console.error('Method 3 failed:', err3.message);
    }

    process.exit(1);
  }
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
