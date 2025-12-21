/**
 * Check for orphaned invoice references in MongoDB (orders that claim to have
 * an invoice in Odoo but the invoice may not exist)
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const { connectDb, getDb } = require('./src/db');

async function check() {
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
  console.log(`Unique invoice IDs referenced: ${uniqueInvoiceIds.length}`);

  // Check which of these actually exist in Odoo
  const existingInvoices = await odoo.searchRead('account.move',
    [['id', 'in', uniqueInvoiceIds]],
    ['id', 'name', 'state', 'invoice_origin']
  );

  console.log(`Invoices that actually exist in Odoo: ${existingInvoices.length}`);

  const existingIds = new Set(existingInvoices.map(i => i.id));
  const missingIds = uniqueInvoiceIds.filter(id => !existingIds.has(id));

  console.log(`\n=== Missing Invoices (referenced in MongoDB but not in Odoo) ===`);
  console.log(`Count: ${missingIds.length}`);

  if (missingIds.length > 0) {
    console.log(`IDs: ${missingIds.join(', ')}`);

    // Show which orders reference these missing invoices
    console.log(`\nOrders referencing missing invoices:`);
    for (const order of ordersWithInvoiceId) {
      if (!existingIds.has(order.odooInvoiceId)) {
        console.log(`  ${order.orderId} -> Missing Invoice ID: ${order.odooInvoiceId}`);
      }
    }
  }

  // Also check for invoices created by Claude AI that are NOT in the Amazon list
  console.log('\n=== Checking all invoices created by Claude AI ===');
  const claudeInvoices = await odoo.searchRead('account.move',
    [['create_uid.name', 'ilike', 'Claude']],
    ['id', 'name', 'invoice_origin', 'amount_total', 'state']
  );
  console.log(`Total invoices by Claude AI: ${claudeInvoices.length}`);

  // Check if any have no invoice_origin or non-Amazon origin
  const nonAmazon = claudeInvoices.filter(i =>
    !i.invoice_origin ||
    (!i.invoice_origin.startsWith('FBA') && !i.invoice_origin.startsWith('FBM'))
  );

  if (nonAmazon.length > 0) {
    console.log(`\nInvoices without FBA/FBM origin:`);
    for (const inv of nonAmazon) {
      console.log(`  ${inv.id} | ${inv.name} | ${inv.invoice_origin || 'NO ORIGIN'} | €${inv.amount_total}`);
    }
  }

  process.exit(0);
}

check().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
