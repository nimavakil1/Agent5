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
    const spClient = await client.getClient();

    // Get shipments from last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Try different operation names
    const operations = [
      'vendorShipments.getShipmentDetails',
      'vendorDirectFulfillmentShipping.getShippingLabels',
      'vendorDirectFulfillmentShipping.getPackingSlips'
    ];

    for (const op of operations) {
      console.log(`Trying operation: ${op}`);
      try {
        const result = await spClient.callAPI({
          operation: op,
          query: {
            createdAfter: thirtyDaysAgo.toISOString(),
            limit: 10
          }
        });
        console.log(`${op} Response:`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.log(`  ${op}: ${err.message}`);
      }
    }

    return null;
  } catch (error) {
    console.error(`Error:`, error.message);
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

async function tryRequestReport(marketplace = 'DE') {
  console.log(`\n=== Requesting Vendor Reports for ${marketplace} ===`);

  const client = new VendorClient(marketplace);
  const spClient = await client.getClient();

  // Try different report types
  const reportTypes = [
    'GET_VENDOR_REAL_TIME_INVENTORY_REPORT',
    'GET_VENDOR_INVENTORY_HEALTH_AND_PLANNING_REPORT'
  ];

  for (const reportType of reportTypes) {
    console.log(`\nRequesting: ${reportType}`);
    try {
      const result = await spClient.callAPI({
        operation: 'reports.createReport',
        body: {
          reportType,
          marketplaceIds: [client.marketplaceId]
        }
      });
      console.log(`  Report ID: ${result.reportId}`);
      return result;
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  }
}

async function getRecentReports(marketplace = 'DE') {
  console.log(`\n=== Getting Recent Reports for ${marketplace} ===`);

  const client = new VendorClient(marketplace);
  const spClient = await client.getClient();

  try {
    // Get all reports from last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await spClient.callAPI({
      operation: 'reports.getReports',
      query: {
        createdSince: thirtyDaysAgo.toISOString(),
        pageSize: 100
      }
    });

    console.log(`Found ${result.reports?.length || 0} reports`);
    if (result.reports && result.reports.length > 0) {
      result.reports.forEach(r => {
        console.log(`  - ${r.reportType}: ${r.processingStatus} (${r.reportId})`);
      });
    }

    return result;
  } catch (err) {
    console.log(`Error: ${err.message}`);
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

  // 2. Get recent reports
  await getRecentReports(marketplace);

  // 3. Try requesting a report
  await tryRequestReport(marketplace);

  // 4. Show known vendor report types
  await getVendorReportTypes(marketplace);

  console.log('\n===========================================');
  console.log('   Done!');
  console.log('===========================================');
}

main().catch(console.error);
