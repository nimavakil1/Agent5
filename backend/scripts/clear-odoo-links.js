/**
 * Clear Odoo links for specific orders so they can be reimported
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  // Orders to clear
  const orderIds = ['404-4044081-5645938', '306-3650136-2167568'];

  console.log('Clearing Odoo links for', orderIds.length, 'orders...\n');

  for (const amazonOrderId of orderIds) {
    const result = await db.collection('unified_orders').updateOne(
      { 'sourceIds.amazonOrderId': amazonOrderId },
      {
        $set: {
          'sourceIds.odooSaleOrderId': null,
          'sourceIds.odooSaleOrderName': null,
          'odoo.saleOrderId': null,
          'odoo.saleOrderName': null,
          'odoo.partnerId': null,
          'odoo.syncedAt': null,
          'customer.odooPartnerId': null,
          'customer.odooPartnerName': null,
          'status.odoo': null,
          updatedAt: new Date()
        }
      }
    );
    console.log('✓ Cleared Odoo link for', amazonOrderId, '- Modified:', result.modifiedCount);
  }

  console.log('\nDone! Now re-upload the TSV file and click "Create Pending Odoo Orders"');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
