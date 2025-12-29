/**
 * Check FBB orders with wrong warehouse
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function check() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find FBB orders (client_order_ref starts with FBB)
  const fbbOrders = await odoo.searchRead('sale.order',
    [['client_order_ref', '=like', 'FBB%']],
    ['id', 'name', 'client_order_ref', 'warehouse_id', 'state']
  );

  console.log('Total FBB orders:', fbbOrders.length);

  // Count by warehouse
  const byWarehouse = {};
  fbbOrders.forEach(o => {
    const wh = o.warehouse_id ? o.warehouse_id[1] : 'None';
    byWarehouse[wh] = (byWarehouse[wh] || 0) + 1;
  });
  console.log('\nBy Warehouse:', byWarehouse);

  // Get order IDs
  const orderIds = fbbOrders.map(o => o.id);

  // Get pickings for these orders
  const pickings = await odoo.searchRead('stock.picking',
    [['sale_id', 'in', orderIds], ['picking_type_code', '=', 'outgoing']],
    ['id', 'sale_id', 'state', 'name']
  );

  // Map picking state by sale_id
  const pickingsBySaleId = {};
  pickings.forEach(p => {
    pickingsBySaleId[p.sale_id[0]] = p.state;
  });

  // Find FBB orders with wrong warehouse (Central Warehouse instead of BOL)
  const wrongWh = fbbOrders.filter(o => o.warehouse_id && o.warehouse_id[1] === 'Central Warehouse');
  console.log('\nFBB Orders with wrong warehouse (CW instead of BOL):', wrongWh.length);

  // Categorize by picking state
  let canFix = [];
  let cantFix = [];

  wrongWh.forEach(o => {
    const state = pickingsBySaleId[o.id];
    if (state === 'done') {
      cantFix.push(o);
    } else {
      canFix.push(o);
    }
  });

  console.log('  Picking NOT done (can fix):', canFix.length);
  console.log('  Picking DONE (cannot fix):', cantFix.length);

  // List the ones that can be fixed
  if (canFix.length > 0) {
    console.log('\nFBB orders to fix (picking not done):');
    canFix.slice(0, 10).forEach(o => {
      console.log('  ', o.name, '-', o.client_order_ref, '| Picking:', pickingsBySaleId[o.id] || 'no picking');
    });
    if (canFix.length > 10) console.log('  ... and', canFix.length - 10, 'more');
  }

  // List the ones that can't be fixed
  if (cantFix.length > 0) {
    console.log('\nFBB orders that CANNOT be fixed (picking done):');
    cantFix.forEach(o => {
      console.log('  ', o.name, '-', o.client_order_ref);
    });
  }

  return { canFix: canFix.map(o => o.id), cantFix: cantFix.map(o => o.id) };
}

check().catch(console.error);
