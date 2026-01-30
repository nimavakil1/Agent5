#!/usr/bin/env node
/**
 * Re-process the 4 remaining VCS orders
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

const AMAZON_ORDER_IDS = [
  '402-3394787-4841132',
  '408-7203120-7093146',
  '403-4696052-1501900',
  '403-4652236-2349159',
];

async function main() {
  const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await mongoClient.connect();
  const db = mongoClient.db();

  console.log('Finding the 4 remaining VCS orders...\n');

  // Find the orders
  const orders = await db.collection('amazon_vcs_orders')
    .find({ orderId: { $in: AMAZON_ORDER_IDS } })
    .toArray();

  console.log(`Found ${orders.length} orders\n`);

  // Reset them to pending first
  console.log('Resetting orders to pending status...\n');
  for (const o of orders) {
    await db.collection('amazon_vcs_orders').updateOne(
      { _id: o._id },
      { $set: { status: 'pending' } }
    );
    console.log(`  ${o.orderId}: reset to pending`);
  }

  // Get their MongoDB IDs
  const mongoIds = orders.map(o => o._id.toString());
  console.log('\nMongoDB IDs:', mongoIds);

  // Call the API to process them
  console.log('\nCalling API to create invoices...\n');

  const apiUrl = process.env.API_URL || 'http://localhost:3000';
  const response = await fetch(`${apiUrl}/api/amazon/vcs/create-invoices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderIds: mongoIds, dryRun: false }),
  });

  const result = await response.json();
  console.log('API Response:');
  console.log(JSON.stringify(result, null, 2));

  // Check final status
  console.log('\n' + '='.repeat(80));
  console.log('FINAL STATUS REPORT');
  console.log('='.repeat(80) + '\n');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

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
