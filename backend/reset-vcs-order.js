require('dotenv').config();
const { connectDb, getDb } = require('./src/db');

async function reset() {
  await connectDb(process.env.MONGO_URI);
  const db = getDb();

  // Reset the VCS order so it can be re-processed
  const result = await db.collection('amazon_vcs_orders').updateOne(
    { orderId: '404-0306410-8965972' },
    {
      $unset: {
        odooSaleOrderId: '',
        odooSaleOrderName: '',
        orderCreatedAt: ''
      },
      $set: { status: 'pending' }
    }
  );

  console.log('Reset result:', result.modifiedCount > 0 ? 'Success' : 'No change');

  // Verify
  const order = await db.collection('amazon_vcs_orders').findOne({ orderId: '404-0306410-8965972' });
  console.log('Order status:', order.status);
  console.log('odooSaleOrderId:', order.odooSaleOrderId);

  process.exit(0);
}
reset();
