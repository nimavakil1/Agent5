/**
 * Fix FBM orders in unified_orders collection
 *
 * The TSV import was only updating seller_orders.odoo.saleOrderId
 * but countFbmOrdersPendingManualImport() checks unified_orders.sourceIds.odooSaleOrderId
 *
 * This script syncs the Odoo info from seller_orders to unified_orders
 */

const { MongoClient } = require('mongodb');

async function fixFbmUnifiedOrders() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db();

    console.log('=== FBM Orders Fix Script ===\n');

    // Find all FBM orders in seller_orders that have Odoo info
    const sellerOrdersWithOdoo = await db.collection('seller_orders').find({
      fulfillmentChannel: 'MFN',
      'odoo.saleOrderId': { $ne: null }
    }).toArray();

    console.log(`Found ${sellerOrdersWithOdoo.length} FBM orders in seller_orders with Odoo info\n`);

    let fixed = 0;
    let alreadyOk = 0;
    let notInUnified = 0;

    for (const sellerOrder of sellerOrdersWithOdoo) {
      const amazonOrderId = sellerOrder.amazonOrderId;

      // Check unified_orders
      const unifiedOrder = await db.collection('unified_orders').findOne({
        'sourceIds.amazonOrderId': amazonOrderId
      });

      if (!unifiedOrder) {
        notInUnified++;
        continue;
      }

      const hasOdooId = unifiedOrder.sourceIds && unifiedOrder.sourceIds.odooSaleOrderId;

      if (hasOdooId) {
        alreadyOk++;
        continue;
      }

      // Fix it - copy Odoo info to unified_orders
      await db.collection('unified_orders').updateOne(
        { 'sourceIds.amazonOrderId': amazonOrderId },
        { $set: {
          'sourceIds.odooSaleOrderId': sellerOrder.odoo.saleOrderId,
          'sourceIds.odooSaleOrderName': sellerOrder.odoo.saleOrderName,
          'sourceIds.odooPartnerId': sellerOrder.odoo.partnerId
        }}
      );

      console.log(`Fixed: ${amazonOrderId} -> odooSaleOrderId: ${sellerOrder.odoo.saleOrderId}`);
      fixed++;
    }

    console.log(`\n=== Summary ===`);
    console.log(`Fixed: ${fixed}`);
    console.log(`Already OK: ${alreadyOk}`);
    console.log(`Not in unified_orders: ${notInUnified}`);

    // Check remaining FBM orders without Odoo ID
    const remaining = await db.collection('unified_orders').countDocuments({
      channel: 'amazon_seller',
      'amazonSeller.fulfillmentChannel': 'MFN',
      'sourceIds.odooSaleOrderId': null
    });
    console.log(`\nRemaining FBM orders without odooSaleOrderId: ${remaining}`);

  } finally {
    await client.close();
  }
}

fixFbmUnifiedOrders().catch(console.error);
