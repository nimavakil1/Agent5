#!/usr/bin/env node
/**
 * Fetch Vendor Central Data from Amazon
 *
 * Fetches:
 * - Shipment details
 * - Available reports
 */

require('dotenv').config();
const { VendorClient, VENDOR_TOKEN_MAP } = require('../src/services/amazon/vendor/VendorClient');

async function fetchShipmentDetails(marketplace = 'DE') {
  console.log(`\n=== Fetching Shipment Details for ${marketplace} ===`);

  try {
    const client = new VendorClient(marketplace);
    await client.init();

    // Get shipments from last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await client.getShipmentDetails({
      createdAfter: thirtyDaysAgo.toISOString(),
      limit: 50
    });

    console.log('Shipment Details Response:');
    console.log(JSON.stringify(result, null, 2));

    return result;
  } catch (error) {
    console.error(`Error fetching shipments for ${marketplace}:`, error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response, null, 2));
    }
    return null;
  }
}

async function listAvailableReports(marketplace = 'DE') {
  console.log(`\n=== Checking Available Reports for ${marketplace} ===`);

  try {
    const client = new VendorClient(marketplace);
    const spClient = await client.getClient();

    // Try to get reports - this uses the Reports API
    const result = await spClient.callAPI({
      operation: 'reports.getReports',
      query: {
        reportTypes: [
          'GET_VENDOR_INVENTORY_REPORT',
          'GET_VENDOR_SALES_REPORT',
          'GET_VENDOR_TRAFFIC_REPORT',
          'GET_VENDOR_FORECASTING_REPORT'
        ],
        pageSize: 10
      }
    });

    console.log('Available Reports:');
    console.log(JSON.stringify(result, null, 2));

    return result;
  } catch (error) {
    console.error(`Error listing reports for ${marketplace}:`, error.message);
    return null;
  }
}

async function getVendorReportTypes(marketplace = 'DE') {
  console.log(`\n=== Getting Vendor Report Types ===`);

  // Known Vendor Central report types
  const vendorReportTypes = [
    'GET_VENDOR_REAL_TIME_INVENTORY_REPORT',
    'GET_VENDOR_INVENTORY_HEALTH_REPORT',
    'GET_VENDOR_SALES_DIAGNOSTIC_REPORT',
    'GET_VENDOR_NET_PURE_PRODUCT_MARGIN_REPORT',
    'GET_VENDOR_TRAFFIC_REPORT',
    'GET_VENDOR_FORECASTING_FRESH_REPORT',
    'GET_VENDOR_FORECASTING_REPORT'
  ];

  console.log('Known Vendor Report Types:');
  vendorReportTypes.forEach(rt => console.log(`  - ${rt}`));

  return vendorReportTypes;
}

async function requestReport(marketplace = 'DE', reportType = 'GET_VENDOR_REAL_TIME_INVENTORY_REPORT') {
  console.log(`\n=== Requesting Report: ${reportType} for ${marketplace} ===`);

  try {
    const client = new VendorClient(marketplace);
    const spClient = await client.getClient();

    const result = await spClient.callAPI({
      operation: 'reports.createReport',
      body: {
        reportType,
        marketplaceIds: [client.marketplaceId]
      }
    });

    console.log('Report Request Response:');
    console.log(JSON.stringify(result, null, 2));

    return result;
  } catch (error) {
    console.error(`Error requesting report:`, error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response, null, 2));
    }
    return null;
  }
}

async function main() {
  console.log('===========================================');
  console.log('   Amazon Vendor Central Data Fetcher');
  console.log('===========================================');

  // Check configured marketplaces
  console.log('\nConfigured Marketplaces:');
  for (const [mp, envVar] of Object.entries(VENDOR_TOKEN_MAP)) {
    if (mp === 'DE_FR') continue;
    const hasToken = !!process.env[envVar];
    console.log(`  ${mp}: ${hasToken ? '✓ Configured' : '✗ Not configured'}`);
  }

  // Test with DE marketplace
  const marketplace = 'DE';

  // 1. Fetch Shipment Details
  await fetchShipmentDetails(marketplace);

  // 2. List Available Reports
  await listAvailableReports(marketplace);

  // 3. Show known vendor report types
  await getVendorReportTypes(marketplace);

  // 4. Try requesting a report (optional)
  // await requestReport(marketplace, 'GET_VENDOR_REAL_TIME_INVENTORY_REPORT');

  console.log('\n===========================================');
  console.log('   Done!');
  console.log('===========================================');
}

main().catch(console.error);
