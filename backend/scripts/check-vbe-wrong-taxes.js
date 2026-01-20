/**
 * Check VBE for remaining wrong taxes
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get VBE journal
  const vbeJournal = await odoo.searchRead('account.journal', [['code', '=', 'VBE']], ['id'], { limit: 1 });
  const vbeJournalId = vbeJournal[0].id;

  // Search account.move.line directly for tax lines on posted VBE December
  const taxReportLines = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', '=', vbeJournalId],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['tax_line_id', '!=', false]
    ],
    ['id', 'move_id', 'name', 'tax_line_id', 'balance', 'credit', 'debit'],
    { limit: 2000 }
  );

  console.log('Tax lines on posted VBE entries December:', taxReportLines.length);

  // Group by tax
  const byTax = {};
  for (const line of taxReportLines) {
    const taxName = line.tax_line_id ? line.tax_line_id[1] : 'Unknown';
    if (!taxName.startsWith('BE*')) {
      if (!byTax[taxName]) byTax[taxName] = { count: 0, balance: 0 };
      byTax[taxName].count++;
      byTax[taxName].balance += Math.abs(line.balance || 0);
    }
  }

  console.log('\nNon-BE tax lines on POSTED VBE December:');
  for (const [tax, data] of Object.entries(byTax)) {
    console.log('  ' + tax + ': ' + data.count + ' lines, EUR ' + data.balance.toFixed(2));
  }

  // Show the specific moves
  const wrongMoveIds = [];
  for (const line of taxReportLines) {
    const taxName = line.tax_line_id ? line.tax_line_id[1] : '';
    if (taxName && !taxName.startsWith('BE*')) {
      const moveId = Array.isArray(line.move_id) ? line.move_id[0] : line.move_id;
      if (!wrongMoveIds.includes(moveId)) wrongMoveIds.push(moveId);
    }
  }

  if (wrongMoveIds.length > 0) {
    const moves = await odoo.searchRead('account.move',
      [['id', 'in', wrongMoveIds]],
      ['id', 'name', 'state', 'payment_state', 'partner_id', 'amount_total'],
      { limit: 50 }
    );
    console.log('\nInvoices with wrong tax lines:');
    for (const m of moves) {
      console.log('  ' + m.name + ' - ' + m.state + '/' + m.payment_state + ' - ' + (m.partner_id ? m.partner_id[1] : 'Unknown'));
      console.log('    URL: https://acropaq.odoo.com/web#id=' + m.id + '&model=account.move&view_type=form');
    }
  } else {
    console.log('\nNo posted invoices with wrong tax lines found.');
  }
}

main().catch(console.error);
