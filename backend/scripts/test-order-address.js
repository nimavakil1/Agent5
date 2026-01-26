/**
 * Test script to fetch full order address from Amazon SP-API
 * Tests if CompanyName is returned in the ShippingAddress
 *
 * Usage: node scripts/test-order-address.js 028-3167661-3509940
 */

require('dotenv').config();
const { getSellerClient } = require('../src/services/amazon/seller/SellerClient');

async function testOrderAddress(orderId) {
  console.log('='.repeat(60));
  console.log('Testing Amazon SP-API Order Address Fetch');
  console.log('='.repeat(60));
  console.log(`Order ID: ${orderId}\n`);

  const client = getSellerClient();

  try {
    // Step 1: Test connection
    console.log('1. Testing SP-API connection...');
    const connTest = await client.testConnection();
    if (!connTest.success) {
      console.error('   ❌ Connection failed:', connTest.message);
      return;
    }
    console.log('   ✓ Connection successful\n');

    // Step 2: Create RDT for PII access
    console.log('2. Creating Restricted Data Token (RDT) for PII access...');
    const rdt = await client.createRestrictedDataToken();
    if (rdt) {
      console.log('   ✓ RDT obtained successfully');
      console.log(`   Token preview: ${rdt.substring(0, 20)}...\n`);
    } else {
      console.log('   ⚠ Could not obtain RDT - will try without PII\n');
    }

    // Step 3: Get order details
    console.log('3. Fetching order details...');
    const orderResponse = await client.getOrder(orderId);
    if (orderResponse) {
      console.log('   ✓ Order found');
      console.log(`   Status: ${orderResponse.OrderStatus}`);
      console.log(`   Fulfillment: ${orderResponse.FulfillmentChannel}`);
      console.log(`   Purchase Date: ${orderResponse.PurchaseDate}`);

      // Check if ShippingAddress is in the order response
      if (orderResponse.ShippingAddress) {
        console.log('\n   ShippingAddress from getOrder:');
        console.log('   ' + JSON.stringify(orderResponse.ShippingAddress, null, 2).replace(/\n/g, '\n   '));
      } else {
        console.log('   ⚠ No ShippingAddress in getOrder response (expected - need separate call)');
      }
    }

    // Step 4: Get order address specifically
    console.log('\n4. Fetching order address via getOrderAddress...');
    try {
      const addressResponse = await client.getOrderAddress(orderId);

      console.log('   ✓ Address response received');
      console.log('\n   Full ShippingAddress object:');
      console.log('   ' + JSON.stringify(addressResponse, null, 2).replace(/\n/g, '\n   '));

      // Check for CompanyName specifically
      const address = addressResponse.ShippingAddress || addressResponse;
      console.log('\n   --- KEY FIELDS ---');
      console.log(`   Name:         ${address.Name || 'N/A'}`);
      console.log(`   CompanyName:  ${address.CompanyName || '❌ NOT PRESENT'}`);
      console.log(`   AddressLine1: ${address.AddressLine1 || 'N/A'}`);
      console.log(`   AddressLine2: ${address.AddressLine2 || 'N/A'}`);
      console.log(`   AddressLine3: ${address.AddressLine3 || 'N/A'}`);
      console.log(`   City:         ${address.City || 'N/A'}`);
      console.log(`   PostalCode:   ${address.PostalCode || 'N/A'}`);
      console.log(`   CountryCode:  ${address.CountryCode || 'N/A'}`);
      console.log(`   Phone:        ${address.Phone || 'N/A'}`);

      if (address.CompanyName) {
        console.log('\n   ✅ SUCCESS: CompanyName IS available via SP-API!');
        console.log(`   Company Name: "${address.CompanyName}"`);
      } else {
        console.log('\n   ❌ CompanyName field is NOT present in the response');
      }

    } catch (addressError) {
      console.error('   ❌ Failed to get order address:', addressError.message);
    }

    // Step 5: Get order buyer info
    console.log('\n5. Fetching buyer info via getOrderBuyerInfo...');
    try {
      const buyerResponse = await client.getOrderBuyerInfo(orderId);
      console.log('   ✓ Buyer info received:');
      console.log('   ' + JSON.stringify(buyerResponse, null, 2).replace(/\n/g, '\n   '));
    } catch (buyerError) {
      console.error('   ❌ Failed to get buyer info:', buyerError.message);
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response, null, 2));
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Test complete');
  console.log('='.repeat(60));
}

// Get order ID from command line or use default
const orderId = process.argv[2] || '028-3167661-3509940';
testOrderAddress(orderId);
