#!/usr/bin/env node
/**
 * Link Amazon Vendor POs in MongoDB to existing Odoo sale.orders
 *
 * Matches purchaseOrderNumber with sale.order.client_order_ref
 * Updates MongoDB with Odoo order ID and name
 *
 * Usage: node scripts/link-vendor-pos-to-odoo.js [--dry-run]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const DRY_RUN = process.argv.includes('--dry-run');

async function linkPOsToOdoo() {
  console.log('=== Link Vendor POs to Odoo Orders ===\n');
  if (DRY_RUN) console.log('DRY RUN MODE - no changes will be made\n');

  // Connect to MongoDB
  await connectDb();
  const db = getDb();
  const collection = db.collection('vendor_purchase_orders');

  // Get all POs without Odoo link
  const pos = await collection.find({
    'odoo.saleOrderId': null
  }).toArray();

  console.log(`Found ${pos.length} POs without Odoo link\n`);

  if (pos.length === 0) {
    console.log('Nothing to link!');
    process.exit(0);
  }

  // Connect to Odoo
  const odoo = new OdooDirectClient();

  // Get all PO numbers
  const poNumbers = pos.map(po => po.purchaseOrderNumber);

  // Fetch matching sale.orders from Odoo in batches
  console.log('Fetching Odoo orders...');
  const odooOrders = await odoo.searchRead('sale.order',
    [['client_order_ref', 'in', poNumbers]],
    ['id', 'name', 'client_order_ref', 'state', 'invoice_ids']
  );

  console.log(`Found ${odooOrders.length} matching Odoo orders\n`);

  // Create lookup map: client_order_ref -> order
  const odooMap = {};
  for (const order of odooOrders) {
    odooMap[order.client_order_ref] = order;
  }

  // Update MongoDB
  let linked = 0;
  let notFound = 0;

  for (const po of pos) {
    const odooOrder = odooMap[po.purchaseOrderNumber];

    if (odooOrder) {
      if (!DRY_RUN) {
        await collection.updateOne(
          { purchaseOrderNumber: po.purchaseOrderNumber },
          {
            $set: {
              'odoo.saleOrderId': odooOrder.id,
              'odoo.saleOrderName': odooOrder.name,
              'odoo.saleOrderState': odooOrder.state,
              'odoo.invoiceIds': odooOrder.invoice_ids || [],
              updatedAt: new Date()
            }
          }
        );
      }
      linked++;
      console.log(`✓ ${po.purchaseOrderNumber} -> ${odooOrder.name}`);
    } else {
      notFound++;
      // Only log first 10 not found
      if (notFound <= 10) {
        console.log(`✗ ${po.purchaseOrderNumber} - no Odoo order found`);
      }
    }
  }

  if (notFound > 10) {
    console.log(`  ... and ${notFound - 10} more not found`);
  }

  console.log('\n=== Summary ===');
  console.log(`Linked: ${linked}`);
  console.log(`Not found: ${notFound}`);
  console.log(`Total: ${pos.length}`);

  if (DRY_RUN) {
    console.log('\nRun without --dry-run to apply changes');
  }

  process.exit(0);
}

linkPOsToOdoo().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
