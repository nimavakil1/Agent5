/**
 * Debug BOL order dates
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  console.log('=== BOL Order Date Debug ===\n');

  // Sample some orders from bol_orders
  console.log('Sample from bol_orders:');
  const bolSamples = await db.collection('bol_orders').find({}).sort({ _id: -1 }).limit(5).toArray();
  for (const order of bolSamples) {
    console.log(`  ${order.orderId}: orderPlacedDateTime=${order.orderPlacedDateTime} (type: ${typeof order.orderPlacedDateTime})`);
  }

  // Sample some orders from unified_orders
  console.log('\nSample from unified_orders (any channel):');
  const unifiedSamples = await db.collection('unified_orders').find({}).sort({ _id: -1 }).limit(5).toArray();
  for (const order of unifiedSamples) {
    console.log(`  ${order.orderId || order.sourceIds?.orderId}: channel=${order.channel}, orderDate=${order.orderDate} (type: ${typeof order.orderDate})`);
  }

  // Check the actual dates in bol_orders
  console.log('\n--- bol_orders date range ---');
  const oldest = await db.collection('bol_orders').find({}).sort({ orderPlacedDateTime: 1 }).limit(1).toArray();
  const newest = await db.collection('bol_orders').find({}).sort({ orderPlacedDateTime: -1 }).limit(1).toArray();

  if (oldest.length > 0) {
    console.log('Oldest order:', oldest[0].orderId, oldest[0].orderPlacedDateTime);
  }
  if (newest.length > 0) {
    console.log('Newest order:', newest[0].orderId, newest[0].orderPlacedDateTime);
  }

  // Check unified_orders for BOL channel
  console.log('\n--- unified_orders BOL channel ---');
  const bolUnified = await db.collection('unified_orders').find({ channel: 'BOL' }).limit(5).toArray();
  console.log('BOL orders in unified_orders:', bolUnified.length);
  for (const order of bolUnified) {
    console.log(`  ${order.orderId}: orderDate=${order.orderDate}`);
  }

  // Check distinct channels in unified_orders
  console.log('\n--- Channels in unified_orders ---');
  const channels = await db.collection('unified_orders').distinct('channel');
  console.log('Channels:', channels);

  // Count by channel
  const channelCounts = await db.collection('unified_orders').aggregate([
    { $group: { _id: '$channel', count: { $sum: 1 } } }
  ]).toArray();
  for (const c of channelCounts) {
    console.log(`  ${c._id}: ${c.count}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
