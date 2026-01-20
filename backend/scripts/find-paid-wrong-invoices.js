/**
 * Find invoices with wrong taxes that have payments (need manual fix)
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get all taxes by country
  const allTaxes = await odoo.searchRead('account.tax',
    [['type_tax_use', '=', 'sale']],
    ['id', 'name'],
    { limit: 500 }
  );

  const taxNames = {};
  const taxesByCountry = {};
  for (const t of allTaxes) {
    taxNames[t.id] = t.name;
    const match = t.name.match(/^([A-Z]{2})\*/);
    if (match) {
      const country = match[1];
      if (!taxesByCountry[country]) taxesByCountry[country] = [];
      taxesByCountry[country].push(t.id);
    }
  }

  const journalExpected = {
    'VBE': 'BE',
    'VDE': 'DE',
    'VIT': 'IT',
    'VFR': 'FR',
    'VNL': 'NL',
    'VCZ': 'CZ',
    'VPL': 'PL',
    'VGB': 'GB'
  };

  console.log('Invoices with wrong taxes that are PAID (need manual fix):');
  console.log('='.repeat(100));

  let count = 0;

  for (const [journalCode, expectedCountry] of Object.entries(journalExpected)) {
    // Get journal ID
    const journals = await odoo.searchRead('account.journal',
      [['code', '=', journalCode]],
      ['id'],
      { limit: 1 }
    );
    if (journals.length === 0) continue;

    // Get paid invoices since Dec 1
    const invoices = await odoo.searchRead('account.move',
      [
        ['journal_id', '=', journals[0].id],
        ['move_type', '=', 'out_invoice'],
        ['state', '=', 'posted'],
        ['payment_state', '!=', 'not_paid'],
        ['invoice_date', '>=', '2025-12-01']
      ],
      ['id', 'name', 'payment_state', 'amount_total'],
      { limit: 500 }
    );

    for (const inv of invoices) {
      const lines = await odoo.searchRead('account.move.line',
        [['move_id', '=', inv.id], ['display_type', '=', 'product']],
        ['id', 'tax_ids'],
        { limit: 50 }
      );

      // Check for wrong taxes
      let hasWrongTax = false;
      let wrongTaxes = [];

      for (const line of lines) {
        if (!line.tax_ids) continue;
        for (const taxId of line.tax_ids) {
          const taxName = taxNames[taxId] || '';
          const taxMatch = taxName.match(/^([A-Z]{2})\*/);
          if (taxMatch && taxMatch[1] !== expectedCountry) {
            hasWrongTax = true;
            wrongTaxes.push(taxName);
          }
        }
      }

      if (hasWrongTax) {
        count++;
        console.log('\n' + count + '. ' + inv.name);
        console.log('   Journal: ' + journalCode + ' (expected ' + expectedCountry + '* taxes)');
        console.log('   Payment Status: ' + inv.payment_state);
        console.log('   Amount: €' + inv.amount_total.toFixed(2));
        console.log('   Wrong taxes: ' + [...new Set(wrongTaxes)].join(', '));
        console.log('   URL: https://acropaq.odoo.com/web#id=' + inv.id + '&model=account.move&view_type=form');
      }
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('Total invoices needing manual fix:', count);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
