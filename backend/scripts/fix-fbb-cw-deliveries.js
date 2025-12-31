#!/usr/bin/env node
/**
 * Fix FBB orders that incorrectly have CW warehouse instead of BOL
 *
 * Issue: FBB (Fulfilled By Bol) orders are showing CW/OUT deliveries
 * instead of BOL/OUT. They should use BOL warehouse.
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const DRY_RUN = process.argv.includes('--dry-run');

async function fixFbbCwDeliveries() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fixing FBB Orders with Wrong Warehouse ===');
  console.log(DRY_RUN ? '(DRY RUN)\n' : '\n');

  // Get BOL warehouse info first
  const bolWarehouse = await odoo.searchRead('stock.warehouse',
    [['code', '=', 'BOL']],
    ['id', 'name', 'lot_stock_id', 'out_type_id']
  );

  if (bolWarehouse.length === 0) {
    console.error('BOL warehouse not found!');
    process.exit(1);
  }

  const bolWh = bolWarehouse[0];
  console.log(`BOL Warehouse: ID ${bolWh.id}`);
  console.log(`  Stock Location: ${bolWh.lot_stock_id[1]} (ID: ${bolWh.lot_stock_id[0]})`);
  console.log(`  Out Type: ${bolWh.out_type_id[1]} (ID: ${bolWh.out_type_id[0]})\n`);

  // Find FBB sale orders with CW warehouse (ID: 1)
  const fbbSaleOrders = await odoo.searchRead('sale.order',
    [
      ['client_order_ref', 'like', 'FBBA%'],
      ['warehouse_id', '=', 1]  // CW warehouse
    ],
    ['id', 'name', 'client_order_ref', 'warehouse_id', 'picking_ids', 'state'],
    500
  );

  console.log(`Found ${fbbSaleOrders.length} FBB sale orders with CW warehouse\n`);

  if (fbbSaleOrders.length === 0) {
    console.log('No FBB orders need fixing!');
    process.exit(0);
    return;
  }

  // Show what we'll fix
  console.log('Orders to fix:');
  for (const so of fbbSaleOrders.slice(0, 10)) {
    console.log(`  ${so.name} | ${so.client_order_ref} | State: ${so.state}`);
  }
  if (fbbSaleOrders.length > 10) {
    console.log(`  ... and ${fbbSaleOrders.length - 10} more\n`);
  }

  if (DRY_RUN) {
    console.log('\n(Dry run - no changes made)');
    console.log(`Would fix ${fbbSaleOrders.length} sale orders`);
    process.exit(0);
    return;
  }

  // Fix sale orders
  console.log('\n=== Fixing Sale Orders ===');
  let soFixed = 0;

  for (const so of fbbSaleOrders) {
    try {
      await odoo.write('sale.order', [so.id], {
        warehouse_id: bolWh.id
      });
      console.log(`[OK] ${so.name} -> BOL warehouse`);
      soFixed++;
    } catch (err) {
      console.log(`[ERR] ${so.name}: ${err.message}`);
    }
  }

  // Fix deliveries
  console.log('\n=== Fixing Deliveries ===');
  let pickFixed = 0;

  // Collect all picking IDs
  const allPickingIds = fbbSaleOrders.flatMap(so => so.picking_ids || []);
  console.log(`Total deliveries to check: ${allPickingIds.length}`);

  if (allPickingIds.length > 0) {
    // Get picking details
    const pickings = await odoo.searchRead('stock.picking',
      [['id', 'in', allPickingIds]],
      ['id', 'name', 'location_id', 'picking_type_id', 'state']
    );

    // Filter those with wrong location (CW)
    const wrongPickings = pickings.filter(p =>
      p.location_id && !p.location_id[1].includes('BOL')
    );

    console.log(`Deliveries with wrong location: ${wrongPickings.length}`);

    for (const picking of wrongPickings) {
      // Only fix if not done/cancelled
      if (picking.state === 'done' || picking.state === 'cancel') {
        console.log(`[SKIP] ${picking.name} - already ${picking.state}`);
        continue;
      }

      try {
        await odoo.write('stock.picking', [picking.id], {
          location_id: bolWh.lot_stock_id[0],
          picking_type_id: bolWh.out_type_id[0]
        });
        console.log(`[OK] ${picking.name} -> BOL/Stock`);
        pickFixed++;
      } catch (err) {
        console.log(`[ERR] ${picking.name}: ${err.message}`);
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Sale orders fixed: ${soFixed}`);
  console.log(`Deliveries fixed: ${pickFixed}`);

  process.exit(0);
}

fixFbbCwDeliveries().catch(e => { console.error(e); process.exit(1); });
