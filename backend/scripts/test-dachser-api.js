/**
 * Test Dachser API connection and check available services
 * Including SSCC web service capability
 */
require('dotenv').config();
const axios = require('axios');

const config = {
  baseUrl: process.env.DACHSER_API_BASE_URL || 'https://api-gateway.dachser.com/rest/v2',
  apiKey: process.env.DACHSER_API_KEY,
  customerId: process.env.DACHSER_CUSTOMER_ID
};

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-API-Key': config.apiKey,
    'Customer-Id': config.customerId
  };
}

async function testEndpoint(name, url, method = 'GET', data = null) {
  console.log(`\n[${name}] Testing ${method} ${url}...`);
  try {
    const opts = {
      method,
      url,
      headers: getHeaders(),
      timeout: 15000,
      validateStatus: () => true // Accept all status codes
    };
    if (data) opts.data = data;

    const response = await axios(opts);
    console.log(`  Status: ${response.status} ${response.statusText}`);

    if (response.status === 200 || response.status === 201) {
      console.log(`  ✓ SUCCESS - Endpoint accessible`);
      if (response.data) {
        console.log(`  Response preview:`, JSON.stringify(response.data).substring(0, 200));
      }
      return { success: true, status: response.status };
    } else if (response.status === 400) {
      console.log(`  ✓ ACCESSIBLE - Bad Request (needs proper parameters)`);
      if (response.data) console.log(`  Response:`, JSON.stringify(response.data).substring(0, 300));
      return { success: true, status: response.status, needsParams: true };
    } else if (response.status === 401) {
      console.log(`  ✗ UNAUTHORIZED - Invalid API key`);
      return { success: false, status: response.status, error: 'Invalid API key' };
    } else if (response.status === 403) {
      console.log(`  ✗ FORBIDDEN - API not activated for this endpoint`);
      if (response.data) console.log(`  Response:`, JSON.stringify(response.data));
      return { success: false, status: response.status, error: 'Not activated' };
    } else if (response.status === 404) {
      console.log(`  ? NOT FOUND - Endpoint may not exist or needs proper path`);
      return { success: null, status: response.status };
    } else {
      console.log(`  ? Status ${response.status}`);
      if (response.data) console.log(`  Response:`, JSON.stringify(response.data).substring(0, 300));
      return { success: null, status: response.status };
    }
  } catch (error) {
    console.log(`  ✗ ERROR: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('=== DACHSER API CONNECTION TEST ===');
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`API Key: ${config.apiKey ? config.apiKey.substring(0, 8) + '...' : 'NOT SET'}`);
  console.log(`Customer ID: ${config.customerId ? config.customerId.substring(0, 8) + '...' : 'NOT SET'}`);

  if (!config.apiKey || !config.customerId) {
    console.error('\n✗ DACHSER credentials not configured!');
    process.exit(1);
  }

  const results = {};

  // Test basic connectivity using shipment status
  results.shipmentstatus = await testEndpoint(
    'Shipment Status',
    `${config.baseUrl}/shipmentstatus?trackingNumber=TEST123`
  );

  // Test quotation endpoint (common API)
  results.quotation = await testEndpoint(
    'Quotation',
    `${config.baseUrl}/quotation`,
    'POST',
    {
      product: 'Y',
      termsOfDelivery: '031',
      sender: {
        name: 'Test Sender',
        street: 'Test Street 1',
        postalCode: '1000',
        city: 'Brussels',
        countryCode: 'BE'
      },
      receiver: {
        name: 'Test Receiver',
        street: 'Test Street 2',
        postalCode: '75001',
        city: 'Paris',
        countryCode: 'FR'
      },
      packages: [{
        packingType: 'EU',
        quantity: 1,
        weight: 500
      }]
    }
  );

  // Test transport order endpoint
  results.transportorder = await testEndpoint(
    'Transport Order',
    `${config.baseUrl}/transportorder`
  );

  // Test label endpoint
  results.label = await testEndpoint(
    'Label',
    `${config.baseUrl}/label`
  );

  // Test SSCC endpoint (the one we're interested in!)
  results.sscc = await testEndpoint(
    'SSCC',
    `${config.baseUrl}/sscc`
  );

  // Try alternative SSCC paths
  if (!results.sscc.success) {
    results.sscc_alt1 = await testEndpoint(
      'SSCC (pool)',
      `${config.baseUrl}/sscc/pool`
    );
    results.sscc_alt2 = await testEndpoint(
      'SSCC (request)',
      `${config.baseUrl}/sscc/request`,
      'POST',
      { quantity: 1 }
    );
  }

  // Test shipment history
  results.shipmenthistory = await testEndpoint(
    'Shipment History',
    `${config.baseUrl}/shipmenthistory?trackingNumber=TEST123`
  );

  // Test POD (Proof of Delivery)
  results.pod = await testEndpoint(
    'Proof of Delivery',
    `${config.baseUrl}/pod?trackingNumber=TEST123`
  );

  // Summary
  console.log('\n\n=== SUMMARY ===');
  console.log('Endpoint Status:');
  for (const [name, result] of Object.entries(results)) {
    const status = result.success === true ? '✓ Active' :
                   result.success === false ? '✗ Not Active/Error' : '? Unknown';
    console.log(`  ${name}: ${status} (${result.status || result.error})`);
  }

  // Check SSCC specifically
  console.log('\n=== SSCC CAPABILITY ===');
  if (results.sscc?.success || results.sscc_alt1?.success || results.sscc_alt2?.success) {
    console.log('✓ SSCC web service appears to be available!');
  } else {
    console.log('? SSCC web service status unclear - may need activation or different endpoint');
    console.log('  Note: SSCC service provides serial shipping container codes from Dachser pool');
    console.log('  Contact Dachser to verify SSCC API access is included in your subscription');
  }

  console.log('\n=== RECOMMENDATIONS ===');
  if (results.quotation?.success) {
    console.log('✓ API credentials are valid and connected');
  } else if (results.shipmentstatus?.status === 401 || results.quotation?.status === 401) {
    console.log('✗ API credentials appear invalid - contact Dachser');
  } else if (results.quotation?.status === 403) {
    console.log('⚠ API may not be fully activated yet - contact Dachser to check activation status');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
