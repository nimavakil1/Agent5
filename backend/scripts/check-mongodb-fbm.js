require('dotenv').config();
const { MongoClient } = require('mongodb');

async function checkMongoFbm() {
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await client.connect();
  const db = client.db();

  console.log('=== MongoDB FBM Orders Check ===\n');

  // Find FBM orders that should have tracking pushed
  const fbmOrders = await db.collection('seller_orders').find({
    fulfillmentChannel: 'MFN',
    'odoo.saleOrderId': { $ne: null },
    'odoo.trackingPushed': { $ne: true }
  }).limit(10).toArray();

  console.log('FBM orders pending tracking push: ' + fbmOrders.length + '\n');

  for (const order of fbmOrders) {
    console.log('Amazon Order: ' + order.amazonOrderId);
    console.log('  Odoo Sale Order ID: ' + (order.odoo?.saleOrderId || 'NOT SET'));
    console.log('  Odoo Sale Order Name: ' + (order.odoo?.saleOrderName || 'NOT SET'));
    console.log('  Tracking Pushed: ' + (order.odoo?.trackingPushed || false));
    console.log('  Order Status: ' + order.orderStatus);
    console.log('  Items: ' + (order.items?.length || 0));
    console.log('');
  }

  // Also check if there are any FBM orders with tracking already pushed
  const pushedCount = await db.collection('seller_orders').countDocuments({
    fulfillmentChannel: 'MFN',
    'odoo.trackingPushed': true
  });

  console.log('=== Summary ===');
  console.log('FBM orders with tracking already pushed: ' + pushedCount);
  console.log('FBM orders pending tracking push: ' + fbmOrders.length);

  await client.close();
}

checkMongoFbm().catch(console.error);
