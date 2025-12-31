#!/usr/bin/env node
/**
 * Bulk sync customer names from Odoo to MongoDB
 *
 * This script updates MongoDB seller_orders with customer names from Odoo
 * for all orders that have an Odoo sale order linked.
 *
 * Usage:
 *   node scripts/sync-customer-names-from-odoo.js
 *   node scripts/sync-customer-names-from-odoo.js --dry-run
 */

require('dotenv').config();
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function syncCustomerNames() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('=== Sync Customer Names from Odoo to MongoDB ===');
  console.log(isDryRun ? '(DRY RUN - no changes will be made)\n' : '\n');

  // Connect to MongoDB
  await connectDb();
  const db = getDb();
  const collection = db.collection('seller_orders');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  // Find all orders with Odoo sale order but missing customer name
  const ordersToUpdate = await collection.find({
    'odoo.saleOrderId': { $ne: null },
    $or: [
      { buyerName: { $in: [null, '', '-'] } },
      { 'shippingAddress.name': { $in: [null, '', '-'] } },
      { buyerName: { $exists: false } },
      { 'shippingAddress.name': { $exists: false } }
    ]
  }).toArray();

  console.log(`Found ${ordersToUpdate.length} orders needing customer name sync\n`);

  if (ordersToUpdate.length === 0) {
    console.log('Nothing to update!');
    process.exit(0);
  }

  // Batch fetch sale orders from Odoo (more efficient)
  const saleOrderIds = ordersToUpdate
    .map(o => o.odoo?.saleOrderId)
    .filter(id => id != null);

  console.log(`Fetching ${saleOrderIds.length} sale orders from Odoo...`);

  // Fetch in batches of 100
  const saleOrders = [];
  for (let i = 0; i < saleOrderIds.length; i += 100) {
    const batch = saleOrderIds.slice(i, i + 100);
    const results = await odoo.searchRead('sale.order',
      [['id', 'in', batch]],
      ['id', 'name', 'partner_id', 'partner_shipping_id']
    );
    saleOrders.push(...results);
    console.log(`  Fetched ${saleOrders.length}/${saleOrderIds.length} orders...`);
  }

  // Create lookup map
  const saleOrderMap = {};
  for (const so of saleOrders) {
    saleOrderMap[so.id] = so;
  }

  console.log(`\nUpdating MongoDB records...\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const order of ordersToUpdate) {
    const saleOrderId = order.odoo?.saleOrderId;
    const saleOrder = saleOrderMap[saleOrderId];

    if (!saleOrder) {
      console.log(`  [SKIP] ${order.amazonOrderId} - Sale order ${saleOrderId} not found in Odoo`);
      skipped++;
      continue;
    }

    // Get partner name (partner_id is [id, name] tuple in Odoo)
    const partnerId = saleOrder.partner_id ? saleOrder.partner_id[0] : null;
    const partnerName = saleOrder.partner_id ? saleOrder.partner_id[1] : null;

    // Get shipping partner name if different
    const shippingPartnerId = saleOrder.partner_shipping_id ? saleOrder.partner_shipping_id[0] : null;
    const shippingPartnerName = saleOrder.partner_shipping_id ? saleOrder.partner_shipping_id[1] : null;

    if (!partnerName) {
      console.log(`  [SKIP] ${order.amazonOrderId} - No partner name in Odoo order ${saleOrder.name}`);
      skipped++;
      continue;
    }

    // Use shipping partner name if available, otherwise use main partner
    const displayName = shippingPartnerName || partnerName;

    if (isDryRun) {
      console.log(`  [DRY] ${order.amazonOrderId} -> "${displayName}"`);
      updated++;
    } else {
      try {
        await collection.updateOne(
          { amazonOrderId: order.amazonOrderId },
          {
            $set: {
              buyerName: displayName,
              'shippingAddress.name': shippingPartnerName || displayName,
              'odoo.partnerId': partnerId,
              'odoo.shippingPartnerId': shippingPartnerId,
              updatedAt: new Date()
            }
          }
        );
        console.log(`  [OK] ${order.amazonOrderId} -> "${displayName}"`);
        updated++;
      } catch (error) {
        console.log(`  [ERR] ${order.amazonOrderId} - ${error.message}`);
        errors++;
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors:  ${errors}`);
  console.log(`Total:   ${ordersToUpdate.length}`);

  if (isDryRun) {
    console.log('\n(This was a dry run - run without --dry-run to apply changes)');
  }

  process.exit(0);
}

syncCustomerNames().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
