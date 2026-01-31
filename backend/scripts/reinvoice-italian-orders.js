#!/usr/bin/env node
/**
 * Reinvoice the 25 Italian orders that had credit notes created
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { VcsOdooInvoicer } = require('../src/services/amazon/VcsOdooInvoicer');
const { connectDb, getDb } = require('../src/db');

// The 25 orders we need to reinvoice
const ORDER_IDS = [
  '303-0945049-8349959', '303-0744813-3521912', '302-1410869-6997100',
  '404-9404658-1934752', '408-4809305-5307507', '406-4527187-4218726',
  '408-5397132-6389917', '402-8333424-4113961', '407-9916439-4410725',
  '403-5857069-2592341', '408-7021541-9285163', '404-3747892-0180349',
  '402-6589307-2220339', '406-0479229-1475516', '407-8624660-3678767',
  '403-8665214-5233164', '406-6352119-3804349', '171-2898151-9135520',
  '402-1280032-6749143', '406-7925338-3719526', '403-4305852-0355510',
  '028-3719435-4837918', '402-6477616-1253901', '403-4074426-3695500',
  '403-1022052-1700340'
];

async function main() {
  await connectDb();
  const db = getDb();
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected\n');

  // Reset MongoDB status for these orders
  console.log('Step 1: Resetting MongoDB status...');
  const resetResult = await db.collection('amazon_vcs_orders').updateMany(
    { orderId: { $in: ORDER_IDS } },
    {
      $unset: { odooInvoiceId: '', odooInvoiceName: '', invoicedAt: '' },
      $set: { status: 'pending' }
    }
  );
  console.log(`Reset ${resetResult.modifiedCount} orders\n`);

  // Get MongoDB _ids for these orders (latest version)
  console.log('Step 2: Finding orders in MongoDB...');
  const orders = await db.collection('amazon_vcs_orders').aggregate([
    { $match: { orderId: { $in: ORDER_IDS } } },
    { $sort: { _id: -1 } },
    { $group: { _id: '$orderId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]).toArray();

  console.log(`Found ${orders.length} unique orders\n`);

  // Show order details
  for (const o of orders) {
    const isB2B = !!(o.buyerTaxRegistration && o.buyerTaxRegistration.trim());
    const scenario = isB2B ? 'B2B' : 'B2C';
    console.log(`  ${o.orderId}: ${o.shipFromCountry}->${o.shipToCountry} ${scenario} (total: ${o.totalExclusive})`);
  }
  console.log('');

  // Filter out orders with 0 total (can't invoice)
  const validOrders = orders.filter(o => o.totalExclusive > 0);
  console.log(`Valid orders (total > 0): ${validOrders.length}\n`);

  if (validOrders.length === 0) {
    console.log('No valid orders to invoice. Done.');
    process.exit(0);
  }

  const mongoIds = validOrders.map(o => o._id.toString());

  // Create new invoices
  console.log('Step 3: Creating new invoices...');
  const invoicer = new VcsOdooInvoicer(odoo);
  await invoicer.loadCache();

  const result = await invoicer.createInvoices({
    orderIds: mongoIds,
    dryRun: false,
    logCallback: (level, msg) => console.log(`[${level}] ${msg}`)
  });

  console.log('\n=== RESULT ===');
  console.log(`Created: ${result.created || 0}`);
  console.log(`Skipped: ${result.skipped || 0}`);
  console.log(`Manual required: ${result.manualRequired || 0}`);
  console.log(`Errors: ${result.errors || 0}`);

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
