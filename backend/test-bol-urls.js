#!/usr/bin/env node
require('dotenv').config();

const BOL_ADVERTISER_ID = process.env.BOL_ADVERTISER_ID;
const BOL_ADVERTISER_SECRET = process.env.BOL_ADVERTISER_SECRET;

async function test() {
  // Get token
  const credentials = Buffer.from(`${BOL_ADVERTISER_ID}:${BOL_ADVERTISER_SECRET}`).toString('base64');
  const authRes = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
  const { access_token } = await authRes.json();
  console.log('Token obtained\n');

  // Test different URL patterns
  const urls = [
    'https://api.bol.com/advertiser/campaigns/list',
    'https://api.bol.com/advertiser/sponsored-products/campaigns/list',
    'https://api.bol.com/sponsored-products/campaigns/list',
    'https://api.bol.com/retailer/advertising/campaigns'
  ];

  for (const url of urls) {
    console.log(`Testing: ${url}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ page: 1, pageSize: 5 })
    });
    console.log(`  Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (res.ok) {
      const data = JSON.parse(text);
      console.log(`  SUCCESS! Found ${data.campaigns?.length || 0} campaigns\n`);
    } else {
      console.log(`  Response: ${text.substring(0, 150)}\n`);
    }
  }
}

test().catch(console.error);
