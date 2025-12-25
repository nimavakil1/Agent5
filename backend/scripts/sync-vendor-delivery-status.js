#!/usr/bin/env node
/**
 * Sync Vendor PO Delivery Status from Odoo to MongoDB
 *
 * Updates MongoDB shipmentStatus based on Odoo delivery_status field:
 * - 'full' → 'fully_shipped'
 * - 'pending' → 'not_shipped'
 * - false/null → 'not_shipped'
 *
 * Usage: node scripts/sync-vendor-delivery-status.js [--dry-run]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const DRY_RUN = process.argv.includes('--dry-run');

async function syncDeliveryStatus() {
  console.log('=== Sync Vendor PO Delivery Status from Odoo ===\n');
  if (DRY_RUN) console.log('DRY RUN MODE - no changes will be made\n');

  // Connect to MongoDB
  await connectDb();
  const db = getDb();
  const collection = db.collection('vendor_purchase_orders');

  // Get all POs with Odoo link
  const pos = await collection.find({
    'odoo.saleOrderId': { $ne: null }
  }).toArray();

  console.log(`Found ${pos.length} POs with Odoo links\n`);

  if (pos.length === 0) {
    console.log('Nothing to sync!');
    process.exit(0);
  }

  // Connect to Odoo
  const odoo = new OdooDirectClient();

  // Get all Odoo order IDs
  const odooOrderIds = pos.map(po => po.odoo.saleOrderId);

  // Fetch delivery_status from Odoo (in batches to avoid limits)
  console.log('Fetching delivery status from Odoo...');
  const odooOrders = [];
  const batchSize = 200;

  for (let i = 0; i < odooOrderIds.length; i += batchSize) {
    const batchIds = odooOrderIds.slice(i, i + batchSize);
    const batch = await odoo.searchRead('sale.order',
      [['id', 'in', batchIds]],
      ['id', 'name', 'delivery_status', 'state'],
      { limit: batchSize }
    );
    odooOrders.push(...batch);
  }

  console.log(`Got ${odooOrders.length} orders from Odoo\n`);

  // Create lookup map: order_id -> delivery info
  const odooMap = {};
  for (const order of odooOrders) {
    odooMap[order.id] = {
      name: order.name,
      deliveryStatus: order.delivery_status,
      state: order.state
    };
  }

  // Update MongoDB
  let updated = 0;
  let notFound = 0;
  let unchanged = 0;

  const stats = {
    fully_shipped: 0,
    not_shipped: 0,
    cancelled: 0
  };

  for (const po of pos) {
    const odooOrder = odooMap[po.odoo.saleOrderId];

    if (!odooOrder) {
      notFound++;
      continue;
    }

    // Map Odoo delivery_status to our shipmentStatus
    let shipmentStatus;
    if (odooOrder.state === 'cancel') {
      shipmentStatus = 'cancelled';
    } else if (odooOrder.deliveryStatus === 'full') {
      shipmentStatus = 'fully_shipped';
    } else {
      shipmentStatus = 'not_shipped';
    }

    stats[shipmentStatus]++;

    // Check if update needed
    if (po.shipmentStatus === shipmentStatus) {
      unchanged++;
      continue;
    }

    if (!DRY_RUN) {
      await collection.updateOne(
        { purchaseOrderNumber: po.purchaseOrderNumber },
        {
          $set: {
            shipmentStatus: shipmentStatus,
            'odoo.deliveryStatus': odooOrder.deliveryStatus,
            'odoo.saleOrderState': odooOrder.state,
            updatedAt: new Date()
          }
        }
      );
    }

    updated++;
    if (updated <= 20) {
      console.log(`${DRY_RUN ? 'Would update' : 'Updated'} ${po.purchaseOrderNumber} (${odooOrder.name}): ${po.shipmentStatus || 'null'} → ${shipmentStatus}`);
    }
  }

  if (updated > 20) {
    console.log(`  ... and ${updated - 20} more`);
  }

  console.log('\n=== Summary ===');
  console.log(`Total POs with Odoo link: ${pos.length}`);
  console.log(`Updated: ${updated}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Not found in Odoo: ${notFound}`);
  console.log('\nStatus breakdown:');
  console.log(`  Fully shipped: ${stats.fully_shipped}`);
  console.log(`  Not shipped: ${stats.not_shipped}`);
  console.log(`  Cancelled: ${stats.cancelled}`);

  if (DRY_RUN) {
    console.log('\nRun without --dry-run to apply changes');
  }

  process.exit(0);
}

syncDeliveryStatus().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
