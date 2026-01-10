require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Count Amazon orders "to invoice"
  const count = await odoo.searchCount('sale.order', [
    ['invoice_status', '=', 'to invoice'],
    '|',
    ['name', 'like', 'FBA%'],
    ['name', 'like', 'FBM%']
  ]);

  console.log('Amazon orders "to invoice": ' + count);

  // Breakdown by having invoice or not
  const withInvoice = await odoo.searchCount('sale.order', [
    ['invoice_status', '=', 'to invoice'],
    ['invoice_ids', '!=', false],
    '|',
    ['name', 'like', 'FBA%'],
    ['name', 'like', 'FBM%']
  ]);

  const withoutInvoice = await odoo.searchCount('sale.order', [
    ['invoice_status', '=', 'to invoice'],
    ['invoice_ids', '=', false],
    '|',
    ['name', 'like', 'FBA%'],
    ['name', 'like', 'FBM%']
  ]);

  console.log('  - With invoice linked: ' + withInvoice);
  console.log('  - Without invoice: ' + withoutInvoice);
}

main().catch(e => console.error(e));
