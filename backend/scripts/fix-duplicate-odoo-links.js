#!/usr/bin/env node
/**
 * Find and fix MongoDB orders pointing to canceled Odoo orders
 * when an active Odoo order exists with the same Amazon order ID
 */

require('dotenv').config();
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function fixDuplicateLinks() {
  console.log('=== Fix Duplicate Odoo Links ===\n');

  // Connect to MongoDB
  await connectDb();
  const db = getDb();
  const collection = db.collection('seller_orders');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get ALL sale orders from Odoo
  console.log('Fetching all Odoo sale orders...');
  const allOrders = await odoo.searchRead('sale.order',
    [],
    ['id', 'name', 'state', 'client_order_ref'],
    0, 0, 'id desc'
  );
  console.log('Total sale orders:', allOrders.length);

  // Group by client_order_ref
  const byRef = {};
  for (const order of allOrders) {
    const ref = order.client_order_ref;
    if (!ref) continue;
    if (!byRef[ref]) byRef[ref] = [];
    byRef[ref].push(order);
  }

  // Find duplicates with both canceled and active orders
  console.log('\n=== Finding Duplicates ===\n');
  const fixes = [];

  for (const [ref, orders] of Object.entries(byRef)) {
    if (orders.length > 1) {
      const canceled = orders.filter(o => o.state === 'cancel');
      const active = orders.filter(o => o.state !== 'cancel');

      if (canceled.length > 0 && active.length > 0) {
        console.log(ref + ':');
        console.log('  Active:', active.map(o => `${o.name} (ID:${o.id})`).join(', '));
        console.log('  Canceled:', canceled.map(o => `${o.name} (ID:${o.id})`).join(', '));

        // Check if MongoDB points to the canceled order
        const mongoOrder = await collection.findOne({ amazonOrderId: ref });
        if (mongoOrder) {
          const currentOdooId = mongoOrder.odoo?.saleOrderId;
          const canceledIds = canceled.map(o => o.id);

          if (canceledIds.includes(currentOdooId)) {
            const correctOrder = active[0];
            fixes.push({
              amazonOrderId: ref,
              currentSaleOrderId: currentOdooId,
              correctSaleOrderId: correctOrder.id,
              correctSaleOrderName: correctOrder.name
            });
            console.log('  -> MongoDB points to CANCELED order! Will fix.');
          } else {
            console.log('  -> MongoDB already points to active order.');
          }
        } else {
          console.log('  -> Order not in MongoDB.');
        }
        console.log('');
      }
    }
  }

  console.log('\n=== Fixes Needed ===');
  console.log('Total:', fixes.length);

  if (fixes.length === 0) {
    console.log('Nothing to fix!');
    process.exit(0);
  }

  // Apply fixes
  console.log('\nApplying fixes...\n');

  for (const fix of fixes) {
    const result = await collection.updateOne(
      { amazonOrderId: fix.amazonOrderId },
      {
        $set: {
          'odoo.saleOrderId': fix.correctSaleOrderId,
          'odoo.saleOrderName': fix.correctSaleOrderName,
          'odoo.trackingPushed': false, // Reset so tracking gets pushed
          updatedAt: new Date()
        }
      }
    );

    console.log(`[${result.modifiedCount === 1 ? 'OK' : 'FAIL'}] ${fix.amazonOrderId} -> ${fix.correctSaleOrderName} (ID: ${fix.correctSaleOrderId})`);
  }

  console.log('\nDone!');
  process.exit(0);
}

fixDuplicateLinks().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
