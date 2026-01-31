#!/usr/bin/env node
/**
 * Reset and recreate Italian exception invoices to test new logic
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient, ObjectId } = require('mongodb');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { VcsOdooInvoicer } = require('../src/services/amazon/VcsOdooInvoicer');
const { connectDb, getDb } = require('../src/db');

// Orders to reset and recreate (covering different scenarios)
const ORDERS_TO_RESET = [
  { orderId: '406-0898893-1998741', invoice: 'VIT/2025/02909', scenario: 'B2C domestic IT->IT' },
  { orderId: '305-1858902-3925127', invoice: 'VIT/2025/03147', scenario: 'B2C cross-border IT->DE' },
  { orderId: '405-4567449-9705122', invoice: 'VIT/2025/02918', scenario: 'B2B domestic IT->IT' },
];

async function main() {
  await connectDb();
  const db = getDb();

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo and MongoDB\n');

  // Step 1: Delete invoices in Odoo
  console.log('=== STEP 1: Delete existing invoices ===\n');

  for (const order of ORDERS_TO_RESET) {
    console.log(`Processing ${order.scenario}: ${order.orderId}`);

    // Find the invoice
    const invoices = await odoo.searchRead('account.move',
      [['name', '=', order.invoice]],
      ['id', 'name', 'state']
    );

    if (invoices.length === 0) {
      console.log(`  Invoice ${order.invoice} not found, skipping\n`);
      continue;
    }

    const invoice = invoices[0];
    console.log(`  Found invoice: ${invoice.name} (state: ${invoice.state})`);

    try {
      // Reset to draft if posted
      if (invoice.state === 'posted') {
        console.log('  Resetting to draft...');
        await odoo.execute('account.move', 'button_draft', [[invoice.id]]);
      }

      // Delete the invoice
      console.log('  Deleting invoice...');
      await odoo.execute('account.move', 'unlink', [[invoice.id]]);
      console.log('  Deleted!\n');
    } catch (err) {
      console.log(`  Error: ${err.message}\n`);
    }
  }

  // Step 2: Reset MongoDB status
  console.log('=== STEP 2: Reset MongoDB status ===\n');

  const orderIds = ORDERS_TO_RESET.map(o => o.orderId);
  const result = await db.collection('amazon_vcs_orders').updateMany(
    { orderId: { $in: orderIds } },
    {
      $unset: { odooInvoiceId: '', odooInvoiceName: '', invoicedAt: '' },
      $set: { status: 'pending' }
    }
  );
  console.log(`Reset ${result.modifiedCount} orders in MongoDB\n`);

  // Step 3: Recreate invoices with new logic
  console.log('=== STEP 3: Recreate invoices ===\n');

  // Get the MongoDB _ids for these orders (latest version)
  const orders = await db.collection('amazon_vcs_orders').aggregate([
    { $match: { orderId: { $in: orderIds } } },
    { $sort: { _id: -1 } },
    { $group: { _id: '$orderId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]).toArray();

  console.log(`Found ${orders.length} orders to recreate\n`);

  const mongoIds = orders.map(o => o._id.toString());

  const invoicer = new VcsOdooInvoicer(odoo);
  await invoicer.loadCache();

  const invoiceResult = await invoicer.createInvoices({
    orderIds: mongoIds,
    dryRun: false,
    logCallback: (level, msg) => console.log(`[${level}] ${msg}`)
  });

  // Step 4: Verify the new invoices
  console.log('\n=== STEP 4: Verify new invoices ===\n');

  for (const order of ORDERS_TO_RESET) {
    // Get the order from MongoDB to find new invoice ID
    const mongoOrder = await db.collection('amazon_vcs_orders').findOne({ orderId: order.orderId });

    if (!mongoOrder || !mongoOrder.odooInvoiceId) {
      console.log(`${order.scenario}: No invoice created\n`);
      continue;
    }

    const invoice = await odoo.searchRead('account.move',
      [['id', '=', mongoOrder.odooInvoiceId]],
      ['id', 'name', 'fiscal_position_id', 'amount_total', 'amount_tax', 'amount_untaxed']
    );

    if (invoice.length > 0) {
      const inv = invoice[0];
      console.log(`${order.scenario}`);
      console.log(`  Order: ${order.orderId}`);
      console.log(`  NEW Invoice: ${inv.name}`);
      console.log(`  Fiscal Position: ${inv.fiscal_position_id ? inv.fiscal_position_id[1] : 'None'}`);
      console.log(`  Amount (excl): ${inv.amount_untaxed}`);
      console.log(`  Tax: ${inv.amount_tax}`);
      console.log(`  Total: ${inv.amount_total}`);

      // Get line taxes
      const lines = await odoo.searchRead('account.move.line',
        [['move_id', '=', inv.id], ['product_id', '!=', false]],
        ['name', 'tax_ids']
      );
      if (lines.length > 0) {
        for (const line of lines) {
          if (line.tax_ids && line.tax_ids.length > 0) {
            const taxes = await odoo.searchRead('account.tax', [['id', 'in', line.tax_ids]], ['name']);
            console.log(`  Line tax: ${taxes.map(t => t.name).join(', ')}`);
          }
        }
      }
      console.log('');
    }
  }

  console.log('=== DONE ===');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
