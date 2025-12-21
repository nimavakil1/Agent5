/**
 * Sync ALL Odoo invoices matching VCS orders to MongoDB
 * Searches by order ID in invoice_origin, ref, and narration
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

  // Get all VCS order IDs from MongoDB
  const orders = await db.collection('amazon_vcs_orders').find().toArray();
  console.log(`\nFound ${orders.length} VCS orders in MongoDB`);

  const orderIds = orders.map(o => o.orderId);

  // Get ALL recent invoices from Odoo (December 2025)
  const allInvoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['create_date', '>=', '2025-12-01'],
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'amount_total', 'state', 'create_uid'],
    0, 500
  );

  console.log(`Found ${allInvoices.length} invoices created in December 2025`);

  // Try to match invoices to orders
  const invoiceMap = new Map();

  for (const inv of allInvoices) {
    // Try matching by invoice_origin
    if (inv.invoice_origin) {
      const match = inv.invoice_origin.match(/(?:FBA|FBM)?(\d{3}-\d{7}-\d{7})/);
      if (match) {
        invoiceMap.set(match[1], inv);
        continue;
      }
    }

    // Try matching by ref
    if (inv.ref) {
      const match = inv.ref.match(/(\d{3}-\d{7}-\d{7})/);
      if (match) {
        invoiceMap.set(match[1], inv);
        continue;
      }
    }
  }

  console.log(`Mapped ${invoiceMap.size} invoices to Amazon order IDs`);

  // Show which orders we found
  let matched = 0;
  let notMatched = 0;
  const unmatchedOrders = [];

  for (const orderId of orderIds) {
    if (invoiceMap.has(orderId)) {
      matched++;
    } else {
      notMatched++;
      unmatchedOrders.push(orderId);
    }
  }

  console.log(`\nMatched: ${matched}, Not matched: ${notMatched}`);

  if (unmatchedOrders.length > 0 && unmatchedOrders.length <= 20) {
    console.log('\nUnmatched orders:');
    for (const id of unmatchedOrders) {
      console.log(`  ${id}`);
    }
  }

  // Update MongoDB with matched invoices
  console.log('\n=== Updating MongoDB ===');
  let updated = 0;
  let alreadyCorrect = 0;

  for (const order of orders) {
    const invoice = invoiceMap.get(order.orderId);

    if (invoice) {
      if (order.odooInvoiceId === invoice.id) {
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
          }
        }
      );
      console.log(`  Updated: ${order.orderId} -> Invoice ${invoice.id} (${invoice.name}) by ${invoice.create_uid[1]}`);
      updated++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`Updated: ${updated}`);
  console.log(`No invoice found: ${notMatched}`);

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
