/**
 * Find what's causing "None (140)" in the VAT report
 * Check all possible causes
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get all sale journals
  const saleJournals = await odoo.searchRead('account.journal',
    [['type', '=', 'sale']],
    ['id', 'code'],
    { limit: 50 }
  );
  const saleJournalIds = saleJournals.map(j => j.id);
  const journalMap = {};
  for (const j of saleJournals) journalMap[j.id] = j.code;

  console.log('=== Checking for "None" entries in VAT report ===\n');

  // The None (140) with EUR 51.38 tax and EUR 2,203.07 base
  // This suggests 140 "entries" (could be lines or invoices)

  // Check 1: Tax lines without tax tags (these show as "None" for tax)
  console.log('1. Tax lines WITHOUT tax tags:');
  const taxLinesNoTags = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', 'in', saleJournalIds],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['tax_line_id', '!=', false],
      ['tax_tag_ids', '=', false]
    ],
    ['id', 'move_id', 'tax_line_id', 'balance', 'journal_id'],
    { limit: 500 }
  );

  let taxTotal = 0;
  for (const l of taxLinesNoTags) taxTotal += Math.abs(l.balance || 0);
  console.log('   Count:', taxLinesNoTags.length, '| Tax: EUR', taxTotal.toFixed(2));

  // Check 2: Product lines with taxes that have no tags
  console.log('\n2. Product lines with taxes that have NO tags on tax lines:');

  // Get all product lines with taxes
  const productLines = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', 'in', saleJournalIds],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['display_type', '=', 'product'],
      ['tax_ids', '!=', false]
    ],
    ['id', 'move_id', 'name', 'price_subtotal', 'tax_ids', 'journal_id'],
    { limit: 20000 }
  );

  console.log('   Total product lines with taxes:', productLines.length);

  // Check 3: Lines on invoices that are linked to the problematic tax lines
  const problemMoveIds = taxLinesNoTags.map(l => l.move_id[0]);
  const problemLines = productLines.filter(l => problemMoveIds.includes(l.move_id[0]));
  let baseTotal = 0;
  for (const l of problemLines) baseTotal += Math.abs(l.price_subtotal || 0);
  console.log('   Product lines on invoices with problematic tax:', problemLines.length, '| Base: EUR', baseTotal.toFixed(2));

  // Check 4: Look at specific journals that might have issues
  console.log('\n3. Checking less common journals (VCZ, VPL, etc):');

  for (const code of ['VCZ', 'VPL', 'VHU', 'VSE', 'VDK', 'VAT']) {
    const journal = saleJournals.find(j => j.code === code);
    if (!journal) continue;

    const invoices = await odoo.searchRead('account.move',
      [
        ['journal_id', '=', journal.id],
        ['state', '=', 'posted'],
        ['move_type', 'in', ['out_invoice', 'out_refund']],
        ['invoice_date', '>=', '2025-12-01'],
        ['invoice_date', '<=', '2025-12-31']
      ],
      ['id', 'name', 'amount_total', 'amount_tax'],
      { limit: 100 }
    );

    if (invoices.length > 0) {
      const totalTax = invoices.reduce((sum, i) => sum + (i.amount_tax || 0), 0);
      console.log('   ' + code + ':', invoices.length, 'invoices, EUR', totalTax.toFixed(2), 'tax');
    }
  }

  // Check 5: Specific invoices with problematic taxes
  console.log('\n4. Invoices with tax lines missing tags:');
  if (taxLinesNoTags.length > 0) {
    const moveIds = [...new Set(taxLinesNoTags.map(l => l.move_id[0]))];
    const moves = await odoo.searchRead('account.move',
      [['id', 'in', moveIds]],
      ['id', 'name', 'journal_id', 'amount_total', 'amount_tax', 'payment_state'],
      { limit: 100 }
    );

    for (const m of moves) {
      const jCode = journalMap[m.journal_id[0]] || 'Unknown';
      console.log('   ' + m.name + ' | ' + jCode + ' | ' + m.payment_state + ' | EUR ' + m.amount_total + ' (tax: ' + m.amount_tax + ')');
    }
  }
}

main().catch(console.error);
