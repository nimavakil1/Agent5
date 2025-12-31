#!/usr/bin/env node
/**
 * Fix BOL deliveries NOW - both location AND partner address
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function fixBolDeliveries() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fixing ALL BOL Deliveries ===\n');

  // Get BOL warehouse info
  const bolWarehouse = await odoo.searchRead('stock.warehouse',
    [['code', '=', 'BOL']],
    ['id', 'name', 'lot_stock_id']
  );
  const bolStockLocationId = bolWarehouse[0].lot_stock_id[0];
  console.log(`BOL Stock Location ID: ${bolStockLocationId}\n`);

  // Find ALL CW/OUT deliveries that are active (Ready, Waiting, Confirmed)
  const cwDeliveries = await odoo.searchRead('stock.picking',
    [
      ['name', 'like', 'CW/OUT/%'],
      ['state', 'in', ['assigned', 'confirmed', 'waiting']]
    ],
    ['id', 'name', 'origin', 'location_id', 'partner_id', 'state'],
    500
  );

  console.log(`Found ${cwDeliveries.length} active CW/OUT deliveries\n`);

  let fixedLocation = 0;
  let fixedPartner = 0;
  let errors = 0;

  for (const picking of cwDeliveries) {
    if (!picking.origin) continue;

    // Get the sale order
    const saleOrders = await odoo.searchRead('sale.order',
      [['name', '=', picking.origin]],
      ['id', 'name', 'warehouse_id', 'partner_shipping_id', 'client_order_ref']
    );

    if (saleOrders.length === 0) continue;

    const so = saleOrders[0];
    const isBolOrder = so.warehouse_id && so.warehouse_id[0] === 3; // BOL warehouse
    const isFBB = so.client_order_ref && (so.client_order_ref.startsWith('FBB') || so.client_order_ref.startsWith('FBBA'));

    // Check if this is a BOL/FBB order
    if (!isBolOrder && !isFBB) continue;

    const updates = {};
    const changes = [];

    // Fix location if wrong
    if (picking.location_id && picking.location_id[0] !== bolStockLocationId) {
      updates.location_id = bolStockLocationId;
      changes.push(`location: ${picking.location_id[1]} -> BOL/Stock`);
      fixedLocation++;
    }

    // Fix partner if different from order's shipping partner
    const soPartnerId = so.partner_shipping_id ? so.partner_shipping_id[0] : null;
    const pickingPartnerId = picking.partner_id ? picking.partner_id[0] : null;

    if (soPartnerId && soPartnerId !== pickingPartnerId) {
      updates.partner_id = soPartnerId;
      changes.push(`partner: "${picking.partner_id?.[1] || 'None'}" -> "${so.partner_shipping_id[1]}"`);
      fixedPartner++;
    }

    // Apply updates
    if (Object.keys(updates).length > 0) {
      try {
        await odoo.write('stock.picking', [picking.id], updates);
        console.log(`[OK] ${picking.name} | ${so.client_order_ref || so.name}`);
        changes.forEach(c => console.log(`     ${c}`));
      } catch (err) {
        console.log(`[ERR] ${picking.name}: ${err.message}`);
        errors++;
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Location fixes: ${fixedLocation}`);
  console.log(`Partner fixes: ${fixedPartner}`);
  console.log(`Errors: ${errors}`);

  process.exit(0);
}

fixBolDeliveries().catch(e => { console.error(e); process.exit(1); });
