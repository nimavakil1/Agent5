/**
 * Fix split orders that were affected by the isSplitOrder bug
 * Resets shipment data and re-sends with correct FBR picking
 */
require('dotenv').config();
const mongoose = require('mongoose');

const AFFECTED_ORDERS = [
  'A000DX7704',
  'A000E0KT9X',
  'A000E13342'
];

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const { getBolShipmentSync } = require('../src/services/bol/BolShipmentSync');
  const sync = await getBolShipmentSync();

  console.log('=== FIXING AFFECTED SPLIT ORDERS ===\n');

  for (const orderId of AFFECTED_ORDERS) {
    console.log(`\n--- Processing ${orderId} ---`);

    // 1. Reset shipment data
    const resetResult = await db.collection('unified_orders').updateOne(
      { 'sourceIds.bolOrderId': orderId },
      {
        $set: {
          'bol.shipmentConfirmedAt': null,
          'bol.shipmentReference': null,
          'bol.trackingCode': null,
          'status.source': 'OPEN',
          'status.unified': 'processing'
        }
      }
    );

    if (resetResult.matchedCount === 0) {
      console.log(`  ERROR: Order not found`);
      continue;
    }

    console.log(`  Reset: OK`);

    // 2. Re-send shipment with correct data
    const result = await sync.confirmSingleOrder(orderId);

    if (result.success) {
      console.log(`  Shipment sent: OK`);
      console.log(`    Picking: ${result.pickingName}`);
      console.log(`    Tracking: ${result.trackingRef}`);
    } else if (result.skipped) {
      console.log(`  SKIPPED: ${result.skipReason}`);
    } else {
      console.log(`  ERROR: ${result.error}`);
    }

    // Small delay between orders to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n=== DONE ===');

  // Verify all orders
  console.log('\n=== VERIFICATION ===');
  for (const orderId of AFFECTED_ORDERS) {
    const order = await db.collection('unified_orders').findOne(
      { 'sourceIds.bolOrderId': orderId },
      { projection: { 'bol.shipmentReference': 1, 'bol.trackingCode': 1, 'status': 1 } }
    );
    console.log(`\n${orderId}:`);
    console.log(`  Ref: ${order?.bol?.shipmentReference}`);
    console.log(`  Tracking: ${order?.bol?.trackingCode}`);
    console.log(`  Status: ${order?.status?.source}`);
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
