/**
 * Debug VCS order to investigate fiscal position error
 */
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

async function run() {
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  console.log('Connected!');

  // Find all VCS records with this order ID pattern (shipment + return)
  const orders = await db.collection('amazon_vcs_orders').find({
    orderId: { $regex: '205-3589468-5360350' }
  }).toArray();

  console.log(`\nFound ${orders.length} VCS records for this order ID\n`);

  for (const order of orders) {
    console.log('=== VCS ORDER DETAILS ===');
    console.log('orderId:', order.orderId);
    console.log('transactionType:', order.transactionType);
    console.log('taxReportingScheme:', order.taxReportingScheme);
    console.log('shipToCountry:', order.shipToCountry);
    console.log('shipFromCountry:', order.shipFromCountry);
    console.log('marketplaceId:', order.marketplaceId);
    console.log('totalExclusive:', order.totalExclusive);
    console.log('totalTax:', order.totalTax);
    console.log('vatInvoiceNumber:', order.vatInvoiceNumber);
    console.log('status:', order.status);
    console.log('items:', JSON.stringify(order.items, null, 2));
    console.log('');
  }

  await client.close();
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
