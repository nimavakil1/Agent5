/**
 * Manually confirm a Bol.com shipment
 * Usage: node scripts/confirm-bol-shipment.js A000DKTE6M ZMYOXWC8 DPD-BE
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');

async function confirmShipment(bolOrderId, trackingCode, transporterCode = 'DPD-BE') {
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await client.connect();
  const db = client.db();

  try {
    // Get the order from MongoDB
    const order = await db.collection('unified_orders').findOne({ 'sourceIds.bolOrderId': bolOrderId });

    if (!order) {
      console.log('Order not found in MongoDB:', bolOrderId);
      return;
    }

    console.log('Order found:');
    console.log('  Odoo ID:', order.sourceIds.odooSaleOrderId);
    console.log('  Odoo Name:', order.sourceIds.odooSaleOrderName);
    console.log('  Status:', order.status?.source);

    // Get Bol API token
    const credentials = Buffer.from(process.env.BOL_CLIENT_ID + ':' + process.env.BOL_CLIENT_SECRET).toString('base64');

    const tokenRes = await axios.post('https://login.bol.com/token', 'grant_type=client_credentials', {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + credentials
      }
    });
    const tokenData = tokenRes.data;

    if (!tokenData.access_token) {
      console.error('Failed to get Bol token:', tokenData);
      return;
    }

    // Get order items from Bol
    const orderRes = await axios.get('https://api.bol.com/retailer/orders/' + bolOrderId, {
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Authorization': 'Bearer ' + tokenData.access_token
      }
    });
    const bolOrder = orderRes.data;

    if (!bolOrder.orderItems || bolOrder.orderItems.length === 0) {
      console.error('No order items found:', bolOrder);
      return;
    }

    console.log('\nBol order items:', bolOrder.orderItems.length);
    for (const item of bolOrder.orderItems) {
      console.log(`  - ${item.product?.title?.substring(0, 50) || item.ean} (qty: ${item.quantity}, shipped: ${item.quantityShipped})`);
    }

    // Check if already shipped
    const unshippedItems = bolOrder.orderItems.filter(item => (item.quantityShipped || 0) < item.quantity);
    if (unshippedItems.length === 0) {
      console.log('\nOrder already fully shipped!');

      // Update MongoDB
      await db.collection('unified_orders').updateOne(
        { 'sourceIds.bolOrderId': bolOrderId },
        {
          $set: {
            'bol.shipmentConfirmedAt': new Date(),
            'bol.trackingCode': trackingCode,
            'status.source': 'SHIPPED'
          }
        }
      );
      return;
    }

    // Build shipment request
    const shipmentBody = {
      orderItems: unshippedItems.map(item => ({
        orderItemId: item.orderItemId,
        quantity: item.quantity - (item.quantityShipped || 0)
      })),
      shipmentReference: order.sourceIds.odooSaleOrderName || bolOrderId,
      transport: {
        transporterCode: transporterCode,
        trackAndTrace: trackingCode
      }
    };

    console.log('\nSending shipment confirmation:');
    console.log(JSON.stringify(shipmentBody, null, 2));

    try {
      const shipRes = await axios.put('https://api.bol.com/retailer/orders/shipment', shipmentBody, {
        headers: {
          'Content-Type': 'application/vnd.retailer.v10+json',
          'Accept': 'application/vnd.retailer.v10+json',
          'Authorization': 'Bearer ' + tokenData.access_token
        }
      });

      console.log('\nBol API response:', shipRes.status);
      console.log(JSON.stringify(shipRes.data, null, 2));

      if (shipRes.status === 202) {
        console.log('\n✅ Shipment confirmed successfully!');

        // Update MongoDB
        await db.collection('unified_orders').updateOne(
          { 'sourceIds.bolOrderId': bolOrderId },
          {
            $set: {
              'bol.shipmentConfirmedAt': new Date(),
              'bol.trackingCode': trackingCode,
              'status.source': 'SHIPPED'
            }
          }
        );
      } else {
        console.log('\n❌ Shipment confirmation failed!');
      }
    } catch (shipError) {
      console.error('\n❌ Shipment confirmation failed:', shipError.response?.data || shipError.message);
    }

  } finally {
    await client.close();
  }
}

// Parse command line args
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node scripts/confirm-bol-shipment.js <bolOrderId> <trackingCode> [transporterCode]');
  console.log('Example: node scripts/confirm-bol-shipment.js A000DKTE6M ZMYOXWC8 DPD-BE');
  process.exit(1);
}

confirmShipment(args[0], args[1], args[2] || 'DPD-BE').catch(console.error);
