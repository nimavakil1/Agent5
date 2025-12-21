/**
 * Sync the 16 skipped orders that have invoices by other users
 * These were skipped because "Invoice already exists"
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const { connectDb, getDb } = require('./src/db');

async function sync() {
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

  // Get skipped orders
  const skippedOrders = await db.collection('amazon_vcs_orders').find({
    status: 'skipped',
    skipReason: { $regex: /Invoice already exists/ }
  }).toArray();

  console.log(`\nFound ${skippedOrders.length} skipped orders with "Invoice already exists" reason`);

  // Get ALL invoices (by any user) with December 2025 invoice dates
  const allInvoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['invoice_date', '>=', '2025-12-01'],
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'create_uid'],
    0, 0
  );
  console.log(`Found ${allInvoices.length} invoices from December 2025`);

  // Build map of order ID -> invoice
  const invoiceMap = new Map();
  for (const inv of allInvoices) {
    // Try invoice_origin
    if (inv.invoice_origin) {
      const match = inv.invoice_origin.match(/(?:FBA|FBM)?(\d{3}-\d{7}-\d{7})/);
      if (match) {
        invoiceMap.set(match[1], inv);
        continue;
      }
    }
    // Try ref
    if (inv.ref) {
      const match = inv.ref.match(/(\d{3}-\d{7}-\d{7})/);
      if (match) {
        invoiceMap.set(match[1], inv);
      }
    }
  }
  console.log(`Mapped ${invoiceMap.size} invoices to order IDs`);

  // Update skipped orders
  let found = 0;
  let notFound = 0;
  for (const order of skippedOrders) {
    const invoice = invoiceMap.get(order.orderId);
    if (invoice) {
      await db.collection('amazon_vcs_orders').updateOne(
        { _id: order._id },
        {
          $set: {
            status: 'invoiced',
            odooInvoiceId: invoice.id,
            odooInvoiceName: invoice.name
          },
          $unset: { skipReason: 1 }
        }
      );
      console.log(`  Updated: ${order.orderId} -> Invoice ${invoice.id} (${invoice.name}) by ${invoice.create_uid[1]}`);
      found++;
    } else {
      console.log(`  NOT FOUND: ${order.orderId}`);
      notFound++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Found and updated: ${found}`);
  console.log(`Not found: ${notFound}`);

  // Also try to find the remaining 38 pending orders
  const pendingOrders = await db.collection('amazon_vcs_orders').find({
    status: 'pending'
  }).toArray();

  console.log(`\n=== Checking ${pendingOrders.length} pending orders ===`);
  let pendingFound = 0;
  for (const order of pendingOrders) {
    const invoice = invoiceMap.get(order.orderId);
    if (invoice) {
      await db.collection('amazon_vcs_orders').updateOne(
        { _id: order._id },
        {
          $set: {
            status: 'invoiced',
            odooInvoiceId: invoice.id,
            odooInvoiceName: invoice.name
          }
        }
      );
      console.log(`  Updated pending: ${order.orderId} -> Invoice ${invoice.id} (${invoice.name}) by ${invoice.create_uid[1]}`);
      pendingFound++;
    }
  }
  console.log(`Pending orders matched to invoices: ${pendingFound}`);

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

sync().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
