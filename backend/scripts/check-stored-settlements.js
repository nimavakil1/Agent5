require('dotenv').config();
const { connectDb, getDb } = require('../src/db');

const TARGET_ORDER_IDS = [
  '204-7196349-7992340',
  '205-8350856-4897102',
  '026-6860926-8294745',
  '026-8504421-0205103',
  '026-3262942-5229108',
  '203-3069498-5172339',
  '206-0218522-0445105',
  '204-5237231-4253101',
  '204-6740016-3306755',
  '206-4460570-6791536'
];

async function checkStoredSettlements() {
  await connectDb();
  const db = getDb();

  console.log('Checking MongoDB for stored settlement data...\n');

  // Check amazon_settlements collection
  console.log('========================================');
  console.log('AMAZON SETTLEMENTS COLLECTION');
  console.log('========================================\n');

  const settlements = await db.collection('amazon_settlements').find({}).toArray();
  console.log('Total settlements stored:', settlements.length);

  if (settlements.length > 0) {
    console.log('\nSettlements:');
    for (const s of settlements.slice(0, 10)) {
      console.log('  ID:', s.settlementId);
      console.log('    Period:', s.settlementStartDate, 'to', s.settlementEndDate);
      console.log('    Transactions:', s.transactionCount);
      console.log('');
    }
  }

  // Check seller_orders collection for these specific orders
  console.log('\n========================================');
  console.log('SELLER ORDERS COLLECTION');
  console.log('========================================\n');

  const orders = await db.collection('seller_orders').find({
    amazonOrderId: { $in: TARGET_ORDER_IDS }
  }).toArray();

  console.log('Target orders found in seller_orders:', orders.length);
  for (const o of orders) {
    console.log('\nOrder:', o.amazonOrderId);
    console.log('  Status:', o.status);
    console.log('  Total:', o.orderTotal);
    console.log('  Items:', o.items?.length || 0);
    if (o.items) {
      for (const item of o.items) {
        console.log('    -', item.title?.substring(0, 50));
        console.log('      Price:', item.itemPrice, '| Qty:', item.quantity);
      }
    }
  }

  // Check if there are any financial records
  console.log('\n========================================');
  console.log('OTHER COLLECTIONS');
  console.log('========================================\n');

  const collections = await db.listCollections().toArray();
  const relevantCollections = collections.filter(c =>
    c.name.includes('amazon') ||
    c.name.includes('settlement') ||
    c.name.includes('finance') ||
    c.name.includes('order')
  );

  console.log('Relevant collections:');
  for (const c of relevantCollections) {
    const count = await db.collection(c.name).countDocuments();
    console.log('  ', c.name, ':', count, 'documents');
  }

  // Check amazon_vcs_orders for these orders
  console.log('\n========================================');
  console.log('VCS ORDERS');
  console.log('========================================\n');

  const vcsOrders = await db.collection('amazon_vcs_orders').find({
    orderId: { $in: TARGET_ORDER_IDS }
  }).toArray();

  console.log('Target orders in VCS:', vcsOrders.length);
  for (const v of vcsOrders) {
    console.log('\nOrder:', v.orderId);
    console.log('  Item Price:', v.itemPrice);
    console.log('  Total:', v.totalActivityValueAmtVatIncl);
    console.log('  Tax Responsibility:', v.taxCollectionResponsibility);
    console.log('  Marketplace:', v.marketplaceId);
  }
}

checkStoredSettlements().then(() => process.exit(0)).catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
