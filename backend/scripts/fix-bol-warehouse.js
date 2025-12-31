#!/usr/bin/env node
/**
 * Fix BOL FBB orders - change warehouse from CW to BOL
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function fixBolWarehouse() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // First, let's see all BOL orders and their warehouses
  console.log('=== Analyzing BOL Orders ===\n');

  const orders = await odoo.searchRead('sale.order',
    [['name', 'like', 'BOL%']],
    ['id', 'name', 'warehouse_id', 'state', 'picking_ids'],
    500
  );

  // Group by warehouse
  const byWarehouse = {};
  for (const o of orders) {
    const whName = o.warehouse_id ? o.warehouse_id[1] : 'None';
    const whId = o.warehouse_id ? o.warehouse_id[0] : 0;
    const key = `${whId}:${whName}`;
    if (!byWarehouse[key]) byWarehouse[key] = [];
    byWarehouse[key].push(o);
  }

  console.log('BOL Orders by Warehouse:');
  for (const [wh, orderList] of Object.entries(byWarehouse)) {
    console.log(`  ${wh}: ${orderList.length} orders`);
  }

  // Find orders with CW warehouse (ID: 1)
  const wrongWarehouseOrders = orders.filter(o => o.warehouse_id && o.warehouse_id[0] === 1);

  console.log(`\nOrders with WRONG warehouse (CW instead of BOL): ${wrongWarehouseOrders.length}`);

  if (wrongWarehouseOrders.length === 0) {
    console.log('No orders need warehouse fix.');

    // Check recent deliveries anyway
    console.log('\n=== Checking Recent BOL Deliveries ===');
    const pickings = await odoo.searchRead('stock.picking',
      [['origin', 'like', 'BOL%']],
      ['id', 'name', 'origin', 'location_id', 'location_dest_id', 'partner_id', 'state'],
      30, 0, 'id desc'
    );

    for (const p of pickings) {
      console.log(`${p.name} | ${p.origin} | From: ${p.location_id?.[1]} | Partner: ${p.partner_id?.[1]?.substring(0, 30) || 'N/A'} | ${p.state}`);
    }

    process.exit(0);
    return;
  }

  // Fix orders
  console.log('\n=== Fixing Orders ===');
  const BOL_WAREHOUSE_ID = 3; // Bol.com warehouse

  for (const order of wrongWarehouseOrders) {
    console.log(`\nFixing ${order.name}...`);

    // Update sale order warehouse
    await odoo.write('sale.order', [order.id], {
      warehouse_id: BOL_WAREHOUSE_ID
    });
    console.log(`  Updated sale.order warehouse to BOL`);

    // Update related pickings
    if (order.picking_ids && order.picking_ids.length > 0) {
      // Get pickings to find their current location
      const pickings = await odoo.searchRead('stock.picking',
        [['id', 'in', order.picking_ids]],
        ['id', 'name', 'location_id', 'state']
      );

      for (const picking of pickings) {
        // Only update if not done/cancelled
        if (picking.state !== 'done' && picking.state !== 'cancel') {
          // Get BOL warehouse stock location
          const bolWarehouse = await odoo.searchRead('stock.warehouse',
            [['id', '=', BOL_WAREHOUSE_ID]],
            ['lot_stock_id']
          );

          if (bolWarehouse.length > 0 && bolWarehouse[0].lot_stock_id) {
            await odoo.write('stock.picking', [picking.id], {
              location_id: bolWarehouse[0].lot_stock_id[0]
            });
            console.log(`  Updated ${picking.name} location to BOL stock`);
          }
        } else {
          console.log(`  ${picking.name} already ${picking.state}, skipping`);
        }
      }
    }
  }

  console.log('\n=== Done ===');
  console.log(`Fixed ${wrongWarehouseOrders.length} orders`);

  process.exit(0);
}

fixBolWarehouse().catch(e => { console.error(e); process.exit(1); });
