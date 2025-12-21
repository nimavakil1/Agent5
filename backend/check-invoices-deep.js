/**
 * Deep investigation of Claude AI invoices discrepancy
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function check() {
  const odoo = new OdooDirectClient({
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  });
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Check ALL users with Claude in name
  const users = await odoo.searchRead('res.users',
    [['name', 'ilike', 'Claude']],
    ['id', 'name', 'login', 'active']
  );
  console.log('\n=== Users with "Claude" in name ===');
  for (const u of users) {
    console.log(`  ID: ${u.id}, Name: ${u.name}, Login: ${u.login}, Active: ${u.active}`);
  }

  // Count ALL invoices by each Claude user
  for (const u of users) {
    const count = await odoo.execute('account.move', 'search_count', [
      [['create_uid', '=', u.id], ['move_type', '=', 'out_invoice']]
    ]);
    console.log(`  Invoices by user ${u.id}: ${count}`);
  }

  // Check invoice_date in 2025 (not create_date)
  console.log('\n=== Invoices with invoice_date in 2025 (by any user) ===');
  const inv2025Count = await odoo.execute('account.move', 'search_count', [
    [['invoice_date', '>=', '2025-01-01'], ['invoice_date', '<', '2026-01-01'], ['move_type', '=', 'out_invoice']]
  ]);
  console.log(`  Total customer invoices with invoice_date in 2025: ${inv2025Count}`);

  // Check invoices by Claude with invoice_date in 2025
  const claudeUserId = users[0].id;
  const claudeInv2025 = await odoo.searchRead('account.move',
    [['create_uid', '=', claudeUserId], ['invoice_date', '>=', '2025-01-01'], ['move_type', '=', 'out_invoice']],
    ['id', 'name', 'invoice_date', 'create_date', 'state'],
    0, 0
  );
  console.log(`  Claude AI invoices with invoice_date in 2025: ${claudeInv2025.length}`);

  // Check if there are Claude invoices with invoice_date set vs not set
  const claudeWithInvDate = await odoo.execute('account.move', 'search_count', [
    [['create_uid', '=', claudeUserId], ['invoice_date', '!=', false], ['move_type', '=', 'out_invoice']]
  ]);
  const claudeWithoutInvDate = await odoo.execute('account.move', 'search_count', [
    [['create_uid', '=', claudeUserId], ['invoice_date', '=', false], ['move_type', '=', 'out_invoice']]
  ]);
  console.log(`\n=== Invoice date status ===`);
  console.log(`  Claude invoices WITH invoice_date: ${claudeWithInvDate}`);
  console.log(`  Claude invoices WITHOUT invoice_date: ${claudeWithoutInvDate}`);

  // Check total December 2025 invoices by ALL users
  console.log('\n=== December 2025 invoices by user ===');
  const dec2025Invoices = await odoo.searchRead('account.move',
    [['create_date', '>=', '2025-12-01'], ['move_type', '=', 'out_invoice']],
    ['id', 'create_uid'],
    0, 0
  );
  const byUser = {};
  for (const inv of dec2025Invoices) {
    const user = inv.create_uid ? inv.create_uid[1] : 'Unknown';
    byUser[user] = (byUser[user] || 0) + 1;
  }
  for (const [user, count] of Object.entries(byUser).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${user}: ${count}`);
  }

  // Get the full list of all Amazon-origin invoices
  console.log('\n=== All invoices with FBA/FBM origin ===');
  const amazonInvoices = await odoo.searchRead('account.move',
    [
      '|',
      ['invoice_origin', '=like', 'FBA%'],
      ['invoice_origin', '=like', 'FBM%'],
    ],
    ['id', 'name', 'invoice_origin', 'create_uid', 'state'],
    0, 0
  );
  console.log(`  Total Amazon invoices (FBA/FBM): ${amazonInvoices.length}`);

  const amazonByUser = {};
  for (const inv of amazonInvoices) {
    const user = inv.create_uid ? inv.create_uid[1] : 'Unknown';
    amazonByUser[user] = (amazonByUser[user] || 0) + 1;
  }
  for (const [user, count] of Object.entries(amazonByUser).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${user}: ${count}`);
  }

  // Check for any deleted/cancelled invoices
  console.log('\n=== Invoice states ===');
  const allClaude = await odoo.searchRead('account.move',
    [['create_uid', '=', claudeUserId]],
    ['id', 'state', 'move_type'],
    0, 0
  );
  const stateByType = {};
  for (const inv of allClaude) {
    const key = `${inv.move_type}:${inv.state}`;
    stateByType[key] = (stateByType[key] || 0) + 1;
  }
  for (const [key, count] of Object.entries(stateByType)) {
    console.log(`  ${key}: ${count}`);
  }
}

check().catch(console.error);
