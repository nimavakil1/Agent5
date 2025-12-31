#!/usr/bin/env node
/**
 * Fix FBM orders that are missing items data
 * Fetches items from Amazon API and updates MongoDB
 */

require('dotenv').config();
const { connectDb, getDb } = require('../src/db');
const { getSellerOrderImporter } = require('../src/services/amazon/seller');

async function fixMissingItems() {
  console.log('=== Fix Missing Order Items ===\n');

  await connectDb();
  const db = getDb();
  const collection = db.collection('seller_orders');

  // Find FBM orders without items
  const ordersWithoutItems = await collection.find({
    fulfillmentChannel: 'MFN',
    $or: [
      { items: { $exists: false } },
      { items: [] },
      { items: null }
    ]
  }).toArray();

  console.log(`Found ${ordersWithoutItems.length} FBM orders without items\n`);

  if (ordersWithoutItems.length === 0) {
    console.log('Nothing to fix!');
    process.exit(0);
  }

  // Initialize the importer (which has fetchOrderItems method)
  const importer = await getSellerOrderImporter();

  let fixed = 0;
  let errors = 0;

  for (const order of ordersWithoutItems) {
    const orderId = order.amazonOrderId;
    console.log(`Fetching items for ${orderId}...`);

    try {
      await importer.fetchOrderItems(orderId);

      // Verify the update
      const updated = await collection.findOne({ amazonOrderId: orderId });
      if (updated.items && updated.items.length > 0) {
        console.log(`  [OK] ${orderId} - ${updated.items.length} items`);
        fixed++;
      } else {
        console.log(`  [WARN] ${orderId} - Still no items after fetch`);
      }
    } catch (error) {
      console.log(`  [ERR] ${orderId} - ${error.message}`);
      errors++;
    }

    // Small delay to avoid API throttling
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n=== Summary ===');
  console.log(`Fixed: ${fixed}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total: ${ordersWithoutItems.length}`);

  process.exit(0);
}

fixMissingItems().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
