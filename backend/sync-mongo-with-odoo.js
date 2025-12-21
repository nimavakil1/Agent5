/**
 * Sync MongoDB VCS orders with Odoo invoices
 * - Remove orphaned invoice references (odooInvoiceId pointing to deleted invoices)
 * - Reset those orders to "pending" status
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const { connectDb, getDb } = require('./src/db');

async function sync() {
  // Connect to MongoDB
  await connectDb(process.env.MONGO_URI);
  const db = getDb();
  console.log('Connected to MongoDB');

  // Connect to Odoo
  const odoo = new OdooDirectClient({
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  });
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Get all orders with odooInvoiceId from MongoDB
  const ordersWithInvoiceId = await db.collection('amazon_vcs_orders')
    .find({ odooInvoiceId: { $exists: true } })
    .toArray();

  console.log(`\nMongoDB orders with odooInvoiceId: ${ordersWithInvoiceId.length}`);

  // Get all invoice IDs referenced
  const invoiceIds = ordersWithInvoiceId.map(o => o.odooInvoiceId);
  const uniqueInvoiceIds = [...new Set(invoiceIds)];

  // Check which of these actually exist in Odoo
  const existingInvoices = await odoo.searchRead('account.move',
    [['id', 'in', uniqueInvoiceIds]],
    ['id', 'name', 'invoice_origin']
  );

  const existingIds = new Set(existingInvoices.map(i => i.id));
  console.log(`Invoices that exist in Odoo: ${existingIds.size}`);

  // Find orders with orphaned references
  const orphanedOrders = ordersWithInvoiceId.filter(o => !existingIds.has(o.odooInvoiceId));
  console.log(`Orders with orphaned invoice references: ${orphanedOrders.length}`);

  if (orphanedOrders.length === 0) {
    console.log('\nNo orphaned references found. MongoDB is in sync with Odoo.');
    process.exit(0);
  }

  // Reset orphaned orders to pending
  console.log('\n=== Resetting orphaned orders to pending ===');
  let resetCount = 0;
  for (const order of orphanedOrders) {
    await db.collection('amazon_vcs_orders').updateOne(
      { _id: order._id },
      {
        $set: { status: 'pending' },
        $unset: { odooInvoiceId: 1, odooInvoiceName: 1 }
      }
    );
    console.log(`  Reset: ${order.orderId} (was pointing to deleted invoice ${order.odooInvoiceId})`);
    resetCount++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Orders reset to pending: ${resetCount}`);

  // Verify final state
  const finalInvoiced = await db.collection('amazon_vcs_orders').countDocuments({
    odooInvoiceId: { $exists: true }
  });
  const finalPending = await db.collection('amazon_vcs_orders').countDocuments({
    status: 'pending'
  });
  const finalSkipped = await db.collection('amazon_vcs_orders').countDocuments({
    status: 'skipped'
  });

  console.log(`\n=== Final MongoDB State ===`);
  console.log(`Orders with valid odooInvoiceId: ${finalInvoiced}`);
  console.log(`Orders pending: ${finalPending}`);
  console.log(`Orders skipped: ${finalSkipped}`);

  console.log('\nSync complete!');
  process.exit(0);
}

sync().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
