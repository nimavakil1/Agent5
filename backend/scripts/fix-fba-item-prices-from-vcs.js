#!/usr/bin/env node
/**
 * Fix FBA Order Item Prices from VCS Data
 *
 * Amazon SP-API doesn't return item prices for FBA orders.
 * This script updates unified_orders with prices from amazon_vcs_orders.
 *
 * Usage:
 *   MONGODB_URI="mongodb://localhost:27017/agent5" node scripts/fix-fba-item-prices-from-vcs.js
 *   Add --dry-run to preview changes without updating
 */

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log('=== Fix FBA Item Prices from VCS Data ===');
  console.log('Mode:', DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE UPDATE');
  console.log('');

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();

  const unifiedOrders = db.collection('unified_orders');
  const vcsOrders = db.collection('amazon_vcs_orders');

  // Step 1: Find FBA orders with 0 EUR items
  console.log('Step 1: Finding FBA orders with 0 EUR item prices...');

  const ordersToFix = await unifiedOrders.find({
    channel: 'amazon-seller',
    subChannel: 'FBA',
    $or: [
      { 'items.unitPrice': 0 },
      { 'items.unitPrice': null },
      { 'items.lineTotal': 0 },
      { 'items.lineTotal': null }
    ]
  }).toArray();

  console.log(`Found ${ordersToFix.length} FBA orders with 0 EUR item prices`);

  // Step 2: Match with VCS data and update
  let updated = 0;
  let skipped = 0;
  let noVcsData = 0;
  let errors = 0;

  for (const order of ordersToFix) {
    const amazonOrderId = order.sourceIds?.amazonOrderId;
    if (!amazonOrderId) {
      skipped++;
      continue;
    }

    // Find VCS order
    const vcsOrder = await vcsOrders.findOne({
      orderId: amazonOrderId,
      transactionType: 'SHIPMENT'
    });

    if (!vcsOrder || !vcsOrder.items || vcsOrder.items.length === 0) {
      noVcsData++;
      continue;
    }

    try {
      // Map VCS items by SKU
      const vcsItemsBySku = new Map();
      const vcsItemsByAsin = new Map();

      for (const vcsItem of vcsOrder.items) {
        if (vcsItem.sku) {
          vcsItemsBySku.set(vcsItem.sku, vcsItem);
        }
        if (vcsItem.asin) {
          vcsItemsByAsin.set(vcsItem.asin, vcsItem);
        }
      }

      // Update each item in unified order
      const updatedItems = order.items.map(item => {
        // Try to match by SKU first, then ASIN
        const vcsItem = vcsItemsBySku.get(item.sku) || vcsItemsByAsin.get(item.asin);

        if (vcsItem && (vcsItem.priceExclusive > 0 || vcsItem.priceInclusive > 0)) {
          const qty = item.quantity || 1;
          const lineTotal = vcsItem.priceInclusive || vcsItem.priceExclusive;
          const tax = vcsItem.taxAmount || 0;

          return {
            ...item,
            unitPrice: lineTotal / qty,
            lineTotal: lineTotal,
            tax: tax,
            // Keep original fields
            sku: item.sku,
            asin: item.asin,
            name: item.name,
            quantity: qty,
            quantityShipped: item.quantityShipped || 0,
            orderItemId: item.orderItemId
          };
        }
        return item;
      });

      // Calculate new totals
      const subtotal = updatedItems.reduce((sum, item) => sum + (item.lineTotal || 0), 0);
      const taxTotal = updatedItems.reduce((sum, item) => sum + (item.tax || 0), 0);
      const total = subtotal; // VCS prices are inclusive

      if (!DRY_RUN) {
        await unifiedOrders.updateOne(
          { _id: order._id },
          {
            $set: {
              items: updatedItems,
              'totals.subtotal': subtotal,
              'totals.tax': taxTotal,
              'totals.total': total,
              updatedAt: new Date(),
              'metadata.pricesUpdatedFromVcs': true,
              'metadata.pricesUpdatedAt': new Date()
            }
          }
        );
      }

      updated++;

      if (updated <= 5) {
        console.log(`  Updated: ${amazonOrderId}`);
        console.log(`    Before: items[0].unitPrice = ${order.items[0]?.unitPrice || 0}`);
        console.log(`    After:  items[0].unitPrice = ${updatedItems[0]?.unitPrice?.toFixed(2)}`);
        console.log(`    VCS:    priceInclusive = ${vcsOrder.items[0]?.priceInclusive}`);
      }
    } catch (err) {
      console.error(`  Error updating ${amazonOrderId}:`, err.message);
      errors++;
    }
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`Total FBA orders with 0 EUR prices: ${ordersToFix.length}`);
  console.log(`Updated with VCS prices: ${updated}`);
  console.log(`Skipped (no Amazon order ID): ${skipped}`);
  console.log(`No VCS data available: ${noVcsData}`);
  console.log(`Errors: ${errors}`);

  if (DRY_RUN) {
    console.log('');
    console.log('This was a DRY RUN. Run without --dry-run to apply changes.');
  }

  await client.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
