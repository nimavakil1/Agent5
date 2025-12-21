/**
 * Debug - show invoice_origin format
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function debug() {
  const odoo = new OdooDirectClient({
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  });
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Get invoices by Claude AI
  const users = await odoo.searchRead('res.users',
    [['name', 'ilike', 'Claude']],
    ['id', 'name']
  );
  const claudeUserId = users[0].id;

  const invoices = await odoo.searchRead('account.move',
    [
      ['create_uid', '=', claudeUserId],
      ['move_type', '=', 'out_invoice']
    ],
    ['id', 'name', 'invoice_origin', 'ref'],
    0, 20
  );

  console.log('\n=== Sample Invoices by Claude AI ===');
  for (const inv of invoices) {
    console.log(`ID: ${inv.id}`);
    console.log(`  Name: ${inv.name}`);
    console.log(`  invoice_origin: ${inv.invoice_origin}`);
    console.log(`  ref: ${inv.ref}`);
    console.log('');
  }

  // Also get ALL invoices created in December 2025 by any user
  const allInvoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['create_date', '>=', '2025-12-01'],
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'create_uid'],
    0, 200
  );

  console.log(`\n=== All December 2025 Invoices (${allInvoices.length}) ===`);
  for (const inv of allInvoices.slice(0, 30)) {
    console.log(`${inv.id} | ${inv.name} | origin: ${inv.invoice_origin} | ref: ${inv.ref} | by: ${inv.create_uid[1]}`);
  }
}

debug().catch(console.error);
