/**
 * Find invoices for the 14 skipped orders that have "Invoice already exists"
 * These might have a different invoice_origin format
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const { connectDb, getDb } = require('./src/db');

async function find() {
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

  // Get the 14 skipped orders
  const skippedOrders = await db.collection('amazon_vcs_orders').find({
    status: 'skipped',
    skipReason: { $regex: /Invoice already exists/ }
  }).toArray();

  console.log(`\nSkipped orders to find: ${skippedOrders.length}`);
  const orderIds = skippedOrders.map(o => o.orderId);
  console.log('Order IDs:', orderIds);

  // For each order, search in Odoo by looking at the order ID pattern anywhere in invoice
  console.log('\n=== Searching for each order ===');

  for (const orderId of orderIds) {
    // Search by invoice_origin containing the order ID
    let found = await odoo.searchRead('account.move',
      [
        ['invoice_origin', 'ilike', orderId],
        ['move_type', '=', 'out_invoice'],
      ],
      ['id', 'name', 'invoice_origin', 'ref', 'create_uid'],
      0, 5
    );

    if (found.length > 0) {
      console.log(`  ${orderId}: Found in invoice_origin`);
      for (const inv of found) {
        console.log(`    Invoice ${inv.id} (${inv.name}) - Origin: ${inv.invoice_origin} - by ${inv.create_uid[1]}`);
      }
      continue;
    }

    // Search by ref containing the order ID
    found = await odoo.searchRead('account.move',
      [
        ['ref', 'ilike', orderId],
        ['move_type', '=', 'out_invoice'],
      ],
      ['id', 'name', 'invoice_origin', 'ref', 'create_uid'],
      0, 5
    );

    if (found.length > 0) {
      console.log(`  ${orderId}: Found in ref`);
      for (const inv of found) {
        console.log(`    Invoice ${inv.id} (${inv.name}) - Ref: ${inv.ref} - by ${inv.create_uid[1]}`);
      }
      continue;
    }

    // Search in sales orders by client_order_ref, then get the invoice
    const salesOrders = await odoo.searchRead('sale.order',
      [['client_order_ref', '=', orderId]],
      ['id', 'name', 'invoice_ids'],
      0, 5
    );

    if (salesOrders.length > 0) {
      console.log(`  ${orderId}: Found via sale.order`);
      for (const so of salesOrders) {
        console.log(`    Sale Order: ${so.name}, Invoice IDs: ${so.invoice_ids}`);
        if (so.invoice_ids && so.invoice_ids.length > 0) {
          // Get the invoices
          const invs = await odoo.searchRead('account.move',
            [['id', 'in', so.invoice_ids]],
            ['id', 'name', 'invoice_origin', 'create_uid', 'move_type']
          );
          for (const inv of invs) {
            console.log(`      -> Invoice ${inv.id} (${inv.name}) Type: ${inv.move_type} - Origin: ${inv.invoice_origin}`);
          }
        }
      }
      continue;
    }

    console.log(`  ${orderId}: NOT FOUND anywhere`);
  }

  // Also check if there are more invoices by Claude AI that we might have missed
  const claudeUser = await odoo.searchRead('res.users', [['name', 'ilike', 'Claude']], ['id']);
  if (claudeUser.length > 0) {
    const allClaudeInvoices = await odoo.searchRead('account.move',
      [['create_uid', '=', claudeUser[0].id], ['move_type', '=', 'out_invoice']],
      ['id', 'name', 'invoice_origin', 'state'],
      0, 0
    );
    console.log(`\n=== All Claude AI invoices: ${allClaudeInvoices.length} ===`);

    // Check how many have FBA/FBM origin
    const withPrefix = allClaudeInvoices.filter(i => i.invoice_origin && (i.invoice_origin.startsWith('FBA') || i.invoice_origin.startsWith('FBM')));
    const withoutPrefix = allClaudeInvoices.filter(i => !i.invoice_origin || (!i.invoice_origin.startsWith('FBA') && !i.invoice_origin.startsWith('FBM')));

    console.log(`  With FBA/FBM prefix: ${withPrefix.length}`);
    console.log(`  Without FBA/FBM prefix: ${withoutPrefix.length}`);

    if (withoutPrefix.length > 0) {
      console.log('\n  Invoices without FBA/FBM prefix:');
      for (const inv of withoutPrefix.slice(0, 20)) {
        console.log(`    ${inv.id} | ${inv.name} | origin: "${inv.invoice_origin}"`);
      }
    }
  }

  process.exit(0);
}

find().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
