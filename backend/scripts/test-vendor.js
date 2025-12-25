/**
 * Test script for Vendor Central integration
 */
require('dotenv').config();

const { getDb, connectDb } = require('../src/db');

async function test() {
  await connectDb();
  const db = getDb();

  // Check for pending acknowledgments
  const pendingAck = await db.collection('vendor_purchase_orders').find({
    'acknowledgment.acknowledged': { $ne: true },
    purchaseOrderState: { $ne: 'Closed' }
  }).limit(5).toArray();

  console.log('\n=== Pending Acknowledgments ===');
  console.log('Count:', pendingAck.length);
  pendingAck.forEach(po => {
    console.log('-', po.purchaseOrderNumber, po.marketplaceId, po.purchaseOrderState);
  });

  // Check for acknowledged POs with linked Odoo orders (ready for invoicing)
  const readyForInvoice = await db.collection('vendor_purchase_orders').find({
    'acknowledgment.acknowledged': true,
    'odoo.saleOrderId': { $exists: true },
    'invoices.0': { $exists: false }
  }).limit(5).toArray();

  console.log('\n=== Ready for Invoicing ===');
  console.log('Count:', readyForInvoice.length);
  readyForInvoice.forEach(po => {
    console.log('-', po.purchaseOrderNumber, '| Odoo:', po.odoo?.saleOrderName);
  });

  // Get a sample PO that needs acknowledgment
  if (pendingAck.length > 0) {
    const testPO = pendingAck[0];
    console.log('\n=== Sample PO for Testing ===');
    console.log('PO Number:', testPO.purchaseOrderNumber);
    console.log('Marketplace:', testPO.marketplaceId);
    console.log('State:', testPO.purchaseOrderState);
    console.log('Has Odoo:', !!testPO.odoo?.saleOrderId);
    console.log('Items:', testPO.items?.length || 0);
  }

  process.exit(0);
}

test().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
