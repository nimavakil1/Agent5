/**
 * Diagnose GLS Label Phone Number Issue
 *
 * Checks the phone data flow:
 * 1. Amazon order data → unified_orders
 * 2. Odoo partner (res.partner)
 * 3. Odoo stock.picking partner_id
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { connectDb, getDb } = require('../db');
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

async function main() {
  await connectDb();
  const db = getDb();
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find recent Amazon Seller orders with shippingAddress
  console.log('=== Finding recent Amazon Seller orders ===\n');

  const recentOrders = await db.collection('unified_orders').find({
    source: 'amazon',
    'sourceIds.amazonOrderId': { $exists: true },
    shippingAddress: { $exists: true }
  }).sort({ createdAt: -1 }).limit(5).toArray();

  if (recentOrders.length === 0) {
    console.log('No Amazon Seller orders found');
    process.exit(0);
  }

  for (const order of recentOrders) {
    const amazonOrderId = order.sourceIds?.amazonOrderId;
    const odooOrderId = order.odooIds?.saleOrderId;

    console.log('-------------------------------------------');
    console.log(`Order: ${amazonOrderId}`);
    console.log(`Unified ID: ${order.unifiedOrderId}`);
    console.log(`Created: ${order.createdAt}`);

    // Check phone in unified_orders
    const phone = order.shippingAddress?.phone;
    console.log(`\n[unified_orders] shippingAddress.phone: "${phone || '(empty)'}"`);

    if (!odooOrderId) {
      console.log('[Odoo] No sale order linked\n');
      continue;
    }

    // Find Odoo sale order
    const saleOrders = await odoo.searchRead('sale.order',
      [['id', '=', odooOrderId]],
      ['name', 'partner_id', 'partner_shipping_id']
    );

    if (saleOrders.length === 0) {
      console.log(`[Odoo] Sale order ${odooOrderId} not found\n`);
      continue;
    }

    const saleOrder = saleOrders[0];
    console.log(`\n[Odoo sale.order] ${saleOrder.name}`);
    console.log(`  partner_id: ${saleOrder.partner_id[0]} (${saleOrder.partner_id[1]})`);
    console.log(`  partner_shipping_id: ${saleOrder.partner_shipping_id[0]} (${saleOrder.partner_shipping_id[1]})`);

    // Check partner phone fields
    const partnerIds = [saleOrder.partner_id[0]];
    if (saleOrder.partner_shipping_id[0] !== saleOrder.partner_id[0]) {
      partnerIds.push(saleOrder.partner_shipping_id[0]);
    }

    const partners = await odoo.searchRead('res.partner',
      [['id', 'in', partnerIds]],
      ['id', 'name', 'phone', 'mobile', 'parent_id']
    );

    for (const partner of partners) {
      const isShipping = partner.id === saleOrder.partner_shipping_id[0];
      const label = isShipping ? 'SHIPPING' : 'INVOICE';
      console.log(`\n[Odoo res.partner ${label}] ID ${partner.id}: ${partner.name}`);
      console.log(`  phone: "${partner.phone || '(empty)'}"`);
      console.log(`  mobile: "${partner.mobile || '(empty)'}"`);
      if (partner.parent_id) {
        console.log(`  parent_id: ${partner.parent_id[0]} (${partner.parent_id[1]})`);
      }
    }

    // Check stock.picking for this order
    const pickings = await odoo.searchRead('stock.picking',
      [['sale_id', '=', odooOrderId]],
      ['name', 'partner_id', 'state', 'carrier_tracking_ref']
    );

    if (pickings.length > 0) {
      for (const picking of pickings) {
        console.log(`\n[Odoo stock.picking] ${picking.name} (${picking.state})`);
        console.log(`  partner_id: ${picking.partner_id[0]} (${picking.partner_id[1]})`);
        console.log(`  tracking: ${picking.carrier_tracking_ref || '(none)'}`);

        // Check the partner on the picking
        if (picking.partner_id[0]) {
          const pickingPartner = await odoo.searchRead('res.partner',
            [['id', '=', picking.partner_id[0]]],
            ['id', 'name', 'phone', 'mobile']
          );
          if (pickingPartner.length > 0) {
            console.log(`  [picking partner phone] "${pickingPartner[0].phone || '(empty)'}"`);
            console.log(`  [picking partner mobile] "${pickingPartner[0].mobile || '(empty)'}"`);
          }
        }
      }
    } else {
      console.log('\n[Odoo stock.picking] No pickings found');
    }

    console.log('');
  }

  console.log('=== Diagnosis Complete ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
