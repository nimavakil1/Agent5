// Debug script to check actual Bol.com API response structure
require('dotenv').config();

async function getRetailerAccessToken() {
  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing BOL credentials');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://login.bol.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    throw new Error(`Token error: ${await response.text()}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function debugBolApi() {
  const token = await getRetailerAccessToken();

  // Check orders
  console.log('\n=== ORDERS API RESPONSE ===');
  const ordersRes = await fetch('https://api.bol.com/retailer/orders?page=1', {
    headers: {
      'Accept': 'application/vnd.retailer.v10+json',
      'Authorization': `Bearer ${token}`
    }
  });
  const orders = await ordersRes.json();
  console.log('First order:', JSON.stringify(orders.orders?.[0], null, 2));
  if (orders.orders?.[0]?.orderItems?.[0]) {
    console.log('\nFirst order item:', JSON.stringify(orders.orders[0].orderItems[0], null, 2));
  }

  // Check shipments
  console.log('\n=== SHIPMENTS API RESPONSE ===');
  const shipmentsRes = await fetch('https://api.bol.com/retailer/shipments?page=1', {
    headers: {
      'Accept': 'application/vnd.retailer.v10+json',
      'Authorization': `Bearer ${token}`
    }
  });
  const shipments = await shipmentsRes.json();
  console.log('First shipment:', JSON.stringify(shipments.shipments?.[0], null, 2));

  // Check returns
  console.log('\n=== RETURNS API RESPONSE ===');
  const returnsRes = await fetch('https://api.bol.com/retailer/returns?page=1', {
    headers: {
      'Accept': 'application/vnd.retailer.v10+json',
      'Authorization': `Bearer ${token}`
    }
  });
  const returns = await returnsRes.json();
  console.log('First return:', JSON.stringify(returns.returns?.[0], null, 2));

  // Check invoices
  console.log('\n=== INVOICES API RESPONSE ===');
  const invoicesRes = await fetch('https://api.bol.com/retailer/invoices', {
    headers: {
      'Accept': 'application/vnd.retailer.v10+json',
      'Authorization': `Bearer ${token}`
    }
  });
  const invoices = await invoicesRes.json();
  console.log('First invoice:', JSON.stringify(invoices.invoiceListItems?.[0], null, 2));
}

debugBolApi().catch(console.error);
