#!/usr/bin/env node
/**
 * Fix CW deliveries that belong to FBB (Bol) orders
 *
 * These deliveries were created with CW warehouse but should be BOL
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const DRY_RUN = process.argv.includes('--dry-run');

async function fixCwFbbDeliveries() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fixing CW Deliveries for FBB Orders ===');
  console.log(DRY_RUN ? '(DRY RUN)\n' : '\n');

  // Get BOL warehouse info
  const bolWarehouse = await odoo.searchRead('stock.warehouse',
    [['code', '=', 'BOL']],
    ['id', 'name', 'lot_stock_id', 'out_type_id']
  );

  const bolWh = bolWarehouse[0];
  console.log(`BOL Warehouse: ID ${bolWh.id}`);
  console.log(`  Stock Location: ${bolWh.lot_stock_id[1]} (ID: ${bolWh.lot_stock_id[0]})`);
  console.log(`  Out Type: ${bolWh.out_type_id[1]} (ID: ${bolWh.out_type_id[0]})\n`);

  // Find all CW deliveries that are Ready/Confirmed (not done/cancelled)
  const cwPickings = await odoo.searchRead('stock.picking',
    [
      ['name', 'like', 'CW/OUT/%'],
      ['state', 'in', ['assigned', 'confirmed', 'waiting']]
    ],
    ['id', 'name', 'origin', 'location_id', 'picking_type_id', 'state'],
    500
  );

  console.log(`Found ${cwPickings.length} active CW/OUT deliveries`);

  // For each, check if the sale order has BOL warehouse
  const toFix = [];

  for (const picking of cwPickings) {
    if (!picking.origin) continue;

    // Get sale order
    const saleOrders = await odoo.searchRead('sale.order',
      [['name', '=', picking.origin]],
      ['id', 'name', 'warehouse_id', 'client_order_ref']
    );

    if (saleOrders.length === 0) continue;

    const so = saleOrders[0];

    // Check if sale order has BOL warehouse but delivery has CW
    if (so.warehouse_id && so.warehouse_id[0] === bolWh.id) {
      toFix.push({
        picking,
        saleOrder: so
      });
    }
  }

  console.log(`\nDeliveries to fix (CW delivery but BOL sale order): ${toFix.length}\n`);

  if (toFix.length === 0) {
    console.log('No deliveries need fixing!');
    process.exit(0);
    return;
  }

  // Show what we'll fix
  console.log('Deliveries to fix:');
  for (const { picking, saleOrder } of toFix.slice(0, 20)) {
    console.log(`  ${picking.name} | ${saleOrder.name} (${saleOrder.client_order_ref}) | State: ${picking.state}`);
  }
  if (toFix.length > 20) {
    console.log(`  ... and ${toFix.length - 20} more`);
  }

  if (DRY_RUN) {
    console.log('\n(Dry run - no changes made)');
    process.exit(0);
    return;
  }

  // Fix deliveries - only change location_id (picking_type_id cannot be changed)
  console.log('\n=== Fixing Deliveries (location only) ===');
  let fixed = 0;

  for (const { picking } of toFix) {
    try {
      // Only change location_id - Odoo doesn't allow changing picking_type_id
      await odoo.write('stock.picking', [picking.id], {
        location_id: bolWh.lot_stock_id[0]
      });
      console.log(`[OK] ${picking.name} -> BOL/Stock`);
      fixed++;
    } catch (err) {
      console.log(`[ERR] ${picking.name}: ${err.message}`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Fixed ${fixed} deliveries (location changed to BOL/Stock)`);
  console.log(`Note: picking_type_id cannot be changed on existing deliveries.`);
  console.log(`The delivery names will still say CW/OUT/* but source location is BOL/Stock.`);

  process.exit(0);
}

fixCwFbbDeliveries().catch(e => { console.error(e); process.exit(1); });
