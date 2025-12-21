/**
 * Check if the 18 pending orders have invoices in Odoo
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const { connectDb, getDb } = require('./src/db');

async function check() {
  await connectDb(process.env.MONGO_URI);
  const db = getDb();
  console.log('Connected to MongoDB');

  const odoo = new OdooDirectClient({
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  });
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Get pending orders
  const pendingOrders = await db.collection('amazon_vcs_orders').find({
    status: 'pending'
  }).toArray();

  console.log(`\nPending orders: ${pendingOrders.length}`);

  let found = 0;
  let notFound = 0;
  const toUpdate = [];

  for (const order of pendingOrders) {
    // Search by order ID in invoice_origin
    const invoices = await odoo.searchRead('account.move',
      [
        ['invoice_origin', 'ilike', order.orderId],
        ['move_type', '=', 'out_invoice'],
      ],
      ['id', 'name', 'invoice_origin', 'create_uid'],
      0, 5
    );

    if (invoices.length > 0) {
      found++;
      console.log(`  FOUND: ${order.orderId} -> Invoice ${invoices[0].id} (${invoices[0].name}) by ${invoices[0].create_uid[1]}`);
      toUpdate.push({ orderId: order.orderId, invoice: invoices[0] });
    } else {
      notFound++;
      console.log(`  NOT FOUND: ${order.orderId}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Found in Odoo: ${found}`);
  console.log(`Not in Odoo: ${notFound}`);

  // Update the ones we found
  if (toUpdate.length > 0) {
    console.log(`\n=== Updating ${toUpdate.length} orders ===`);
    for (const { orderId, invoice } of toUpdate) {
      await db.collection('amazon_vcs_orders').updateOne(
        { orderId },
        {
          $set: {
            status: 'invoiced',
            odooInvoiceId: invoice.id,
            odooInvoiceName: invoice.name
          }
        }
      );
      console.log(`  Updated: ${orderId} -> Invoice ${invoice.id}`);
    }
  }

  // Final state
  const finalStats = await db.collection('amazon_vcs_orders').aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();

  console.log(`\n=== Final MongoDB State ===`);
  for (const s of finalStats) {
    console.log(`  ${s._id}: ${s.count}`);
  }

  const withInvoiceId = await db.collection('amazon_vcs_orders').countDocuments({
    odooInvoiceId: { $exists: true }
  });
  console.log(`  Orders with odooInvoiceId: ${withInvoiceId}`);

  process.exit(0);
}

check().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
