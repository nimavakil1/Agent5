/**
 * Find invoice lines with no VAT registration (fiscal position) in December 2025
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find tax lines in December with no tax_tag_ids or specific characteristics
  // The "None" in VAT report usually means lines without proper tax grids/tags

  // First, let's check invoices without fiscal position
  const invoicesNoFP = await odoo.searchRead('account.move',
    [
      ['state', '=', 'posted'],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['invoice_date', '>=', '2025-12-01'],
      ['invoice_date', '<=', '2025-12-31'],
      ['fiscal_position_id', '=', false]
    ],
    ['id', 'name', 'journal_id', 'partner_id', 'amount_total', 'amount_tax', 'payment_state'],
    { limit: 200 }
  );

  console.log('Invoices WITHOUT fiscal position in December:', invoicesNoFP.length);

  // Group by journal
  const byJournal = {};
  for (const inv of invoicesNoFP) {
    const jName = inv.journal_id ? inv.journal_id[1] : 'Unknown';
    if (!byJournal[jName]) byJournal[jName] = [];
    byJournal[jName].push(inv);
  }

  console.log('\nBy journal:');
  for (const [j, invs] of Object.entries(byJournal)) {
    const totalTax = invs.reduce((sum, i) => sum + (i.amount_tax || 0), 0);
    console.log('  ' + j + ': ' + invs.length + ' invoices, EUR ' + totalTax.toFixed(2) + ' tax');
  }

  // Show some examples
  console.log('\nSample invoices without fiscal position:');
  for (const inv of invoicesNoFP.slice(0, 20)) {
    console.log('  ' + inv.name + ' - ' + inv.payment_state + ' - EUR ' + inv.amount_total + ' (tax: ' + inv.amount_tax + ') - ' + (inv.partner_id ? inv.partner_id[1] : 'Unknown'));
  }

  // Also check for tax lines where tax has no country/registration
  console.log('\n\n--- Checking tax report lines ---');

  // Get all sale journals
  const saleJournals = await odoo.searchRead('account.journal',
    [['type', '=', 'sale']],
    ['id', 'code'],
    { limit: 50 }
  );
  const saleJournalIds = saleJournals.map(j => j.id);

  // Find tax lines in December
  const taxLines = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', 'in', saleJournalIds],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['tax_line_id', '!=', false]
    ],
    ['id', 'move_id', 'tax_line_id', 'balance', 'credit', 'debit', 'tax_tag_ids'],
    { limit: 5000 }
  );

  console.log('Total tax lines in December sale journals:', taxLines.length);

  // Check for lines with empty tax_tag_ids
  const noTags = taxLines.filter(l => !l.tax_tag_ids || l.tax_tag_ids.length === 0);
  console.log('Tax lines with NO tax tags:', noTags.length);

  if (noTags.length > 0) {
    // Get unique invoices
    const moveIds = [...new Set(noTags.map(l => l.move_id[0]))];
    const moves = await odoo.searchRead('account.move',
      [['id', 'in', moveIds]],
      ['id', 'name', 'journal_id', 'payment_state'],
      { limit: 200 }
    );

    console.log('\nInvoices with tax lines missing tags:');
    for (const m of moves.slice(0, 20)) {
      console.log('  ' + m.name + ' - ' + (m.journal_id ? m.journal_id[1] : 'Unknown') + ' - ' + m.payment_state);
    }
  }
}

main().catch(console.error);
