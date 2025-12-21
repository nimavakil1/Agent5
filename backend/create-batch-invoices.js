/**
 * Create invoices for multiple VCS orders
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const { VcsOdooInvoicer } = require('./src/services/amazon/VcsOdooInvoicer');
const { connectDb, getDb } = require('./src/db');

const ORDER_IDS = [
  '304-6614370-1334710',  // BE → DE, 10050K-FBM
  '302-4133062-5732326',  // DE → DE, P0182
  '302-4345195-9801154',  // FR → DE, P0256
  '305-2939636-1587554',  // DE → AT, AGA4400
  '306-8525194-9408330',  // CZ → DE, P0220
  '303-8346715-0529118',  // IT → AT, B42058
  '303-0194238-6401101',  // FR → FR, B42030R4
  '028-9766164-6393128',  // BE → AT, 10050K-FBM
  '028-4883265-2670741',  // IT → DE, B42058
  '171-0262263-2203555',  // DE → ES, P0260
  '402-2977244-4065915',  // PL → BE, 41010-stickerless
  '408-2324707-5877938',  // DE → BE, 41007-stickerless
  '407-7348215-6290769',  // IT → FR, 82004
  '403-2976525-0261929',  // DE → FR, 10050W
  '408-9832182-3890733',  // BE → FR, 10060K-FBM
  '405-3014074-2454767',  // IT → IT, B42030R4
  '406-0236922-0747502',  // PL → IT, 83005W
];

async function main() {
  console.log('=== Creating Invoices for VCS Orders ===\n');

  // Connect to MongoDB
  await connectDb(process.env.MONGO_URI);
  const db = getDb();
  console.log('Connected to MongoDB');

  // Find orders in database
  console.log(`\nLooking for ${ORDER_IDS.length} orders...`);
  const orders = await db.collection('amazon_vcs_orders')
    .find({ orderId: { $in: ORDER_IDS } })
    .toArray();

  console.log(`Found ${orders.length} orders in database\n`);

  // Show which orders are found and their status
  const foundIds = orders.map(o => o.orderId);
  const missingIds = ORDER_IDS.filter(id => !foundIds.includes(id));

  if (missingIds.length > 0) {
    console.log('Missing orders (not in database):');
    missingIds.forEach(id => console.log(`  - ${id}`));
    console.log('');
  }

  // Show status of found orders
  console.log('Order status:');
  for (const order of orders) {
    console.log(`  ${order.orderId}: ${order.status} (${order.shipFromCountry} → ${order.shipToCountry})`);
  }

  // Filter to only pending orders
  const pendingOrders = orders.filter(o => o.status === 'pending');
  console.log(`\n${pendingOrders.length} orders ready to invoice (pending status)`);

  if (pendingOrders.length === 0) {
    console.log('\nNo pending orders to process. Resetting all found orders to pending...');
    for (const order of orders) {
      await db.collection('amazon_vcs_orders').updateOne(
        { _id: order._id },
        { $set: { status: 'pending' }, $unset: { odooInvoiceId: 1, odooInvoiceName: 1 } }
      );
    }
    console.log('Reset complete. Please run again to create invoices.');
    process.exit(0);
  }

  // Connect to Odoo
  const odoo = new OdooDirectClient({
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  });

  await odoo.authenticate();
  console.log('\nConnected to Odoo');

  // Create invoicer and load cache
  const invoicer = new VcsOdooInvoicer(odoo);
  await invoicer.loadCache();
  console.log('Cache loaded\n');

  // Get order IDs (MongoDB ObjectIds as strings)
  const orderIds = pendingOrders.map(o => o._id.toString());

  // Create invoices
  console.log('Creating invoices...\n');
  const result = await invoicer.createInvoices({
    orderIds,
    dryRun: false,
  });

  // Show results
  console.log('\n=== Results ===');
  console.log(`Processed: ${result.processed}`);
  console.log(`Created: ${result.created}`);
  console.log(`Skipped: ${result.skipped}`);
  console.log(`Errors: ${result.errors.length}`);

  if (result.invoices.length > 0) {
    console.log('\n=== Invoices Created ===');
    for (const inv of result.invoices) {
      console.log(`  ${inv.orderId} → Invoice ${inv.name || inv.id} (€${inv.amountTotal})`);
    }
  }

  if (result.errors.length > 0) {
    console.log('\n=== Errors ===');
    for (const err of result.errors) {
      console.log(`  ${err.orderId}: ${err.error}`);
    }
  }

  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
