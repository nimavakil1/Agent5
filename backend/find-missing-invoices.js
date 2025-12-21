/**
 * Find which VCS orders don't have invoices in Odoo
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const { connectDb, getDb } = require('./src/db');

async function find() {
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
  const claudeUserId = users[0].id;

  // Get ALL account.move records by Claude to see what types we have
  const allMoves = await odoo.searchRead('account.move',
    [['create_uid', '=', claudeUserId]],
    ['id', 'name', 'move_type', 'state', 'invoice_origin', 'ref'],
    0, 0
  );

  console.log(`\n=== All ${allMoves.length} account.move records by Claude AI ===`);
  const byType = {};
  for (const m of allMoves) {
    if (!byType[m.move_type]) byType[m.move_type] = [];
    byType[m.move_type].push(m);
  }
  for (const [type, moves] of Object.entries(byType)) {
    console.log(`  ${type}: ${moves.length}`);
  }

  // Check if the non-invoice records are reversal entries
  const nonInvoices = allMoves.filter(m => m.move_type !== 'out_invoice');
  if (nonInvoices.length > 0) {
    console.log(`\n=== Non-invoice records (first 20) ===`);
    for (const m of nonInvoices.slice(0, 20)) {
      console.log(`  ID: ${m.id}, Type: ${m.move_type}, Name: ${m.name}, Origin: ${m.invoice_origin}, Ref: ${m.ref}, State: ${m.state}`);
    }
  }

  // Get all out_invoices and their order IDs
  const outInvoices = allMoves.filter(m => m.move_type === 'out_invoice');
  const invoicedOrderIds = new Set();
  for (const inv of outInvoices) {
    if (inv.invoice_origin) {
      const match = inv.invoice_origin.match(/(?:FBA|FBM)?(\d{3}-\d{7}-\d{7})/);
      if (match) {
        invoicedOrderIds.add(match[1]);
      }
    }
    if (inv.ref) {
      const match = inv.ref.match(/(\d{3}-\d{7}-\d{7})/);
      if (match) {
        invoicedOrderIds.add(match[1]);
      }
    }
  }
  console.log(`\n=== Order IDs that have invoices in Odoo: ${invoicedOrderIds.size} ===`);

  // Get all VCS orders from MongoDB
  const orders = await db.collection('amazon_vcs_orders').find().toArray();
  console.log(`\n=== Total VCS orders in MongoDB: ${orders.length} ===`);

  // Find orders WITHOUT invoices in Odoo
  const missingInvoices = [];
  for (const order of orders) {
    if (!invoicedOrderIds.has(order.orderId)) {
      missingInvoices.push(order);
    }
  }

  console.log(`\n=== Orders WITHOUT invoices in Odoo: ${missingInvoices.length} ===`);

  // Group missing by status
  const missingByStatus = {};
  for (const order of missingInvoices) {
    const status = order.status || 'unknown';
    if (!missingByStatus[status]) missingByStatus[status] = [];
    missingByStatus[status].push(order);
  }

  for (const [status, orders] of Object.entries(missingByStatus)) {
    console.log(`\n  ${status}: ${orders.length}`);
    if (orders.length <= 30) {
      for (const o of orders) {
        console.log(`    ${o.orderId} - ${o.skipReason || ''}`);
      }
    }
  }

  // Current MongoDB status distribution
  console.log(`\n=== Current MongoDB Status ===`);
  const statusCounts = {};
  for (const order of orders) {
    const status = order.status || 'unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`  ${status}: ${count}`);
  }

  console.log('\n=== Summary ===');
  console.log(`Total VCS orders: ${orders.length}`);
  console.log(`Orders with invoices in Odoo: ${invoicedOrderIds.size}`);
  console.log(`Orders missing invoices: ${missingInvoices.length}`);

  process.exit(0);
}

find().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
