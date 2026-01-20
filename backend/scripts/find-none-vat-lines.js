/**
 * Find what's causing "None" in the VAT report
 * Looking for tax lines without proper VAT registration/country assignment
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // The VAT report groups by tax_tag_ids which link to VAT registration
  // "None" usually means the tax line has no proper tags

  // Get all sale journals
  const saleJournals = await odoo.searchRead('account.journal',
    [['type', '=', 'sale']],
    ['id', 'code'],
    { limit: 50 }
  );
  const saleJournalIds = saleJournals.map(j => j.id);

  // Find ALL tax report lines in December to see which ones might be "None"
  const taxLines = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', 'in', saleJournalIds],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['display_type', '=', 'tax']  // Tax lines have display_type = 'tax'
    ],
    ['id', 'move_id', 'name', 'tax_line_id', 'balance', 'credit', 'debit', 'tax_tag_ids', 'journal_id'],
    { limit: 10000 }
  );

  console.log('Total tax display lines in December:', taxLines.length);

  // Also try with tax_line_id
  const taxLines2 = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', 'in', saleJournalIds],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['tax_line_id', '!=', false]
    ],
    ['id', 'move_id', 'name', 'tax_line_id', 'balance', 'credit', 'debit', 'tax_tag_ids', 'journal_id'],
    { limit: 10000 }
  );

  console.log('Total tax_line_id lines in December:', taxLines2.length);

  // Find lines with empty or no tax_tag_ids
  const noTags = taxLines2.filter(l => !l.tax_tag_ids || l.tax_tag_ids.length === 0);
  console.log('Tax lines with NO tax tags:', noTags.length);

  // Sum up the balance
  let totalBalance = 0;
  for (const line of noTags) {
    totalBalance += Math.abs(line.balance || 0);
  }
  console.log('Total tax amount (no tags): EUR', totalBalance.toFixed(2));

  if (noTags.length > 0) {
    console.log('\nLines without tax tags:');
    for (const line of noTags.slice(0, 20)) {
      const moveName = line.move_id ? line.move_id[1] : 'Unknown';
      const taxName = line.tax_line_id ? line.tax_line_id[1] : 'Unknown';
      const journalCode = saleJournals.find(j => j.id === line.journal_id[0])?.code || 'Unknown';
      console.log('  ' + moveName + ' | ' + journalCode + ' | ' + taxName + ' | EUR ' + Math.abs(line.balance || 0).toFixed(2));
    }
  }

  // Check product lines without taxes (these might show as "None" for base amount)
  console.log('\n\n--- Checking product lines without taxes ---');
  const productLinesNoTax = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', 'in', saleJournalIds],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['display_type', '=', 'product'],
      ['tax_ids', '=', false]
    ],
    ['id', 'move_id', 'name', 'price_subtotal', 'journal_id'],
    { limit: 500 }
  );

  console.log('Product lines with NO taxes in December:', productLinesNoTax.length);

  // Sum up
  let totalBase = 0;
  for (const line of productLinesNoTax) {
    totalBase += Math.abs(line.price_subtotal || 0);
  }
  console.log('Total base amount (no taxes): EUR', totalBase.toFixed(2));

  // Group by journal
  const byJournal = {};
  for (const line of productLinesNoTax) {
    const jId = line.journal_id ? line.journal_id[0] : 0;
    const jCode = saleJournals.find(j => j.id === jId)?.code || 'Unknown';
    if (!byJournal[jCode]) byJournal[jCode] = { count: 0, total: 0 };
    byJournal[jCode].count++;
    byJournal[jCode].total += Math.abs(line.price_subtotal || 0);
  }

  console.log('\nBy journal:');
  for (const [j, data] of Object.entries(byJournal)) {
    console.log('  ' + j + ': ' + data.count + ' lines, EUR ' + data.total.toFixed(2));
  }
}

main().catch(console.error);
