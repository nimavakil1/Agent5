/**
 * Final sync - get ALL invoices with Amazon order patterns
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

  // Get ALL invoices with FBA/FBM origin (any user, any date)
  const fbaInvoices = await odoo.searchRead('account.move',
    [
      ['invoice_origin', '=like', 'FBA%'],
      ['move_type', '=', 'out_invoice'],
    ],
    ['id', 'name', 'invoice_origin', 'create_uid'],
    0, 0
  );

  const fbmInvoices = await odoo.searchRead('account.move',
    [
      ['invoice_origin', '=like', 'FBM%'],
      ['move_type', '=', 'out_invoice'],
    ],
    ['id', 'name', 'invoice_origin', 'create_uid'],
    0, 0
  );

  const allAmazonInvoices = [...fbaInvoices, ...fbmInvoices];
  console.log(`\nTotal Amazon invoices (FBA/FBM): ${allAmazonInvoices.length}`);
  console.log(`  FBA: ${fbaInvoices.length}, FBM: ${fbmInvoices.length}`);

  // Build map
  const invoiceMap = new Map();
  for (const inv of allAmazonInvoices) {
    if (inv.invoice_origin) {
      // Extract order ID from FBA/FBM prefix
      const match = inv.invoice_origin.match(/(?:FBA|FBM)(\d{3}-\d{7}-\d{7})/);
      if (match) {
        invoiceMap.set(match[1], inv);
      }
    }
  }
  console.log(`Mapped ${invoiceMap.size} invoices to order IDs`);

  // Get all VCS orders
  const orders = await db.collection('amazon_vcs_orders').find().toArray();
  console.log(`\nTotal VCS orders: ${orders.length}`);

  // Update ALL orders that have matching invoices
  let updated = 0;
  let alreadyCorrect = 0;
  let notFound = 0;

  for (const order of orders) {
    const invoice = invoiceMap.get(order.orderId);

    if (invoice) {
      if (order.odooInvoiceId === invoice.id && order.status === 'invoiced') {
        alreadyCorrect++;
        continue;
      }

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
      updated++;
    } else {
      notFound++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`Updated: ${updated}`);
  console.log(`Not found: ${notFound}`);

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

  // Show remaining orders without invoices
  const stillMissing = await db.collection('amazon_vcs_orders').find({
    $or: [{ status: 'pending' }, { status: 'skipped' }]
  }).toArray();

  console.log(`\n=== Orders still without invoices: ${stillMissing.length} ===`);
  if (stillMissing.length <= 60) {
    for (const o of stillMissing) {
      console.log(`  ${o.orderId} - ${o.status} - ${o.skipReason || ''}`);
    }
  }

  process.exit(0);
}

sync().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
