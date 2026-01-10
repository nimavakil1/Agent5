/**
 * Fix FBM orders that exist in Odoo but are missing the link in unified_orders
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fix FBM Odoo Links ===\n');

  // Find FBM orders missing Odoo link
  const missingOrders = await db.collection('unified_orders').find({
    channel: 'amazon-seller',
    subChannel: 'FBM',
    'sourceIds.odooSaleOrderId': null
  }).toArray();

  console.log(`Found ${missingOrders.length} FBM orders without Odoo link\n`);

  let fixed = 0;
  let notInOdoo = 0;
  let errors = 0;

  for (const order of missingOrders) {
    const amazonOrderId = order.sourceIds?.amazonOrderId;
    if (!amazonOrderId) continue;

    try {
      // Search for this order in Odoo by client_order_ref
      const odooOrders = await odoo.execute('sale.order', 'search_read', [[
        ['client_order_ref', '=', amazonOrderId]
      ]], { fields: ['id', 'name', 'state', 'partner_id'], limit: 1 });

      if (odooOrders.length > 0) {
        const odooOrder = odooOrders[0];

        // Update unified_orders with Odoo link
        await db.collection('unified_orders').updateOne(
          { unifiedOrderId: order.unifiedOrderId },
          {
            $set: {
              'sourceIds.odooSaleOrderId': odooOrder.id,
              'sourceIds.odooSaleOrderName': odooOrder.name,
              'odoo.saleOrderId': odooOrder.id,
              'odoo.saleOrderName': odooOrder.name,
              'odoo.partnerId': odooOrder.partner_id[0],
              'odoo.syncedAt': new Date(),
              'status.odoo': odooOrder.state,
              updatedAt: new Date()
            }
          }
        );

        console.log(`✓ Linked ${amazonOrderId} → ${odooOrder.name}`);
        fixed++;
      } else {
        console.log(`✗ ${amazonOrderId} - Not found in Odoo`);
        notInOdoo++;
      }
    } catch (error) {
      console.error(`! Error processing ${amazonOrderId}: ${error.message}`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Fixed: ${fixed}`);
  console.log(`Not in Odoo: ${notInOdoo}`);
  console.log(`Errors: ${errors}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
