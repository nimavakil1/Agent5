#!/usr/bin/env node
/**
 * Test script for Bol.com Advertising API v11
 * Run: node test-bolcom-api.js
 *
 * Correct v11 endpoints:
 * - List campaigns: POST /campaigns/list
 * - Create campaigns: POST /campaigns
 * - Update campaigns: PUT /campaigns
 * - List keywords: POST /keywords/list
 */

require('dotenv').config();

const BOL_ADVERTISER_ID = process.env.BOL_ADVERTISER_ID;
const BOL_ADVERTISER_SECRET = process.env.BOL_ADVERTISER_SECRET;

async function getAccessToken() {
  console.log('🔐 Getting access token from Bol.com...');

  if (!BOL_ADVERTISER_ID || !BOL_ADVERTISER_SECRET) {
    throw new Error('Missing BOL_ADVERTISER_ID or BOL_ADVERTISER_SECRET in .env');
  }

  const credentials = Buffer.from(`${BOL_ADVERTISER_ID}:${BOL_ADVERTISER_SECRET}`).toString('base64');

  const response = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  console.log('✅ Access token obtained successfully');
  return data.access_token;
}

async function testCampaignsEndpoint(token) {
  console.log('\n📊 Testing POST /campaigns/list ...');

  const filterBody = {
    page: 1,
    pageSize: 10
  };

  // Correct URL from OpenAPI spec: /advertiser/sponsored-products/campaign-management/campaigns/list
  const response = await fetch('https://api.bol.com/advertiser/sponsored-products/campaign-management/campaigns/list', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.advertiser.v11+json',
      'Content-Type': 'application/vnd.advertiser.v11+json'
    },
    body: JSON.stringify(filterBody)
  });

  console.log(`   Status: ${response.status} ${response.statusText}`);

  const text = await response.text();

  if (response.ok) {
    console.log('✅ Campaigns endpoint working!');
    try {
      const data = JSON.parse(text);
      console.log(`   Found ${data.campaigns?.length || 0} campaigns`);
      if (data.campaigns && data.campaigns.length > 0) {
        console.log('   Sample campaign:', data.campaigns[0].name || data.campaigns[0].campaignId);
      }
    } catch (e) {
      console.log('   Response:', text.substring(0, 200));
    }
  } else {
    console.log('❌ Campaigns endpoint failed');
    console.log('   Response:', text.substring(0, 500));
  }

  return response.ok;
}

async function testKeywordsEndpoint(token) {
  console.log('\n🔑 Testing POST /keywords/list ...');

  const filterBody = {
    page: 1,
    pageSize: 10
  };

  const response = await fetch('https://api.bol.com/advertiser/sponsored-products/campaign-management/keywords/list', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.advertiser.v11+json',
      'Content-Type': 'application/vnd.advertiser.v11+json'
    },
    body: JSON.stringify(filterBody)
  });

  console.log(`   Status: ${response.status} ${response.statusText}`);

  if (response.ok) {
    console.log('✅ Keywords endpoint working!');
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      console.log(`   Found ${data.keywords?.length || 0} keywords`);
    } catch (e) {
      console.log('   Response:', text.substring(0, 200));
    }
  } else {
    const text = await response.text();
    console.log('❌ Keywords endpoint failed');
    console.log('   Response:', text.substring(0, 300));
  }

  return response.ok;
}

async function testAdGroupsEndpoint(token) {
  console.log('\n📁 Testing POST /ad-groups/list ...');

  const filterBody = {
    page: 1,
    pageSize: 10
  };

  const response = await fetch('https://api.bol.com/advertiser/sponsored-products/campaign-management/ad-groups/list', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.advertiser.v11+json',
      'Content-Type': 'application/vnd.advertiser.v11+json'
    },
    body: JSON.stringify(filterBody)
  });

  console.log(`   Status: ${response.status} ${response.statusText}`);

  if (response.ok) {
    console.log('✅ Ad Groups endpoint working!');
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      console.log(`   Found ${data.adGroups?.length || 0} ad groups`);
    } catch (e) {
      console.log('   Response:', text.substring(0, 200));
    }
  } else {
    const text = await response.text();
    console.log('❌ Ad Groups endpoint failed');
    console.log('   Response:', text.substring(0, 300));
  }

  return response.ok;
}

async function main() {
  console.log('='.repeat(50));
  console.log('Bol.com Advertising API v11 Test');
  console.log('='.repeat(50));
  console.log(`\nCredentials: ${BOL_ADVERTISER_ID ? 'Found ✓' : 'Missing ✗'}`);

  try {
    const token = await getAccessToken();

    const campaignsOk = await testCampaignsEndpoint(token);
    const adGroupsOk = await testAdGroupsEndpoint(token);
    const keywordsOk = await testKeywordsEndpoint(token);

    console.log('\n' + '='.repeat(50));
    console.log('RESULTS:');
    console.log(`  Auth:       ✅ Working`);
    console.log(`  Campaigns:  ${campaignsOk ? '✅ Working' : '❌ Failed'}`);
    console.log(`  Ad Groups:  ${adGroupsOk ? '✅ Working' : '❌ Failed'}`);
    console.log(`  Keywords:   ${keywordsOk ? '✅ Working' : '❌ Failed'}`);
    console.log('='.repeat(50));

    process.exit(campaignsOk && adGroupsOk && keywordsOk ? 0 : 1);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

main();
