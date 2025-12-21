/**
 * Count ALL invoices with Amazon order origins, by any user
 */
require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function count() {
  const odoo = new OdooDirectClient({
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
  });
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Count invoices with FBA/FBM origin
  const fbaCount = await odoo.execute('account.move', 'search_count', [
    [['invoice_origin', '=like', 'FBA%'], ['move_type', '=', 'out_invoice']]
  ]);
  const fbmCount = await odoo.execute('account.move', 'search_count', [
    [['invoice_origin', '=like', 'FBM%'], ['move_type', '=', 'out_invoice']]
  ]);

  console.log(`\nInvoices with FBA origin: ${fbaCount}`);
  console.log(`Invoices with FBM origin: ${fbmCount}`);
  console.log(`Total Amazon invoices: ${fbaCount + fbmCount}`);

  // Get all invoices with FBA/FBM origin, grouped by create_uid
  const invoices = await odoo.searchRead('account.move',
    [
      '|',
      ['invoice_origin', '=like', 'FBA%'],
      ['invoice_origin', '=like', 'FBM%'],
    ],
    ['id', 'invoice_origin', 'create_uid'],
    0, 0
  );

  // Group by user
  const byUser = {};
  for (const inv of invoices) {
    const userName = inv.create_uid ? inv.create_uid[1] : 'Unknown';
    if (!byUser[userName]) {
      byUser[userName] = 0;
    }
    byUser[userName]++;
  }

  console.log('\n=== Invoices by User ===');
  for (const [user, count] of Object.entries(byUser)) {
    console.log(`  ${user}: ${count}`);
  }

  // Also count December 2025 invoices in general
  const dec2025Count = await odoo.execute('account.move', 'search_count', [
    [['create_date', '>=', '2025-12-01'], ['move_type', '=', 'out_invoice']]
  ]);
  console.log(`\nTotal customer invoices created in December 2025: ${dec2025Count}`);
}

count().catch(console.error);
