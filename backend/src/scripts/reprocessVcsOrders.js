#!/usr/bin/env node
/**
 * Re-process the 9 VCS orders that were reset to pending
 * and report the new invoices created
 *
 * Usage:
 *   node src/scripts/reprocessVcsOrders.js
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

const AMAZON_ORDER_IDS = [
  '402-1160083-6363529',
  '405-7031124-1753168',
  '303-7993887-6359566',
  '407-6214261-6623568',
  '404-3134498-6558767',
  '402-3394787-4841132',
  '408-7203120-7093146',
  '403-4696052-1501900',
  '403-4652236-2349159',
];

async function main() {
  const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await mongoClient.connect();
  const db = mongoClient.db();

  console.log('Checking current status of the 9 VCS orders...\n');

  // Find the orders
  const orders = await db.collection('amazon_vcs_orders')
    .find({ orderId: { $in: AMAZON_ORDER_IDS } })
    .toArray();

  console.log(`Found ${orders.length} orders\n`);

  // Check their status
  const pendingOrders = orders.filter(o => o.status === 'pending');
  const invoicedOrders = orders.filter(o => o.status === 'invoiced');
  const otherOrders = orders.filter(o => o.status !== 'pending' && o.status !== 'invoiced');

  console.log(`Status breakdown:`);
  console.log(`  Pending: ${pendingOrders.length}`);
  console.log(`  Invoiced: ${invoicedOrders.length}`);
  console.log(`  Other: ${otherOrders.length}\n`);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  // If there are pending orders, process them
  if (pendingOrders.length > 0) {
    console.log(`Processing ${pendingOrders.length} pending orders via API...\n`);

    const mongoIds = pendingOrders.map(o => o._id.toString());
    console.log('MongoDB IDs:', mongoIds);

    // Use fetch to call the API (assuming server runs on port 3000)
    const apiUrl = process.env.API_URL || 'http://localhost:3000';
    const response = await fetch(`${apiUrl}/api/amazon/vcs/create-invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: mongoIds }),
    });

    const result = await response.json();
    console.log('\nAPI Response:');
    console.log(JSON.stringify(result, null, 2));

    // Wait a moment for the database to update
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Now report the final status of all 9 orders
  console.log('\n' + '='.repeat(80));
  console.log('FINAL STATUS REPORT');
  console.log('='.repeat(80) + '\n');

  const finalOrders = await db.collection('amazon_vcs_orders')
    .find({ orderId: { $in: AMAZON_ORDER_IDS } })
    .toArray();

  for (const o of finalOrders) {
    console.log(`Amazon Order: ${o.orderId}`);
    console.log(`  Status: ${o.status}`);

    if (o.status === 'invoiced') {
      console.log(`  Linked Odoo Order: ${o.odooSaleOrderName || 'N/A'}`);
      console.log(`  Invoice: ${o.odooInvoiceName || 'N/A'} (ID: ${o.odooInvoiceId || 'N/A'})`);

      if (o.odooInvoiceId) {
        try {
          const invoices = await odoo.searchRead('account.move',
            [['id', '=', o.odooInvoiceId]],
            ['id', 'name', 'state', 'amount_total', 'invoice_origin']
          );
          if (invoices.length > 0) {
            const inv = invoices[0];
            console.log(`  Invoice State: ${inv.state}`);
            console.log(`  Invoice Amount: ${inv.amount_total}`);
            console.log(`  Invoice Origin: ${inv.invoice_origin || '(none)'}`);
          }
        } catch (err) {
          console.log(`  Error fetching invoice: ${err.message}`);
        }
      }
    } else if (o.status === 'error') {
      console.log(`  Error: ${o.error || 'Unknown error'}`);
    }
    console.log('');
  }

  console.log('='.repeat(80));

  await mongoClient.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
