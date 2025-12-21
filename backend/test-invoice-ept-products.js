/**
 * Test script to create invoice for order 305-1901951-5970703
 * This order has shipping and shipping promo to test EPT product IDs
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const { VcsOdooInvoicer } = require('./src/services/amazon/VcsOdooInvoicer');
const { connectDb, getDb } = require('./src/db');

async function test() {
  console.log('=== Testing Invoice Creation with EPT Products ===\n');

  // Connect to MongoDB using the db module
  await connectDb(process.env.MONGO_URI);
  const db = getDb();
  console.log('Connected to MongoDB');

  // Find the test order
  const orderId = '305-1901951-5970703';
  const order = await db.collection('amazon_vcs_orders').findOne({ orderId });

  if (!order) {
    console.log('Order not found:', orderId);
    return;
  }

  console.log('Found order:', order.orderId);
  console.log('  Status:', order.status);
  console.log('  Shipping:', order.totalShipping);
  console.log('  Shipping Promo:', order.totalShippingPromo);
  console.log('  Items:', order.items?.length || 0);

  if (order.status !== 'pending') {
    console.log('\nOrder is not pending. Resetting to pending...');
    await db.collection('amazon_vcs_orders').updateOne(
      { _id: order._id },
      { $set: { status: 'pending' }, $unset: { odooInvoiceId: 1, odooInvoiceName: 1 } }
    );
    console.log('Reset to pending.');
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
  console.log('Cache loaded');

  // Create invoice
  console.log('\nCreating invoice...');
  const result = await invoicer.createInvoices({
    orderIds: [order._id.toString()],
    dryRun: false,
  });

  console.log('\n=== Result ===');
  console.log(JSON.stringify(result, null, 2));

  if (result.invoices?.length > 0) {
    const inv = result.invoices[0];
    console.log('\n=== Invoice Created ===');
    console.log('Invoice ID:', inv.id);
    console.log('Invoice Name:', inv.name);
    console.log('Amount Total:', inv.amountTotal);
    console.log('Amount Tax:', inv.amountTax);

    // Fetch invoice lines to verify product IDs
    console.log('\n=== Invoice Lines ===');
    const lines = await odoo.searchRead('account.move.line',
      [['move_id', '=', inv.id], ['display_type', '=', false]],
      ['name', 'product_id', 'quantity', 'price_unit', 'price_subtotal', 'price_total']
    );

    for (const line of lines) {
      console.log('  -', line.name);
      console.log('    Product:', line.product_id ? `${line.product_id[1]} (ID: ${line.product_id[0]})` : 'None');
      console.log('    Unit Price:', line.price_unit);
      console.log('    Subtotal:', line.price_subtotal);
    }
  }

  console.log('\nDone!');
}

test().catch(console.error);
