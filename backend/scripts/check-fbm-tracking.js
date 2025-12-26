require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkFbmTracking() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Checking FBM Orders with Tracking in Odoo ===\n');

  // Find sale orders with FBM prefix
  const fbmOrders = await odoo.searchRead('sale.order',
    [['name', 'like', 'FBM%']],
    ['id', 'name', 'state', 'client_order_ref', 'date_order'],
    { limit: 20, order: 'date_order desc' }
  );

  console.log('Found ' + fbmOrders.length + ' FBM orders in Odoo\n');

  for (const order of fbmOrders) {
    // Find pickings for this order
    const pickings = await odoo.searchRead('stock.picking',
      [
        ['sale_id', '=', order.id],
        ['picking_type_code', '=', 'outgoing']
      ],
      ['id', 'name', 'state', 'carrier_tracking_ref', 'carrier_id', 'date_done']
    );

    console.log('Order: ' + order.name + ' (' + order.state + ')');
    console.log('  Amazon Ref: ' + (order.client_order_ref || 'N/A'));
    console.log('  Date: ' + order.date_order);

    if (pickings.length === 0) {
      console.log('  Pickings: None found');
    } else {
      for (const p of pickings) {
        const carrier = p.carrier_id ? p.carrier_id[1] : 'No carrier';
        const tracking = p.carrier_tracking_ref || '** NO TRACKING **';
        console.log('  Picking: ' + p.name + ' (' + p.state + ')');
        console.log('    Carrier: ' + carrier);
        console.log('    Tracking: ' + tracking);
        console.log('    Date Done: ' + (p.date_done || 'Not done'));
      }
    }
    console.log('');
  }

  // Summary: count pickings with/without tracking
  const allFbmPickings = await odoo.searchRead('stock.picking',
    [
      ['origin', 'like', 'FBM%'],
      ['picking_type_code', '=', 'outgoing'],
      ['state', '=', 'done']
    ],
    ['id', 'name', 'carrier_tracking_ref']
  );

  const withTracking = allFbmPickings.filter(p => p.carrier_tracking_ref);
  const withoutTracking = allFbmPickings.filter(p => !p.carrier_tracking_ref);

  console.log('=== Summary ===');
  console.log('Total validated FBM pickings: ' + allFbmPickings.length);
  console.log('With tracking number: ' + withTracking.length);
  console.log('WITHOUT tracking number: ' + withoutTracking.length);

  if (withoutTracking.length > 0) {
    console.log('\nPickings missing tracking:');
    withoutTracking.slice(0, 10).forEach(p => console.log('  - ' + p.name));
  }
}

checkFbmTracking().catch(console.error);
