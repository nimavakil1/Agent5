/**
 * Check VCS orders in MongoDB
 */
require('dotenv').config();
const { connectDb, getDb } = require('./src/db');

async function checkOrders() {
  await connectDb(process.env.MONGO_URI);
  const db = getDb();
  console.log('Connected to MongoDB');

  // Count all VCS orders
  const totalOrders = await db.collection('amazon_vcs_orders').countDocuments();
  console.log('\nTotal VCS orders in database:', totalOrders);

  // Group by status
  const byStatus = await db.collection('amazon_vcs_orders').aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  console.log('\nOrders by status:');
  for (const s of byStatus) {
    console.log('  ', s._id, ':', s.count);
  }

  // Count invoiced orders (those with odooInvoiceId)
  const invoicedOrders = await db.collection('amazon_vcs_orders').countDocuments({
    odooInvoiceId: { $exists: true }
  });
  console.log('\nOrders with odooInvoiceId:', invoicedOrders);

  // Show some sample invoiced orders
  const sampleInvoiced = await db.collection('amazon_vcs_orders')
    .find({ odooInvoiceId: { $exists: true } })
    .limit(5)
    .toArray();
  console.log('\nSample invoiced orders:');
  for (const o of sampleInvoiced) {
    console.log('  ', o.orderId, '-> Invoice ID:', o.odooInvoiceId, o.odooInvoiceName);
  }

  // Count reports
  const reports = await db.collection('amazon_vcs_reports').find().toArray();
  console.log('\n=== VCS Reports ===');
  for (const r of reports) {
    console.log('  Report:', r._id.toString());
    console.log('    File:', r.filename);
    console.log('    Orders:', r.orderCount);
    console.log('    Transactions:', r.transactionCount);
    console.log('    Status:', r.status);
    console.log('    Date range:', r.dateRange?.from, '-', r.dateRange?.to);
    console.log('');
  }

  process.exit(0);
}

checkOrders().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
