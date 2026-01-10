/**
 * Verify BOL sync is working correctly
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== BOL Sync Verification ===\n');

  // 1. unified_orders with lowercase 'bol'
  const bolTotal = await db.collection('unified_orders').countDocuments({ channel: 'bol' });
  const bolWithOdoo = await db.collection('unified_orders').countDocuments({
    channel: 'bol',
    'sourceIds.odooSaleOrderId': { $exists: true, $ne: null }
  });

  console.log('unified_orders (channel=bol):');
  console.log('  Total:', bolTotal);
  console.log('  With Odoo link:', bolWithOdoo);
  console.log('  WITHOUT Odoo link:', bolTotal - bolWithOdoo);

  // 2. Recent orders (last 7 days)
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const bolRecent = await db.collection('unified_orders').countDocuments({
    channel: 'bol',
    orderDate: { $gte: weekAgo }
  });

  const bolRecentWithOdoo = await db.collection('unified_orders').countDocuments({
    channel: 'bol',
    orderDate: { $gte: weekAgo },
    'sourceIds.odooSaleOrderId': { $exists: true, $ne: null }
  });

  const odooRecent = await odoo.execute('sale.order', 'search_count', [[
    ['team_id', 'in', [9, 10]],
    ['date_order', '>=', weekAgo.toISOString().split('T')[0]]
  ]]);

  console.log('\nLast 7 days:');
  console.log('  MongoDB unified_orders (bol):', bolRecent);
  console.log('    With Odoo link:', bolRecentWithOdoo);
  console.log('    Without Odoo link:', bolRecent - bolRecentWithOdoo);
  console.log('  Odoo BOL orders:', odooRecent);

  // 3. Today's orders
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const bolToday = await db.collection('unified_orders').countDocuments({
    channel: 'bol',
    orderDate: { $gte: today }
  });

  const bolTodayWithOdoo = await db.collection('unified_orders').countDocuments({
    channel: 'bol',
    orderDate: { $gte: today },
    'sourceIds.odooSaleOrderId': { $exists: true, $ne: null }
  });

  const odooToday = await odoo.execute('sale.order', 'search_count', [[
    ['team_id', 'in', [9, 10]],
    ['date_order', '>=', today.toISOString().split('T')[0]]
  ]]);

  console.log('\nToday:');
  console.log('  MongoDB unified_orders (bol):', bolToday);
  console.log('    With Odoo link:', bolTodayWithOdoo);
  console.log('    Without Odoo link:', bolToday - bolTodayWithOdoo);
  console.log('  Odoo BOL orders:', odooToday);

  // 4. Sample missing Odoo links
  if (bolRecent - bolRecentWithOdoo > 0) {
    console.log('\n--- Sample orders missing Odoo link (recent) ---');
    const missingOdoo = await db.collection('unified_orders').find({
      channel: 'bol',
      orderDate: { $gte: weekAgo },
      $or: [
        { 'sourceIds.odooSaleOrderId': { $exists: false } },
        { 'sourceIds.odooSaleOrderId': null }
      ]
    }).sort({ orderDate: -1 }).limit(5).toArray();

    for (const order of missingOdoo) {
      console.log(`\n  Order: ${order.orderId}`);
      console.log(`    Date: ${order.orderDate}`);
      console.log(`    Status: ${order.status}`);
      console.log(`    Fulfillment: ${order.fulfillmentMethod}`);
    }
  }

  // 5. Check Odoo total
  const odooTotal = await odoo.execute('sale.order', 'search_count', [[
    ['team_id', 'in', [9, 10]]
  ]]);

  console.log('\n=== Summary ===');
  console.log('MongoDB unified_orders (bol):', bolTotal);
  console.log('Odoo BOL orders (team 9,10):', odooTotal);
  console.log('Difference:', odooTotal - bolTotal);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
