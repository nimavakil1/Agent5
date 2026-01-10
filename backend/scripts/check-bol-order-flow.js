/**
 * Check BOL order flow - from Bol.com to Odoo
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== BOL Order Flow Analysis ===\n');

  // 1. MongoDB bol_orders collection stats
  const bolOrdersTotal = await db.collection('bol_orders').countDocuments();
  const bolOrdersWithOdoo = await db.collection('bol_orders').countDocuments({
    odooSaleOrderId: { $exists: true, $ne: null }
  });

  console.log('MongoDB bol_orders collection:');
  console.log('  Total:', bolOrdersTotal);
  console.log('  With Odoo link:', bolOrdersWithOdoo);
  console.log('  WITHOUT Odoo link:', bolOrdersTotal - bolOrdersWithOdoo);

  // 2. MongoDB unified_orders collection stats
  const unifiedTotal = await db.collection('unified_orders').countDocuments();
  const unifiedBol = await db.collection('unified_orders').countDocuments({ channel: 'BOL' });

  console.log('\nMongoDB unified_orders collection:');
  console.log('  Total:', unifiedTotal);
  console.log('  BOL orders:', unifiedBol);

  // 3. Recent orders comparison
  console.log('\n--- Recent Orders (Last 7 Days) ---');

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const bolRecent = await db.collection('bol_orders').countDocuments({
    orderPlacedDateTime: { $gte: weekAgo.toISOString() }
  });

  const bolRecentWithOdoo = await db.collection('bol_orders').countDocuments({
    orderPlacedDateTime: { $gte: weekAgo.toISOString() },
    odooSaleOrderId: { $exists: true, $ne: null }
  });

  const odooRecent = await odoo.execute('sale.order', 'search_count', [[
    ['team_id', 'in', [9, 10]],
    ['date_order', '>=', weekAgo.toISOString().split('T')[0]]
  ]]);

  console.log('MongoDB bol_orders (last 7 days):', bolRecent);
  console.log('  With Odoo link:', bolRecentWithOdoo);
  console.log('  Without Odoo link:', bolRecent - bolRecentWithOdoo);
  console.log('Odoo BOL orders (last 7 days):', odooRecent);

  // 4. Check for orders missing Odoo link
  if (bolRecent - bolRecentWithOdoo > 0) {
    console.log('\n--- Sample Orders Missing Odoo Link ---');

    const missingOdoo = await db.collection('bol_orders').find({
      orderPlacedDateTime: { $gte: weekAgo.toISOString() },
      $or: [
        { odooSaleOrderId: { $exists: false } },
        { odooSaleOrderId: null }
      ]
    }).limit(10).toArray();

    for (const order of missingOdoo) {
      console.log(`\n  Order: ${order.orderId}`);
      console.log(`    Date: ${order.orderPlacedDateTime}`);
      console.log(`    Status: ${order.status}`);
      console.log(`    Fulfillment: ${order.orderItems?.[0]?.fulfilment?.method || 'unknown'}`);
      console.log(`    Total items: ${order.orderItems?.length || 0}`);

      // Try to find in Odoo by client_order_ref
      const odooOrders = await odoo.execute('sale.order', 'search_read', [[
        ['client_order_ref', '=', order.orderId]
      ]], { fields: ['id', 'name', 'state', 'invoice_status'], limit: 1 });

      if (odooOrders.length > 0) {
        console.log(`    FOUND in Odoo: ${odooOrders[0].name} (id=${odooOrders[0].id})`);
        console.log(`    → Should update bol_orders.odooSaleOrderId!`);
      } else {
        console.log(`    NOT in Odoo`);
      }
    }
  }

  // 5. Orders by status
  console.log('\n--- BOL Orders by Status (all time) ---');

  const statusCounts = await db.collection('bol_orders').aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();

  for (const s of statusCounts) {
    console.log(`  ${s._id || 'null'}: ${s.count}`);
  }

  // 6. Check today's orders
  console.log('\n--- Today\'s Orders ---');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const bolToday = await db.collection('bol_orders').countDocuments({
    orderPlacedDateTime: { $gte: today.toISOString() }
  });

  const odooToday = await odoo.execute('sale.order', 'search_count', [[
    ['team_id', 'in', [9, 10]],
    ['date_order', '>=', today.toISOString().split('T')[0]]
  ]]);

  console.log('MongoDB bol_orders (today):', bolToday);
  console.log('Odoo BOL orders (today):', odooToday);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
