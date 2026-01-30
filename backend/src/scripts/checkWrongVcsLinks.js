#!/usr/bin/env node
/**
 * Check for VCS orders that were incorrectly linked to non-Amazon orders
 * (BOL orders, direct sales, etc.)
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

async function checkWrongLinks() {
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await client.connect();
  const db = client.db();

  // Find all invoiced VCS orders
  const invoicedOrders = await db.collection('amazon_vcs_orders')
    .find({ status: 'invoiced', odooSaleOrderName: { $exists: true } })
    .toArray();

  console.log('Total invoiced VCS orders:', invoicedOrders.length);

  // Check which ones are linked to non-Amazon orders
  const wrongLinks = invoicedOrders.filter(o => {
    const name = o.odooSaleOrderName || '';
    // Amazon orders start with FBA or FBM
    return !name.startsWith('FBA') && !name.startsWith('FBM');
  });

  console.log('Wrongly linked to non-Amazon orders:', wrongLinks.length);

  if (wrongLinks.length === 0) {
    console.log('\nNo wrongly linked orders found!');
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

  // Show some examples
  console.log('\nExamples of wrong links:');
  for (const o of wrongLinks.slice(0, 15)) {
    console.log('  ' + o.orderId + ' -> ' + o.odooSaleOrderName + ' (Invoice: ' + (o.odooInvoiceName || '?') + ')');
  }

  // Check date range
  const dates = wrongLinks.map(o => new Date(o.invoicedAt || o.orderDate)).filter(d => !isNaN(d));
  if (dates.length > 0) {
    dates.sort((a, b) => a - b);
    console.log('\nDate range of wrong links:');
    console.log('  Earliest:', dates[0].toISOString().split('T')[0]);
    console.log('  Latest:', dates[dates.length - 1].toISOString().split('T')[0]);
  }

  await client.close();
}

checkWrongLinks().catch(console.error);
