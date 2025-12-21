/**
 * Sync MongoDB VCS orders with ALL invoices created by Claude AI
 * Searches by create_uid instead of invoice_origin format
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

  // Find Claude AI user
  const users = await odoo.searchRead('res.users',
    [['name', 'ilike', 'Claude']],
    ['id', 'name']
  );

  if (users.length === 0) {
    console.error('Claude AI user not found!');
    process.exit(1);
  }

  const claudeUserId = users[0].id;
  console.log(`Found Claude AI user: ID ${claudeUserId}, Name: ${users[0].name}`);

  // Get ALL invoices created by Claude AI (no invoice_origin filter)
  const invoices = await odoo.searchRead('account.move',
    [
      ['create_uid', '=', claudeUserId],
      ['move_type', '=', 'out_invoice'],
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'partner_id', 'amount_total', 'state'],
    0, 0
  );

  console.log(`\nFound ${invoices.length} invoices created by Claude AI`);

  // Build map of Amazon Order ID -> Invoice
  // Try multiple patterns to extract order ID
  const invoiceMap = new Map();
  const unmatchedInvoices = [];

  for (const inv of invoices) {
    let orderId = null;

    // Pattern 1: invoice_origin like "FBA203-2594229-1981159" or "FBM..."
    if (inv.invoice_origin) {
      const match1 = inv.invoice_origin.match(/^(?:FBA|FBM)(\d{3}-\d{7}-\d{7})$/);
      if (match1) {
        orderId = match1[1];
      }

      // Pattern 2: Just the order ID in invoice_origin
      if (!orderId) {
        const match2 = inv.invoice_origin.match(/(\d{3}-\d{7}-\d{7})/);
        if (match2) {
          orderId = match2[1];
        }
      }
    }

    // Pattern 3: Check ref field
    if (!orderId && inv.ref) {
      const match3 = inv.ref.match(/(\d{3}-\d{7}-\d{7})/);
      if (match3) {
        orderId = match3[1];
      }
    }

    // Pattern 4: Check name field (some invoices might have it there)
    if (!orderId && inv.name) {
      const match4 = inv.name.match(/(\d{3}-\d{7}-\d{7})/);
      if (match4) {
        orderId = match4[1];
      }
    }

    if (orderId) {
      invoiceMap.set(orderId, inv);
    } else {
      unmatchedInvoices.push(inv);
    }
  }

  console.log(`Mapped ${invoiceMap.size} invoices to Amazon order IDs`);

  if (unmatchedInvoices.length > 0) {
    console.log(`\nInvoices without extractable order ID: ${unmatchedInvoices.length}`);
    for (const inv of unmatchedInvoices.slice(0, 10)) {
      console.log(`  ID: ${inv.id}, Name: ${inv.name}, Origin: ${inv.invoice_origin}, Ref: ${inv.ref}`);
    }
    if (unmatchedInvoices.length > 10) {
      console.log(`  ... and ${unmatchedInvoices.length - 10} more`);
    }
  }

  // Get all MongoDB VCS orders
  const orders = await db.collection('amazon_vcs_orders').find().toArray();
  console.log(`\nFound ${orders.length} VCS orders in MongoDB`);

  // Check current state
  const pendingOrSkipped = orders.filter(o => o.status === 'pending' || o.status === 'skipped');
  console.log(`Orders pending or skipped: ${pendingOrSkipped.length}`);

  // Update orders with matching invoices
  let updated = 0;
  let alreadyCorrect = 0;
  let notFound = 0;
  const notFoundOrders = [];

  for (const order of orders) {
    const invoice = invoiceMap.get(order.orderId);

    if (invoice) {
      // Check if already has correct reference
      if (order.odooInvoiceId === invoice.id && order.status === 'invoiced') {
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
      if (order.status === 'pending' || order.status === 'skipped') {
        notFound++;
        notFoundOrders.push(order.orderId);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`Updated: ${updated}`);
  console.log(`No invoice found (pending/skipped): ${notFound}`);

  if (notFoundOrders.length > 0 && notFoundOrders.length <= 30) {
    console.log(`\nOrders without invoices in Odoo:`);
    for (const id of notFoundOrders) {
      console.log(`  ${id}`);
    }
  }

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
