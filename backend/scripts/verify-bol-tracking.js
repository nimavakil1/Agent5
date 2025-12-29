/**
 * Verify Bol.com tracking - check if orders show correct tracking on Bol.com
 */

require('dotenv').config();
const mongoose = require('mongoose');
const BolOrder = require('../src/models/BolOrder');

// Get Bol.com access token
async function getToken() {
  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;
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

  const data = await response.json();
  return data.access_token;
}

// Get order details from Bol.com API
async function getBolOrder(token, orderId) {
  const response = await fetch(`https://api.bol.com/retailer/orders/${orderId}`, {
    headers: {
      'Accept': 'application/vnd.retailer.v10+json',
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    return { error: response.status };
  }

  return response.json();
}

// Get shipments for an order
async function getShipments(token, orderId) {
  const response = await fetch(`https://api.bol.com/retailer/shipments?order-id=${orderId}`, {
    headers: {
      'Accept': 'application/vnd.retailer.v10+json',
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    return { error: response.status };
  }

  return response.json();
}

async function verify() {
  await mongoose.connect(process.env.MONGO_URI);

  // Get confirmed orders
  const confirmedOrders = await BolOrder.find({
    fulfilmentMethod: 'FBR',
    shipmentConfirmedAt: { $exists: true }
  })
    .sort({ shipmentConfirmedAt: -1 })
    .limit(10)
    .lean();

  console.log(`Verifying ${confirmedOrders.length} confirmed FBR orders with Bol.com API...\n`);

  const token = await getToken();

  let verified = 0;
  let issues = 0;

  for (const order of confirmedOrders) {
    // Get shipments for this order
    const shipmentsData = await getShipments(token, order.orderId);

    if (shipmentsData.error) {
      console.log(`${order.orderId}: API Error ${shipmentsData.error}`);
      issues++;
      continue;
    }

    const shipments = shipmentsData.shipments || [];

    if (shipments.length === 0) {
      console.log(`${order.orderId}: ⚠ NO SHIPMENTS FOUND ON BOL.COM`);
      console.log(`  MongoDB tracking: ${order.trackingCode}`);
      console.log(`  Confirmed at: ${order.shipmentConfirmedAt}`);
      issues++;
    } else {
      const shipment = shipments[0];
      const bolTracking = shipment.transport?.trackAndTrace || 'none';
      const bolTransporter = shipment.transport?.transporterCode || 'unknown';

      const match = bolTracking === order.trackingCode ? '✓' : '⚠ MISMATCH';

      console.log(`${order.orderId}: ${match}`);
      console.log(`  MongoDB tracking: ${order.trackingCode}`);
      console.log(`  Bol.com tracking: ${bolTracking} (${bolTransporter})`);
      console.log(`  Shipment ID: ${shipment.shipmentId}`);

      if (bolTracking === order.trackingCode) {
        verified++;
      } else {
        issues++;
      }
    }
    console.log('');

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('=== SUMMARY ===');
  console.log(`Verified: ${verified}`);
  console.log(`Issues: ${issues}`);

  await mongoose.disconnect();
}

verify().catch(console.error);
