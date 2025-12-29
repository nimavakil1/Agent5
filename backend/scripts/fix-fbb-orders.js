/**
 * Fix FBB orders with wrong warehouse
 * Changes warehouse from CW (1) to BOL (3) for FBB orders where picking is not done
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const CENTRAL_WAREHOUSE_ID = 1;  // CW
const BOL_WAREHOUSE_ID = 3;      // BOL

async function fix() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find FBB orders with Central Warehouse
  const fbbOrders = await odoo.searchRead('sale.order',
    [
      ['client_order_ref', '=like', 'FBB%'],
      ['warehouse_id', '=', CENTRAL_WAREHOUSE_ID]
    ],
    ['id', 'name', 'client_order_ref', 'warehouse_id', 'state']
  );

  console.log('FBB orders with wrong warehouse (CW):', fbbOrders.length);

  if (fbbOrders.length === 0) {
    console.log('No FBB orders to fix!');
    return;
  }

  // Get pickings for these orders
  const orderIds = fbbOrders.map(o => o.id);
  const pickings = await odoo.searchRead('stock.picking',
    [['sale_id', 'in', orderIds], ['picking_type_code', '=', 'outgoing']],
    ['id', 'sale_id', 'state', 'name']
  );

  // Map picking state by sale_id
  const pickingsBySaleId = {};
  pickings.forEach(p => {
    pickingsBySaleId[p.sale_id[0]] = { id: p.id, state: p.state, name: p.name };
  });

  // Separate fixable and unfixable
  const canFix = [];
  const cantFix = [];

  fbbOrders.forEach(o => {
    const picking = pickingsBySaleId[o.id];
    if (picking && picking.state === 'done') {
      cantFix.push(o);
    } else {
      canFix.push({ order: o, picking });
    }
  });

  console.log('Can fix (picking not done):', canFix.length);
  console.log('Cannot fix (picking done):', cantFix.length);

  // Fix the fixable ones
  let fixed = 0;
  for (const item of canFix) {
    const order = item.order;
    const picking = item.picking;

    try {
      // Update sale order warehouse
      await odoo.write('sale.order', [order.id], {
        warehouse_id: BOL_WAREHOUSE_ID
      });

      // If there's a picking, we may need to cancel and recreate it
      // But for now, just update the order - the picking will need manual handling
      console.log('  Fixed', order.name, '-', order.client_order_ref,
        picking ? `(picking: ${picking.name} - ${picking.state})` : '(no picking)');
      fixed++;
    } catch (e) {
      console.error('  Failed to fix', order.name, ':', e.message);
    }
  }

  console.log('\nFixed', fixed, 'orders');
  console.log('\nNote: Orders with existing pickings may need manual intervention to update the picking warehouse.');

  if (cantFix.length > 0) {
    console.log('\n=== CANNOT FIX (picking already done) ===');
    cantFix.forEach(o => {
      console.log(' ', o.name, '-', o.client_order_ref);
    });
  }
}

fix().catch(console.error);
