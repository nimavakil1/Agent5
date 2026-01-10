/**
 * Debug FBM order quantities
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  console.log('=== Debug FBM Order Quantities ===\n');

  // Find recent FBM orders from TSV import
  const recentFbmOrders = await db.collection('unified_orders').find({
    channel: 'amazon-seller',
    subChannel: 'FBM',
    'tsvImport.importedAt': { $exists: true }
  }).sort({ 'tsvImport.importedAt': -1 }).limit(10).toArray();

  console.log(`Found ${recentFbmOrders.length} recent FBM orders from TSV import\n`);

  for (const order of recentFbmOrders) {
    console.log(`Order: ${order.sourceIds?.amazonOrderId}`);
    console.log(`  Imported: ${order.tsvImport?.importedAt}`);
    console.log(`  Odoo Order: ${order.sourceIds?.odooSaleOrderName || 'Not created yet'}`);
    console.log(`  Items:`);

    for (const item of order.items || []) {
      console.log(`    - SKU: ${item.sku || item.sellerSku}`);
      console.log(`      quantity: ${item.quantity}`);
      console.log(`      unitPrice: ${item.unitPrice}`);
      console.log(`      lineTotal: ${item.lineTotal}`);
    }
    console.log('');
  }

  // Check if any orders have quantity > 1
  const ordersWithMultiQty = await db.collection('unified_orders').find({
    channel: 'amazon-seller',
    subChannel: 'FBM',
    'items.quantity': { $gt: 1 }
  }).limit(5).toArray();

  console.log(`\n--- Orders with quantity > 1 ---`);
  console.log(`Found: ${ordersWithMultiQty.length}`);

  for (const order of ordersWithMultiQty) {
    console.log(`\nOrder: ${order.sourceIds?.amazonOrderId}`);
    for (const item of order.items || []) {
      if (item.quantity > 1) {
        console.log(`  SKU: ${item.sku}, Qty: ${item.quantity}`);
      }
    }
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
