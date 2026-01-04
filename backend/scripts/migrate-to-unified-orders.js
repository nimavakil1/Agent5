#!/usr/bin/env node
/**
 * Migrate to Unified Orders Collection
 *
 * This script migrates existing orders from:
 * - seller_orders (Amazon Seller)
 * - vendor_purchase_orders (Amazon Vendor)
 * - bol_orders (Bol.com)
 *
 * Into the new unified_orders collection.
 *
 * Usage:
 *   node scripts/migrate-to-unified-orders.js [--dry-run] [--channel=<channel>] [--limit=<n>]
 *
 * Options:
 *   --dry-run     Preview without writing
 *   --channel     Only migrate specific channel (seller, vendor, bol)
 *   --limit       Limit number of records per channel
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
const { getUnifiedOrderService } = require('../src/services/orders/UnifiedOrderService');
const {
  transformSellerOrder,
  transformVendorOrder,
  transformBolOrder
} = require('../src/services/orders/transformers');

// Parse CLI arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const channelArg = args.find(a => a.startsWith('--channel='))?.split('=')[1];
const limitArg = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || 0;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

// Statistics
const stats = {
  seller: { processed: 0, migrated: 0, errors: 0, skipped: 0 },
  vendor: { processed: 0, migrated: 0, errors: 0, skipped: 0 },
  bol: { processed: 0, migrated: 0, errors: 0, skipped: 0 },
  total: { processed: 0, migrated: 0, errors: 0, skipped: 0 }
};

/**
 * Migrate Amazon Seller orders
 */
async function migrateSellerOrders(db, service, limit = 0) {
  console.log('\n=== Migrating Amazon Seller Orders ===\n');

  const collection = db.collection('seller_orders');
  const cursor = collection.find({}).limit(limit || 0);

  let batch = [];
  const BATCH_SIZE = 100;

  while (await cursor.hasNext()) {
    const sellerOrder = await cursor.next();
    stats.seller.processed++;
    stats.total.processed++;

    try {
      const unified = transformSellerOrder(sellerOrder);

      if (dryRun) {
        if (stats.seller.processed <= 3) {
          console.log('Sample unified order:', JSON.stringify(unified, null, 2).substring(0, 500) + '...');
        }
        stats.seller.migrated++;
        stats.total.migrated++;
      } else {
        batch.push(unified);

        if (batch.length >= BATCH_SIZE) {
          await writeBatch(service, batch, 'seller');
          batch = [];
        }
      }
    } catch (error) {
      console.error(`Error transforming seller order ${sellerOrder.amazonOrderId}:`, error.message);
      stats.seller.errors++;
      stats.total.errors++;
    }

    if (stats.seller.processed % 1000 === 0) {
      console.log(`  Processed ${stats.seller.processed} seller orders...`);
    }
  }

  // Write remaining batch
  if (!dryRun && batch.length > 0) {
    await writeBatch(service, batch, 'seller');
  }

  console.log(`  Seller orders: ${stats.seller.processed} processed, ${stats.seller.migrated} migrated, ${stats.seller.errors} errors`);
}

/**
 * Migrate Amazon Vendor orders
 */
async function migrateVendorOrders(db, service, limit = 0) {
  console.log('\n=== Migrating Amazon Vendor Orders ===\n');

  const collection = db.collection('vendor_purchase_orders');
  const cursor = collection.find({}).limit(limit || 0);

  let batch = [];
  const BATCH_SIZE = 100;

  while (await cursor.hasNext()) {
    const vendorPO = await cursor.next();
    stats.vendor.processed++;
    stats.total.processed++;

    try {
      const unified = transformVendorOrder(vendorPO);

      if (dryRun) {
        if (stats.vendor.processed <= 3) {
          console.log('Sample unified order:', JSON.stringify(unified, null, 2).substring(0, 500) + '...');
        }
        stats.vendor.migrated++;
        stats.total.migrated++;
      } else {
        batch.push(unified);

        if (batch.length >= BATCH_SIZE) {
          await writeBatch(service, batch, 'vendor');
          batch = [];
        }
      }
    } catch (error) {
      console.error(`Error transforming vendor PO ${vendorPO.purchaseOrderNumber}:`, error.message);
      stats.vendor.errors++;
      stats.total.errors++;
    }

    if (stats.vendor.processed % 500 === 0) {
      console.log(`  Processed ${stats.vendor.processed} vendor orders...`);
    }
  }

  // Write remaining batch
  if (!dryRun && batch.length > 0) {
    await writeBatch(service, batch, 'vendor');
  }

  console.log(`  Vendor orders: ${stats.vendor.processed} processed, ${stats.vendor.migrated} migrated, ${stats.vendor.errors} errors`);
}

