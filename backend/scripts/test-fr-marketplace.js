#!/usr/bin/env node
/**
 * Test FR marketplace access
 */
require('dotenv').config();
const { getSellerClient } = require('../src/services/amazon/seller/SellerClient');

const FR_MARKETPLACE = 'A13V1IB3VIYBER';
const SELLER_ID = process.env.AMAZON_SELLER_ID || 'A1GJ5ZORIRYSYA';

async function run() {
  console.log('Initializing...');
  const sellerClient = getSellerClient();
  await sellerClient.init();
  const spClient = await sellerClient.getClient();

  console.log(`\nTesting FR marketplace: ${FR_MARKETPLACE}`);
  console.log(`Seller ID: ${SELLER_ID}`);

  // Test 1: Try to get a listing from FR
  console.log('\n=== Test 1: Get listing P0014 from FR ===');
  try {
    const response = await spClient.callAPI({
      operation: 'listingsItems.getListingsItem',
      path: {
        sellerId: SELLER_ID,
        sku: 'P0014'
      },
      query: {
        marketplaceIds: [FR_MARKETPLACE],
        includedData: ['summaries', 'fulfillmentAvailability']
      }
    });
    console.log('SUCCESS:', JSON.stringify(response, null, 2));
  } catch (error) {
    console.log('FAILED:', error.message);
  }

  // Test 2: Try to get orders from FR
  console.log('\n=== Test 2: Get recent orders from FR ===');
  try {
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 7);

    const response = await spClient.callAPI({
      operation: 'orders.getOrders',
      query: {
        MarketplaceIds: [FR_MARKETPLACE],
        CreatedAfter: oneDayAgo.toISOString(),
        MaxResultsPerPage: 5
      }
    });
    console.log('SUCCESS: Found', response.Orders?.length || 0, 'orders');
    if (response.Orders?.length > 0) {
      console.log('First order:', response.Orders[0].AmazonOrderId);
    }
  } catch (error) {
    console.log('FAILED:', error.message);
  }

  // Test 3: Check what marketplaces we CAN create reports for
  console.log('\n=== Test 3: List all recent reports to see which marketplaces work ===');
  try {
    const response = await spClient.callAPI({
      operation: 'reports.getReports',
      query: {
        reportTypes: ['GET_MERCHANT_LISTINGS_DATA'],
        processingStatuses: ['DONE'],
        pageSize: 20
      }
    });

    const marketplacesSeen = new Set();
    for (const report of (response.reports || [])) {
      const mpId = report.marketplaceIds?.[0];
      if (mpId) marketplacesSeen.add(mpId);
    }

    console.log('Marketplaces with existing reports:');
    for (const mpId of marketplacesSeen) {
      console.log(`  ${mpId}`);
    }

    // Check if FR is in there
    if (marketplacesSeen.has(FR_MARKETPLACE)) {
      console.log('\n✓ FR marketplace HAS existing reports');
    } else {
      console.log('\n✗ FR marketplace has NO existing reports');
    }
  } catch (error) {
    console.log('FAILED:', error.message);
  }

  // Test 4: Try requesting report with all marketplaces at once
  console.log('\n=== Test 4: Request report for ALL marketplaces at once ===');
  try {
    const allMarketplaces = [
      'A1PA6795UKMFR9', // DE
      'A1RKKUPIHCS9HS', // ES
      'A13V1IB3VIYBER', // FR
      'APJ6JRA9NG5V4',  // IT
      'A1805IZSGTT6HS', // NL
      'AMEN7PMS3EDWL',  // BE
    ];

    const response = await spClient.callAPI({
      operation: 'reports.createReport',
      body: {
        reportType: 'GET_MERCHANT_LISTINGS_DATA',
        marketplaceIds: allMarketplaces
      }
    });
    console.log('SUCCESS: Report requested:', response.reportId);
  } catch (error) {
    console.log('FAILED:', error.message);
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
