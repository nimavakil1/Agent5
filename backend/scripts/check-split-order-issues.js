/**
 * Check for split orders that may have been affected by the isSplitOrder bug
 * (wrong picking used - FBB instead of FBR)
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find all split orders that have been shipped
  const splitOrders = await db.collection('unified_orders').find({
    'odoo.isSplitOrder': true,
    'bol.shipmentConfirmedAt': { $ne: null }
  }).toArray();

  console.log('=== SPLIT ORDERS WITH SHIPMENT CONFIRMED ===');
  console.log('Total:', splitOrders.length);

  // Check each one against Odoo to see if wrong picking was used
  const affected = [];

  for (const order of splitOrders) {
    const bolOrderId = order.sourceIds?.bolOrderId;
    const shipmentRef = order.bol?.shipmentReference;
    const trackingCode = order.bol?.trackingCode;
    const fbrOrderId = order.sourceIds?.odooFbrSaleOrderId;
    const fbbOrderId = order.sourceIds?.odooFbbSaleOrderId;

    if (!fbrOrderId) continue;

    // Get the FBR picking from Odoo
    const fbrPickings = await odoo.searchRead('stock.picking',
      [
        ['sale_id', '=', fbrOrderId],
        ['picking_type_code', '=', 'outgoing'],
        ['state', '=', 'done']
      ],
      ['id', 'name', 'carrier_tracking_ref', 'carrier_id']
    );

    if (fbrPickings.length === 0) continue;

    const fbrPicking = fbrPickings[0];
    const correctRef = fbrPicking.name;
    const correctTracking = fbrPicking.carrier_tracking_ref || '';

    // Check if the stored shipment ref matches the FBR picking
    if (shipmentRef !== correctRef) {
      affected.push({
        bolOrderId,
        storedRef: shipmentRef,
        storedTracking: trackingCode || '(empty)',
        correctRef,
        correctTracking: correctTracking || '(none)',
        fbrOrderId,
        fbbOrderId,
        confirmedAt: order.bol?.shipmentConfirmedAt
      });
    }
  }

  console.log('\n=== AFFECTED ORDERS (wrong picking sent to BOL) ===');
  console.log('Count:', affected.length);

  for (const a of affected) {
    console.log('\n  Order:', a.bolOrderId);
    console.log('    WRONG - Sent ref:', a.storedRef, '| tracking:', a.storedTracking);
    console.log('    CORRECT - Should be:', a.correctRef, '| tracking:', a.correctTracking);
    console.log('    FBR Odoo ID:', a.fbrOrderId);
    console.log('    Confirmed at:', a.confirmedAt);
  }

  // Output as JSON for easy processing
  if (affected.length > 0) {
    console.log('\n=== JSON OUTPUT FOR FIXING ===');
    console.log(JSON.stringify(affected, null, 2));
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
