#!/usr/bin/env node
/**
 * Fix FBB deliveries that are in CW/OUT instead of BOL/OUT
 * 1. Cancel the CW/OUT delivery
 * 2. Ensure sale order has BOL warehouse
 * 3. Re-confirm order to create BOL/OUT delivery
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function fixFbbDeliveries() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get BOL/Stock location ID
  const bolLocs = await odoo.searchRead('stock.location',
    [['complete_name', 'like', 'BOL/Stock']],
    ['id']
  );
  const bolStockId = bolLocs[0].id;
  console.log('BOL/Stock location ID:', bolStockId);

  // Find all CW/OUT deliveries with BOL/Stock location
  const pickings = await odoo.searchRead('stock.picking',
    [
      ['name', 'like', 'CW/OUT/%'],
      ['state', 'in', ['assigned', 'confirmed', 'waiting']],
      ['location_id', '=', bolStockId]
    ],
    ['id', 'name', 'origin', 'state'],
    500
  );

  console.log(`Found ${pickings.length} CW/OUT deliveries with BOL/Stock to fix\n`);

  let fixed = 0;
  let errors = 0;

  for (const picking of pickings) {
    console.log(`${picking.name} | Origin: ${picking.origin}`);

    // Step 1: Cancel the delivery
    try {
      await odoo.execute('stock.picking', 'action_cancel', [[picking.id]]);
    } catch (err) {
      console.log(`  [ERR] Cancel: ${err.message}`);
      errors++;
      continue;
    }

    // Step 2: Get sale order and ensure warehouse is BOL
    const saleOrders = await odoo.searchRead('sale.order',
      [['name', '=', picking.origin]],
      ['id', 'warehouse_id']
    );

    if (saleOrders.length === 0) {
      console.log('  [SKIP] No sale order found');
      continue;
    }

    const so = saleOrders[0];

    // Ensure warehouse is BOL (ID 3)
    if (!so.warehouse_id || so.warehouse_id[0] !== 3) {
      await odoo.write('sale.order', [so.id], { warehouse_id: 3 });
    }

    // Step 3: Reconfirm to create new delivery
    try {
      await odoo.execute('sale.order', 'action_confirm', [[so.id]]);
      console.log('  [OK] New BOL/OUT delivery created');
      fixed++;
    } catch (err) {
      console.log(`  [ERR] Confirm: ${err.message}`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Fixed: ${fixed}`);
  console.log(`Errors: ${errors}`);

  process.exit(0);
}

fixFbbDeliveries().catch(e => { console.error(e); process.exit(1); });
