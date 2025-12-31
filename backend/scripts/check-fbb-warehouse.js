#!/usr/bin/env node
/**
 * Check FBB (Fulfilled By Bol) orders and their warehouse settings
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkFBBOrders() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Checking FBB Orders ===\n');

  // Get all sale orders that might be FBB
  // FBB orders have client_order_ref starting with FBB
  const fbbOrders = await odoo.searchRead('sale.order',
    [['client_order_ref', 'like', 'FBB%']],
    ['id', 'name', 'client_order_ref', 'warehouse_id', 'state', 'picking_ids'],
    200
  );

  console.log(`Found ${fbbOrders.length} FBB sale orders\n`);

  // Group by warehouse
  const byWarehouse = {};
  for (const o of fbbOrders) {
    const wh = o.warehouse_id ? `${o.warehouse_id[0]}:${o.warehouse_id[1]}` : 'None';
    if (!byWarehouse[wh]) byWarehouse[wh] = [];
    byWarehouse[wh].push(o);
  }

  console.log('FBB Orders by Warehouse:');
  for (const [wh, orders] of Object.entries(byWarehouse)) {
    console.log(`  ${wh}: ${orders.length} orders`);
  }

  // Find FBB orders with WRONG warehouse (should be BOL warehouse, not CW)
  const wrongWarehouse = fbbOrders.filter(o => o.warehouse_id && o.warehouse_id[0] === 1);

  console.log(`\nFBB orders with WRONG warehouse (CW instead of BOL): ${wrongWarehouse.length}`);

  if (wrongWarehouse.length > 0) {
    console.log('\n--- Orders to fix ---');
    for (const o of wrongWarehouse.slice(0, 20)) {
      console.log(`${o.name} | Ref: ${o.client_order_ref} | WH: ${o.warehouse_id[1]} | State: ${o.state}`);
    }
    if (wrongWarehouse.length > 20) {
      console.log(`... and ${wrongWarehouse.length - 20} more`);
    }
  }

  // Also check deliveries (stock.picking) with FBB origin
  console.log('\n=== Checking FBB Deliveries ===');

  const fbbPickings = await odoo.searchRead('stock.picking',
    [['origin', 'like', 'FBB%']],
    ['id', 'name', 'origin', 'location_id', 'state'],
    200
  );

  console.log(`Found ${fbbPickings.length} FBB deliveries\n`);

  // Group by source location
  const byLocation = {};
  for (const p of fbbPickings) {
    const loc = p.location_id ? p.location_id[1] : 'Unknown';
    if (!byLocation[loc]) byLocation[loc] = [];
    byLocation[loc].push(p);
  }

  console.log('FBB Deliveries by Source Location:');
  for (const [loc, pickings] of Object.entries(byLocation)) {
    console.log(`  ${loc}: ${pickings.length} deliveries`);
  }

  // Find deliveries from CW (wrong - should be from BOL)
  const wrongLocationPickings = fbbPickings.filter(p =>
    p.location_id && p.location_id[1].includes('CW')
  );

  console.log(`\nFBB deliveries from WRONG location (CW instead of BOL): ${wrongLocationPickings.length}`);

  if (wrongLocationPickings.length > 0) {
    console.log('\nExamples:');
    for (const p of wrongLocationPickings.slice(0, 10)) {
      console.log(`${p.name} | Origin: ${p.origin} | From: ${p.location_id[1]} | State: ${p.state}`);
    }
  }

  process.exit(0);
}

checkFBBOrders().catch(e => { console.error(e); process.exit(1); });
