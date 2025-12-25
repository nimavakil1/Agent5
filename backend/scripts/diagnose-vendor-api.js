#!/usr/bin/env node
/**
 * Diagnose Vendor Central API Access
 */

require('dotenv').config();
const SellingPartner = require('amazon-sp-api');

const MARKETPLACE = process.argv[2] || 'DE';

const MARKETPLACE_IDS = {
  UK: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYBER',
  IT: 'APJ6JRA9NG5V4',
  ES: 'A1RKKUPIHCS9HS',
  NL: 'A1805IZSGTT6HS',
  SE: 'A2NODRKZP88ZB9',
  PL: 'A1C3SOZRARQ6R3'
};

async function diagnose() {
  console.log('===========================================');
  console.log('   Vendor Central API Diagnostics');
  console.log('===========================================\n');

  // Check environment variables
  console.log('1. Checking Environment Variables:');
  const requiredVars = [
    'AMAZON_SP_LWA_CLIENT_ID',
    'AMAZON_SP_LWA_CLIENT_SECRET',
    `AMAZON_VENDOR_REFRESH_TOKEN_${MARKETPLACE}`
  ];

  for (const v of requiredVars) {
    const exists = !!process.env[v];
    const preview = exists ? process.env[v].substring(0, 20) + '...' : 'NOT SET';
    console.log(`   ${v}: ${exists ? '✓' : '✗'} ${preview}`);
  }

  // Initialize client
  console.log('\n2. Initializing SP-API Client...');
  const tokenVar = `AMAZON_VENDOR_REFRESH_TOKEN_${MARKETPLACE}`;

  const client = new SellingPartner({
    region: 'eu',
    refresh_token: process.env[tokenVar],
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_SP_LWA_CLIENT_ID,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_SP_LWA_CLIENT_SECRET
    },
    options: {
      auto_request_tokens: true,
      auto_request_throttled: true,
      debug_log: true
    }
  });

  console.log('   Client initialized ✓\n');

  // Test various API operations
  console.log('3. Testing API Operations:\n');

  // Test 1: Get Purchase Orders (we know this works)
  console.log('   a) vendorOrders.getPurchaseOrders:');
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const result = await client.callAPI({
      operation: 'vendorOrders.getPurchaseOrders',
      query: {
        createdAfter: sevenDaysAgo.toISOString(),
        limit: 5
      }
    });
    console.log(`      ✓ Success - Found ${result.orders?.length || 0} orders`);
  } catch (err) {
    console.log(`      ✗ Error: ${err.message}`);
    if (err.details) console.log(`      Details: ${JSON.stringify(err.details)}`);
  }

  // Test 2: Vendor Shipments - try different endpoints
  console.log('\n   b) Vendor Shipments API:');

  const shipmentOperations = [
    { op: 'vendorShipments.submitShipmentConfirmations', method: 'POST', needsBody: true },
    { op: 'vendorShipments.getShipmentDetails', method: 'GET' },
    { op: 'vendorShipments.SubmitShipments', method: 'POST', needsBody: true }
  ];

  for (const { op, method, needsBody } of shipmentOperations) {
    console.log(`      Trying: ${op}`);
    try {
      const params = {
        operation: op,
        query: { limit: 1 }
      };

      const result = await client.callAPI(params);
      console.log(`      ✓ Success: ${JSON.stringify(result).substring(0, 100)}`);
    } catch (err) {
      console.log(`      ✗ ${err.message}`);
    }
  }

  // Test 3: Check available endpoints in the library
  console.log('\n   c) Checking library endpoints:');
  try {
    // Try to list what's available
    const endpoints = client.endpoints || {};
    console.log(`      Available endpoint categories: ${Object.keys(endpoints).join(', ') || 'Unable to list'}`);
  } catch (err) {
    console.log(`      Unable to list endpoints: ${err.message}`);
  }

  // Test 4: Direct Fulfillment APIs
  console.log('\n   d) Direct Fulfillment APIs:');
  const dfOperations = [
    'vendorDirectFulfillmentShipping.getShippingLabels',
    'vendorDirectFulfillmentShipping.submitShippingLabelRequest',
    'vendorDirectFulfillmentPayments.submitInvoices',
    'vendorDirectFulfillmentTransactions.getTransactionStatus'
  ];

  for (const op of dfOperations) {
    console.log(`      Trying: ${op}`);
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const now = new Date();

      const result = await client.callAPI({
        operation: op,
        query: {
          createdAfter: thirtyDaysAgo.toISOString(),
          createdBefore: now.toISOString(),
          limit: 1
        }
      });
      console.log(`      ✓ Success: ${JSON.stringify(result).substring(0, 100)}`);
    } catch (err) {
      console.log(`      ✗ ${err.message}`);
    }
  }

  // Test 5: Reports with date range
  console.log('\n   e) Reports API with proper parameters:');
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const now = new Date();

  const reportTypes = [
    'GET_VENDOR_INVENTORY_REPORT',
    'GET_VENDOR_SALES_REPORT'
  ];

  for (const reportType of reportTypes) {
    console.log(`      Requesting: ${reportType}`);
    try {
      const result = await client.callAPI({
        operation: 'reports.createReport',
        body: {
          reportType,
          marketplaceIds: [MARKETPLACE_IDS[MARKETPLACE]],
          dataStartTime: thirtyDaysAgo.toISOString(),
          dataEndTime: now.toISOString()
        }
      });
      console.log(`      ✓ Report ID: ${result.reportId}`);

      // Wait and check status
      await new Promise(r => setTimeout(r, 5000));

      const status = await client.callAPI({
        operation: 'reports.getReport',
        path: { reportId: result.reportId }
      });
      console.log(`      Status: ${status.processingStatus}`);
      if (status.processingStatus === 'FATAL') {
        console.log(`      Processing end time: ${status.processingEndTime}`);
      }
    } catch (err) {
      console.log(`      ✗ ${err.message}`);
      if (err.code) console.log(`      Code: ${err.code}`);
    }
  }

  // Test 6: Check token scopes
  console.log('\n   f) Token Info:');
  try {
    // The refresh token doesn't directly tell us scopes, but we can infer from errors
    console.log(`      Refresh token length: ${process.env[tokenVar]?.length || 0} chars`);
    console.log(`      Token prefix: ${process.env[tokenVar]?.substring(0, 10)}...`);
  } catch (err) {
    console.log(`      Error: ${err.message}`);
  }

  console.log('\n===========================================');
  console.log('   Diagnostics Complete');
  console.log('===========================================');
}

diagnose().catch(console.error);
