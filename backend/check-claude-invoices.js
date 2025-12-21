/**
 * Check all invoices created by Claude AI user
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function checkInvoices() {
  const odoo = new OdooDirectClient({
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  });

  await odoo.authenticate();
  console.log('Connected to Odoo');

  // First, find the Claude AI user
  const users = await odoo.searchRead('res.users',
    [['name', 'ilike', 'Claude']],
    ['id', 'name', 'login']
  );
  console.log('\nUsers matching Claude:', JSON.stringify(users, null, 2));

  if (users.length === 0) {
    console.log('No Claude user found');
    return;
  }

  const claudeUserId = users[0].id;
  console.log('\nClaude AI user ID:', claudeUserId);

  // Find all invoices created by Claude AI
  const invoices = await odoo.searchRead('account.move',
    [
      ['create_uid', '=', claudeUserId],
      ['move_type', '=', 'out_invoice']
    ],
    ['id', 'name', 'state', 'invoice_origin', 'amount_total', 'create_date', 'ref'],
    0, 0, 'create_date desc'
  );

  console.log('\nTotal invoices created by Claude AI:', invoices.length);

  // Group by invoice_origin to find duplicates
  const byOrigin = {};
  for (const inv of invoices) {
    const origin = inv.invoice_origin || 'NO_ORIGIN';
    if (!byOrigin[origin]) {
      byOrigin[origin] = [];
    }
    byOrigin[origin].push(inv);
  }

  // Show duplicates (same origin, multiple invoices)
  console.log('\n=== Invoices by Origin (showing duplicates) ===');
  let duplicateCount = 0;
  for (const [origin, invs] of Object.entries(byOrigin)) {
    if (invs.length > 1) {
      duplicateCount += invs.length - 1;
      console.log('\nDUPLICATE:', origin, '- Count:', invs.length);
      for (const inv of invs) {
        console.log('  ', inv.id, inv.name, inv.state, inv.amount_total, inv.ref);
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log('Total invoices:', invoices.length);
  console.log('Unique origins:', Object.keys(byOrigin).length);
  console.log('Duplicate invoices:', duplicateCount);

  // List all invoices
  console.log('\n=== All Invoices Created by Claude AI ===');
  for (const inv of invoices) {
    console.log(inv.id, '|', inv.name, '|', inv.state, '|', inv.invoice_origin, '|', inv.amount_total);
  }
}

checkInvoices().catch(console.error);
