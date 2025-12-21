/**
 * Update the 14 skipped orders that have invoices we found
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const { connectDb, getDb } = require('./src/db');

async function update() {
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

  // The 14 skipped orders with their invoices (from find-alternative-invoices.js)
  const mapping = [
    { orderId: '302-4133062-5732326', invoiceId: 353831 },
    { orderId: '302-4345195-9801154', invoiceId: 353832 },
    { orderId: '305-2939636-1587554', invoiceId: 353833 },
    { orderId: '306-8525194-9408330', invoiceId: 353834 },
    { orderId: '303-8346715-0529118', invoiceId: 353835 },
    { orderId: '303-0194238-6401101', invoiceId: 353836 },
    { orderId: '028-4883265-2670741', invoiceId: 353838 },
    { orderId: '171-0262263-2203555', invoiceId: 353839 },
    { orderId: '402-2977244-4065915', invoiceId: 353840 },
    { orderId: '408-2324707-5877938', invoiceId: 353841 },
    { orderId: '407-7348215-6290769', invoiceId: 353842 },
    { orderId: '403-2976525-0261929', invoiceId: 353843 },
    { orderId: '405-3014074-2454767', invoiceId: 353845 },
    { orderId: '406-0236922-0747502', invoiceId: 353846 },
  ];

  console.log(`\nUpdating ${mapping.length} orders...`);

  for (const { orderId, invoiceId } of mapping) {
    await db.collection('amazon_vcs_orders').updateOne(
      { orderId: orderId },
      {
        $set: {
          status: 'invoiced',
          odooInvoiceId: invoiceId,
          odooInvoiceName: '/'
        },
        $unset: { skipReason: 1 }
      }
    );
    console.log(`  Updated: ${orderId} -> Invoice ${invoiceId}`);
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

  // Show remaining orders without invoices
  const stillMissing = await db.collection('amazon_vcs_orders').find({
    $or: [{ status: 'pending' }, { status: 'skipped' }]
  }).toArray();

  console.log(`\n=== Orders still without invoices: ${stillMissing.length} ===`);
  for (const o of stillMissing) {
    console.log(`  ${o.orderId} - ${o.status} - ${o.skipReason || ''}`);
  }

  process.exit(0);
}

update().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
