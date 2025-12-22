require('dotenv').config();
const { connectDb, getDb } = require('./src/db');

async function check() {
  await connectDb(process.env.MONGO_URI);
  const db = getDb();

  // Get all uploads
  const uploads = await db.collection('amazon_vcs_uploads').find({}).sort({uploadedAt: 1}).toArray();
  console.log('=== All uploads ===');
  console.log('Total uploads:', uploads.length);
  for (const u of uploads) {
    console.log('Upload:', u._id.toString());
    console.log('  Filename:', u.originalFilename);
    console.log('  reportId:', u.reportId);
    console.log('  uploadedAt:', u.uploadedAt);
    console.log('  orderCount:', u.orderCount);
    console.log('');
  }

  // Check distinct reportIds in orders
  const reportIds = await db.collection('amazon_vcs_orders').distinct('reportId');
  console.log('=== Distinct reportIds in orders ===');
  console.log(reportIds.map(r => r?.toString()));

  // Count orders by reportId
  const counts = await db.collection('amazon_vcs_orders').aggregate([
    { $group: { _id: '$reportId', count: { $sum: 1 } } }
  ]).toArray();
  console.log('\n=== Order counts by reportId ===');
  for (const c of counts) {
    console.log('reportId:', c._id?.toString(), '- count:', c.count);
  }

  process.exit(0);
}
check();
