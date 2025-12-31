#!/usr/bin/env node
/**
 * Check pending tracking orders - why aren't they being pushed?
 */

require('dotenv').config();
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function check() {
  await connectDb();
  const db = getDb();

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const pending = await db.collection('seller_orders').find({
    fulfillmentChannel: 'MFN',
    'odoo.saleOrderId': { $ne: null },
    'odoo.trackingPushed': { $ne: true }
  }).limit(30).toArray();

  console.log('Checking', pending.length, 'pending orders in Odoo...\n');

  let notShipped = 0;
  let noTracking = 0;
  let hasTracking = 0;

  for (const o of pending) {
    const saleOrderId = o.odoo?.saleOrderId;
    if (!saleOrderId) continue;

    const pickings = await odoo.searchRead('stock.picking',
      [['sale_id', '=', saleOrderId], ['picking_type_code', '=', 'outgoing']],
      ['id', 'name', 'state', 'carrier_tracking_ref']
    );

    const done = pickings.filter(p => p.state === 'done');
    const withTracking = done.filter(p => p.carrier_tracking_ref);

    console.log(o.amazonOrderId, '| Sale:', o.odoo.saleOrderName);

    if (done.length === 0) {
      console.log('  -> Not shipped in Odoo (no done pickings)');
      notShipped++;
    } else if (withTracking.length === 0) {
      console.log('  -> Shipped but NO TRACKING');
      noTracking++;
    } else {
      console.log('  -> Has tracking:', withTracking[0].carrier_tracking_ref);
      hasTracking++;
    }
  }

  console.log('\n=== Summary ===');
  console.log('Not shipped in Odoo:', notShipped);
  console.log('Shipped but no tracking:', noTracking);
  console.log('Has tracking (should push):', hasTracking);

  process.exit(0);
}

check().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