/**
 * Migrate Bol.com orders
 */
async function migrateBolOrders(db, service, limit = 0) {
  console.log('\n=== Migrating Bol.com Orders ===\n');

  const collection = db.collection('bol_orders');
  const cursor = collection.find({}).limit(limit || 0);

  let batch = [];
  const BATCH_SIZE = 100;

  while (await cursor.hasNext()) {
    const bolOrder = await cursor.next();
    stats.bol.processed++;
    stats.total.processed++;

    try {
      const unified = transformBolOrder(bolOrder);

      if (dryRun) {
        if (stats.bol.processed <= 3) {
          console.log('Sample unified order:', JSON.stringify(unified, null, 2).substring(0, 500) + '...');
        }
        stats.bol.migrated++;
        stats.total.migrated++;
      } else {
        batch.push(unified);

        if (batch.length >= BATCH_SIZE) {
          await writeBatch(service, batch, 'bol');
          batch = [];
        }
      }
    } catch (error) {
      console.error(`Error transforming Bol order ${bolOrder.orderId}:`, error.message);
      stats.bol.errors++;
      stats.total.errors++;
    }

    if (stats.bol.processed % 500 === 0) {
      console.log(`  Processed ${stats.bol.processed} Bol orders...`);
    }
  }

  // Write remaining batch
  if (!dryRun && batch.length > 0) {
    await writeBatch(service, batch, 'bol');
  }

  console.log(`  Bol orders: ${stats.bol.processed} processed, ${stats.bol.migrated} migrated, ${stats.bol.errors} errors`);
}

/**
 * Write a batch of orders
 */
async function writeBatch(service, batch, channel) {
  for (const order of batch) {
    try {
      await service.upsert(order.unifiedOrderId, order);
      stats[channel].migrated++;
      stats.total.migrated++;
    } catch (error) {
      if (error.code === 11000) {
        // Duplicate key - already migrated
        stats[channel].skipped++;
        stats.total.skipped++;
      } else {
        console.error(`Error upserting ${order.unifiedOrderId}:`, error.message);
        stats[channel].errors++;
        stats.total.errors++;
      }
    }
  }
}

/**
 * Main migration function
 */
async function main() {
  console.log('===========================================');
  console.log('  Unified Orders Migration');
  console.log('===========================================');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  if (channelArg) console.log(`Channel: ${channelArg}`);
  if (limitArg) console.log(`Limit: ${limitArg} per channel`);
  console.log(`Database: ${MONGODB_URI}`);
  console.log('');

  let client;

  try {
    // Connect to MongoDB (native driver for raw access)
    client = await MongoClient.connect(MONGODB_URI);
    const db = client.db();

    // Connect mongoose for Bol.com model
    await mongoose.connect(MONGODB_URI);

    // Initialize unified order service
    const service = getUnifiedOrderService();
    await service.init();

    // Check existing counts
    const existingCount = await db.collection('unified_orders').countDocuments();
    console.log(`Existing unified_orders: ${existingCount}`);

    // Get source counts
    const sellerCount = await db.collection('seller_orders').countDocuments();
    const vendorCount = await db.collection('vendor_purchase_orders').countDocuments();
    const bolCount = await db.collection('bol_orders').countDocuments();

    console.log(`\nSource collections:`);
    console.log(`  seller_orders: ${sellerCount}`);
    console.log(`  vendor_purchase_orders: ${vendorCount}`);
    console.log(`  bol_orders: ${bolCount}`);
    console.log(`  Total: ${sellerCount + vendorCount + bolCount}`);

    // Run migrations
    if (!channelArg || channelArg === 'seller') {
      await migrateSellerOrders(db, service, limitArg);
    }

    if (!channelArg || channelArg === 'vendor') {
      await migrateVendorOrders(db, service, limitArg);
    }

    if (!channelArg || channelArg === 'bol') {
      await migrateBolOrders(db, service, limitArg);
    }

    // Final summary
    console.log('\n===========================================');
    console.log('  Migration Summary');
    console.log('===========================================');
    console.log(`Total processed: ${stats.total.processed}`);
    console.log(`Total migrated:  ${stats.total.migrated}`);
    console.log(`Total skipped:   ${stats.total.skipped}`);
    console.log(`Total errors:    ${stats.total.errors}`);

    if (!dryRun) {
      const finalCount = await db.collection('unified_orders').countDocuments();
      console.log(`\nFinal unified_orders count: ${finalCount}`);
    }

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    if (client) await client.close();
    await mongoose.disconnect();
  }

  console.log('\nMigration complete!');
  process.exit(0);
}

// Run
main();
