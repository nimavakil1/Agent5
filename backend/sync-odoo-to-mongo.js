/**
 * Sync Odoo invoices back to MongoDB
 * Find all invoices created by Claude AI in Odoo and update MongoDB with correct references
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

  // Get ALL invoices with FBA or FBM origin (by any user)
  const invoices = await odoo.searchRead('account.move',
    [
      '|',
      ['invoice_origin', '=like', 'FBA%'],
      ['invoice_origin', '=like', 'FBM%'],
    ],
    ['id', 'name', 'invoice_origin', 'amount_total', 'state', 'create_uid'],
    0, 0
  );

  console.log(`\nFound ${invoices.length} Amazon invoices in Odoo`);

  // Build map of Amazon Order ID -> Invoice
  const invoiceMap = new Map();
  for (const inv of invoices) {
    if (inv.invoice_origin) {
      // invoice_origin is like "FBA203-2594229-1981159" or "FBM304-6614370-1334710"
      // Extract the Amazon order ID (the part after FBA/FBM prefix)
      // Format: FBA + 3digits-7digits-7digits
      const match = inv.invoice_origin.match(/^(?:FBA|FBM)(\d{3}-\d{7}-\d{7})$/);
      if (match) {
        const amazonOrderId = match[1];
        invoiceMap.set(amazonOrderId, inv);
      }
    }
  }

  console.log(`Mapped ${invoiceMap.size} invoices to Amazon order IDs`);

  // Get all MongoDB VCS orders
  const orders = await db.collection('amazon_vcs_orders').find().toArray();
  console.log(`\nFound ${orders.length} VCS orders in MongoDB`);

  // Update orders with matching invoices
  let updated = 0;
  let alreadyCorrect = 0;
  let notFound = 0;

  for (const order of orders) {
    const invoice = invoiceMap.get(order.orderId);

    if (invoice) {
      // Check if already has correct reference
      if (order.odooInvoiceId === invoice.id) {
        alreadyCorrect++;
        continue;
      }

      // Update MongoDB with correct invoice reference
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
      console.log(`  Updated: ${order.orderId} -> Invoice ${invoice.id} (${invoice.name})`);
      updated++;
    } else {
      // No invoice found in Odoo for this order
      if (order.status === 'pending' || order.status === 'skipped') {
        notFound++;
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`Updated: ${updated}`);
  console.log(`No invoice found: ${notFound}`);

  // Final verification
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

  console.log('\nSync complete!');
  process.exit(0);
}

sync().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
