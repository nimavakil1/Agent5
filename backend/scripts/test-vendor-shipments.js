#!/usr/bin/env node
/**
 * Test Vendor Shipments API
 */

require('dotenv').config();
const SellingPartner = require('amazon-sp-api');

const MARKETPLACE = process.argv[2] || 'DE';

const MARKETPLACE_IDS = {
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYBER'
};

async function testShipmentsAPI() {
  console.log('===========================================');
  console.log('   Testing Vendor Shipments API');
  console.log('===========================================\n');

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
      debug_log: true
    }
  });

  // List all operations in vendorShipments
  console.log('1. Checking available vendorShipments operations...\n');

  try {
    // Try to access the endpoints definition
    const endpoints = client._constructors?.endpoints?.vendorShipments || {};
    console.log('   vendorShipments operations:', Object.keys(endpoints));
  } catch (err) {
    console.log('   Unable to list operations');
  }

  // Test GetShipmentLabels (doesn't require shipmentId)
  console.log('\n2. Testing GetShipmentLabels...');
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const now = new Date();

    const result = await client.callAPI({
      operation: 'vendorShipments.GetShipmentLabels',
      query: {
        createdAfter: thirtyDaysAgo.toISOString(),
        createdBefore: now.toISOString(),
        limit: 10
      }
    });
    console.log('   ✓ Success:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.log('   ✗ Error:', err.message);
  }

  // Try lowercase variants
  console.log('\n3. Testing lowercase operation names...');
  const operations = [
    'vendorShipments.getShipmentLabels',
    'vendorShipments.submitShipments',
    'vendorShipments.getShipments'
  ];

  for (const op of operations) {
    console.log(`   Trying: ${op}`);
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const result = await client.callAPI({
        operation: op,
        query: {
          createdAfter: thirtyDaysAgo.toISOString(),
          limit: 5
        }
      });
      console.log(`   ✓ ${op}: ${JSON.stringify(result).substring(0, 200)}`);
    } catch (err) {
      console.log(`   ✗ ${op}: ${err.message}`);
    }
  }

  // Check if there's a way to get shipment history
  console.log('\n4. Testing transaction status for a recent transaction...');

  // First, get a recent PO that we submitted an acknowledgment for
  try {
    const result = await client.callAPI({
      operation: 'vendorOrders.getPurchaseOrdersStatus',
      query: {
        limit: 5
      }
    });
    console.log('   getPurchaseOrdersStatus:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.log('   ✗ Error:', err.message);
  }

  console.log('\n===========================================');
  console.log('   Test Complete');
  console.log('===========================================');
}

testShipmentsAPI().catch(console.error);
