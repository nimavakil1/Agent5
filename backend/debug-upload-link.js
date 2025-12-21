/**
 * Debug the link between uploads and orders
 */
require('dotenv').config();
const { connectDb, getDb } = require('./src/db');

async function debug() {
  await connectDb(process.env.MONGO_URI);
  const db = getDb();
  console.log('Connected to MongoDB');

  // Get the upload record
  const uploads = await db.collection('amazon_vcs_uploads')
    .find({})
    .sort({ uploadedAt: -1 })
    .limit(5)
    .toArray();

  console.log(`\n=== Last ${uploads.length} uploads ===`);
  for (const u of uploads) {
    console.log(`\nUpload ID: ${u._id}`);
    console.log(`  Filename: ${u.originalFilename}`);
    console.log(`  Report ID: ${u.reportId}`);
    console.log(`  uploadedAt: ${u.uploadedAt}`);
    console.log(`  pendingOrders (stored): ${u.pendingOrders}`);
    console.log(`  invoicedOrders (stored): ${u.invoicedOrders}`);
  }

  // Check orders - what reportId do they have?
  const orders = await db.collection('amazon_vcs_orders')
    .find({})
    .limit(10)
    .toArray();

  console.log(`\n=== Sample orders ===`);
  for (const o of orders) {
    console.log(`  ${o.orderId} - reportId: ${o.reportId} - status: ${o.status}`);
  }

  // Check if orders have reportId matching uploads
  const uploadReportIds = uploads.map(u => u.reportId).filter(Boolean);
  console.log(`\n=== Upload reportIds ===`);
  console.log(uploadReportIds);

  // Check distinct reportIds in orders
  const distinctReportIds = await db.collection('amazon_vcs_orders').distinct('reportId');
  console.log(`\n=== Distinct reportIds in orders ===`);
  console.log(distinctReportIds);

  // Count orders by status
  const statusCounts = await db.collection('amazon_vcs_orders').aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  console.log(`\n=== Order status counts ===`);
  for (const s of statusCounts) {
    console.log(`  ${s._id}: ${s.count}`);
  }

  process.exit(0);
}

debug().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
