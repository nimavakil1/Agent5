/**
 * Check VIT lines without taxes - what type are they?
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get VIT journal
  const vitJournal = await odoo.searchRead('account.journal', [['code', '=', 'VIT']], ['id'], { limit: 1 });
  const vitJournalId = vitJournal[0].id;

  // Find product lines with no taxes on VIT in December
  const linesNoTax = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', '=', vitJournalId],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['display_type', '=', 'product'],
      ['tax_ids', '=', false]
    ],
    ['id', 'move_id', 'name', 'price_subtotal', 'product_id'],
    { limit: 500 }
  );

  console.log('VIT lines with NO taxes:', linesNoTax.length);

  // Categorize by line type
  const categories = {
    'Promotion Discount': [],
    'Shipping Discount': [],
    'Shipping': [],
    'Product': []
  };

  for (const line of linesNoTax) {
    const name = (line.name || '').toLowerCase();
    if (name.includes('promotion discount') || name.includes('promo discount')) {
      categories['Promotion Discount'].push(line);
    } else if (name.includes('shipping discount') || name.includes('shipment discount')) {
      categories['Shipping Discount'].push(line);
    } else if (name.includes('shipping') || name.includes('ship')) {
      categories['Shipping'].push(line);
    } else {
      categories['Product'].push(line);
    }
  }

  console.log('\nBy type:');
  for (const [type, lines] of Object.entries(categories)) {
    console.log('  ' + type + ': ' + lines.length + ' lines');
    if (lines.length > 0 && lines.length <= 10) {
      for (const line of lines) {
        console.log('    - ' + (line.name || '').substring(0, 60) + ' | EUR ' + line.price_subtotal);
      }
    }
  }

  // Show sample of each type
  console.log('\n--- Sample Product lines without tax ---');
  for (const line of categories['Product'].slice(0, 10)) {
    const moveName = line.move_id ? line.move_id[1] : 'Unknown';
    console.log('  ' + moveName + ' | ' + (line.name || '').substring(0, 50) + ' | EUR ' + line.price_subtotal);
  }
}

main().catch(console.error);
