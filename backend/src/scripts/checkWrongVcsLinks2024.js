#!/usr/bin/env node
/**
 * Check for VCS orders that were incorrectly linked to non-Amazon orders
 * Specifically checking 2024 data
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

async function checkWrongLinks() {
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await client.connect();
  const db = client.db();

  // Check date range of all VCS orders
  const dateStats = await db.collection('amazon_vcs_orders').aggregate([
    {
      $group: {
        _id: null,
        minDate: { $min: '$orderDate' },
        maxDate: { $max: '$orderDate' },
        total: { $sum: 1 }
      }
    }
  ]).toArray();

  console.log('VCS Orders date range:');
  if (dateStats.length > 0) {
    console.log('  Earliest:', dateStats[0].minDate);
    console.log('  Latest:', dateStats[0].maxDate);
    console.log('  Total orders:', dateStats[0].total);
  }

  // Find all invoiced VCS orders with date info
  const invoicedOrders = await db.collection('amazon_vcs_orders')
    .find({
      status: 'invoiced',
      odooSaleOrderName: { $exists: true }
    })
    .toArray();

  console.log('\nTotal invoiced VCS orders:', invoicedOrders.length);

  // Check which ones are linked to non-Amazon orders
  const wrongLinks = invoicedOrders.filter(o => {
    const name = o.odooSaleOrderName || '';
    // Amazon orders start with FBA or FBM
    return !name.startsWith('FBA') && !name.startsWith('FBM');
  });

  console.log('Wrongly linked to non-Amazon orders:', wrongLinks.length);

  if (wrongLinks.length === 0) {
    console.log('\nNo wrongly linked orders found!');

    // Show breakdown by year
    const byYear = {};
    for (const o of invoicedOrders) {
      const date = new Date(o.orderDate || o.invoicedAt);
      if (!isNaN(date)) {
        const year = date.getFullYear();
        byYear[year] = (byYear[year] || 0) + 1;
      }
    }
    console.log('\nInvoiced orders by year:');
    for (const [year, count] of Object.entries(byYear).sort()) {
      console.log(`  ${year}: ${count}`);
    }

    await client.close();
    return;
  }

  // Group by the wrong order type
  const byType = {};
  for (const o of wrongLinks) {
    const name = o.odooSaleOrderName || 'unknown';
    const prefix = name.substring(0, 4);
    byType[prefix] = (byType[prefix] || 0) + 1;
  }
  console.log('\nBy order type prefix:');
  for (const [prefix, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + prefix + '...: ' + count);
  }

  // Group by year
  const byYear = {};
  for (const o of wrongLinks) {
    const date = new Date(o.orderDate || o.invoicedAt);
    if (!isNaN(date)) {
      const year = date.getFullYear();
      byYear[year] = (byYear[year] || 0) + 1;
    }
  }
  console.log('\nBy year:');
  for (const [year, count] of Object.entries(byYear).sort()) {
    console.log('  ' + year + ': ' + count);
  }

  // Show all wrong links
  console.log('\nAll wrong links:');
  for (const o of wrongLinks) {
    const date = o.orderDate ? new Date(o.orderDate).toISOString().split('T')[0] : 'unknown';
    console.log('  ' + o.orderId + ' -> ' + o.odooSaleOrderName + ' (Invoice: ' + (o.odooInvoiceName || '?') + ', Date: ' + date + ')');
  }

  await client.close();
}

checkWrongLinks().catch(console.error);
