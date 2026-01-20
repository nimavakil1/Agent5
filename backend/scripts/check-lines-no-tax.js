/**
 * Check for invoice lines with no taxes in December 2025
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find product lines with no taxes in December
  const linesNoTax = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['display_type', '=', 'product'],
      ['tax_ids', '=', false]
    ],
    ['id', 'move_id', 'name', 'price_subtotal', 'journal_id'],
    { limit: 500 }
  );

  console.log('Product lines with NO taxes in December:', linesNoTax.length);

  // Group by journal
  const byJournal = {};
  for (const line of linesNoTax) {
    const jName = line.journal_id ? line.journal_id[1] : 'Unknown';
    if (!byJournal[jName]) byJournal[jName] = [];
    byJournal[jName].push(line);
  }

  console.log('\nBy journal:');
  for (const [j, lines] of Object.entries(byJournal)) {
    console.log('  ' + j + ': ' + lines.length + ' lines');
  }

  // Group by invoice
  const byInvoice = {};
  for (const line of linesNoTax) {
    const moveId = line.move_id ? line.move_id[0] : 0;
    const moveName = line.move_id ? line.move_id[1] : 'Unknown';
    if (!byInvoice[moveId]) byInvoice[moveId] = { name: moveName, lines: [] };
    byInvoice[moveId].lines.push(line);
  }

  console.log('\nInvoices with lines without taxes:', Object.keys(byInvoice).length);

  // Show invoices
  console.log('\nInvoices:');
  for (const [id, data] of Object.entries(byInvoice).slice(0, 20)) {
    console.log('  ' + data.name + ' - ' + data.lines.length + ' lines without tax');
    for (const line of data.lines.slice(0, 3)) {
      console.log('    - ' + (line.name || '').substring(0, 50) + ' | EUR ' + line.price_subtotal);
    }
  }
}

main().catch(console.error);
