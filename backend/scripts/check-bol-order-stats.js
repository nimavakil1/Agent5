/**
 * Check Bol order statistics
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  // Count Bol orders in unified_orders
  const unified = await db.collection('unified_orders').countDocuments({ channel: 'BOL' });
  const withOdoo = await db.collection('unified_orders').countDocuments({
    channel: 'BOL',
    'sourceIds.odooSaleOrderId': { $exists: true, $ne: null }
  });

  // Recent orders (last 7 days)
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const recentTotal = await db.collection('unified_orders').countDocuments({
    channel: 'BOL',
    orderDate: { $gte: weekAgo }
  });
  const recentWithOdoo = await db.collection('unified_orders').countDocuments({
    channel: 'BOL',
    orderDate: { $gte: weekAgo },
    'sourceIds.odooSaleOrderId': { $exists: true, $ne: null }
  });

  // Count in Odoo (via sales team)
  const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const odooTotal = await odoo.execute('sale.order', 'search_count', [[['team_id', 'in', [9, 10]]]]);
  const odooRecent = await odoo.execute('sale.order', 'search_count', [[
    ['team_id', 'in', [9, 10]],
    ['date_order', '>=', weekAgo.toISOString().split('T')[0]]
  ]]);

  console.log('=== Bol Order Stats ===');
  console.log('');
  console.log('MongoDB unified_orders:');
  console.log('  Total BOL orders:', unified);
  console.log('  With Odoo link:', withOdoo);
  console.log('  WITHOUT Odoo link:', unified - withOdoo);
  console.log('');
  console.log('Odoo (team_id 9,10):');
  console.log('  Total BOL orders:', odooTotal);
  console.log('');
  console.log('=== Last 7 Days ===');
  console.log('MongoDB recent:', recentTotal);
  console.log('  With Odoo:', recentWithOdoo);
  console.log('  Without Odoo:', recentTotal - recentWithOdoo);
  console.log('Odoo recent:', odooRecent);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
