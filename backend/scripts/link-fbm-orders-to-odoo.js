/**
 * Link FBM orders in MongoDB to their Odoo counterparts
 *
 * These orders exist in Odoo but aren't linked in MongoDB
 */

const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { connectDb, getDb } = require('../src/db');

const AMAZON_ORDER_IDS = [
  '028-9409863-6746721',
  '406-8731753-8072305',
  '303-8302868-8797150',
  '408-8928685-7938709',
  '408-9832182-3890733'
];

async function linkFbmOrders() {
  await connectDb();
  const db = getDb();
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Linking FBM Orders to Odoo ===\n');

  let linked = 0;
  let notFound = 0;
  let alreadyLinked = 0;

  for (const amazonOrderId of AMAZON_ORDER_IDS) {
    console.log(`\nProcessing: ${amazonOrderId}`);

    // Check MongoDB first
    const mongoOrder = await db.collection('unified_orders').findOne({
      'sourceIds.amazonOrderId': amazonOrderId
    });

    if (!mongoOrder) {
      console.log('  NOT FOUND in MongoDB');
      notFound++;
      continue;
    }

    if (mongoOrder.odoo?.saleOrderId) {
      console.log(`  Already linked to Odoo: ${mongoOrder.odoo.saleOrderName}`);
      alreadyLinked++;
      continue;
    }

    // Search Odoo by client_order_ref (try both with and without prefix)
    let odooOrders = await odoo.searchRead('sale.order',
      ['|',
        ['client_order_ref', '=', amazonOrderId],
        ['client_order_ref', '=', 'FBM' + amazonOrderId]
      ],
      ['id', 'name', 'client_order_ref', 'partner_id', 'state', 'warehouse_id'],
      { limit: 5 }
    );

    // Also try searching by name with FBM prefix
    if (odooOrders.length === 0) {
      odooOrders = await odoo.searchRead('sale.order',
        ['|',
          ['name', 'like', amazonOrderId],
          ['name', 'like', 'FBM' + amazonOrderId.substring(0, 15)]
        ],
        ['id', 'name', 'client_order_ref', 'partner_id', 'state', 'warehouse_id'],
        { limit: 5 }
      );
    }

    if (odooOrders.length === 0) {
      console.log('  NOT FOUND in Odoo');
      notFound++;
      continue;
    }

    const odooOrder = odooOrders[0];
    console.log(`  Found in Odoo: ${odooOrder.name} (ID: ${odooOrder.id})`);
    console.log(`  Partner: ${odooOrder.partner_id ? odooOrder.partner_id[1] : 'None'}`);

    // Update MongoDB - both sourceIds (for queries) and odoo (for embedded data)
    const updateResult = await db.collection('unified_orders').updateOne(
      { 'sourceIds.amazonOrderId': amazonOrderId },
      {
        $set: {
          // sourceIds - for quick lookups
          'sourceIds.odooSaleOrderId': odooOrder.id,
          'sourceIds.odooSaleOrderName': odooOrder.name,
          // odoo - embedded data
          'odoo.saleOrderId': odooOrder.id,
          'odoo.saleOrderName': odooOrder.name,
          'odoo.partnerId': odooOrder.partner_id ? odooOrder.partner_id[0] : null,
          'odoo.partnerName': odooOrder.partner_id ? odooOrder.partner_id[1] : null,
          'odoo.state': odooOrder.state,
          'odoo.warehouseId': odooOrder.warehouse_id ? odooOrder.warehouse_id[0] : null,
          'odoo.linkedAt': new Date(),
          // customer - for display
          'customer.name': odooOrder.partner_id ? odooOrder.partner_id[1] : mongoOrder.customer?.name,
          'customer.odooPartnerId': odooOrder.partner_id ? odooOrder.partner_id[0] : null,
          'customer.odooPartnerName': odooOrder.partner_id ? odooOrder.partner_id[1] : null
        }
      }
    );

    if (updateResult.modifiedCount > 0) {
      console.log('  ✓ LINKED successfully');
      linked++;
    } else {
      console.log('  ! Update failed');
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Linked: ${linked}`);
  console.log(`Already linked: ${alreadyLinked}`);
  console.log(`Not found: ${notFound}`);

  process.exit(0);
}

linkFbmOrders().catch(e => { console.error(e); process.exit(1); });
