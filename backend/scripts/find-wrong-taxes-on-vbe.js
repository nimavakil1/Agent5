/**
 * Find invoices on VBE with non-Belgian taxes
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Finding wrong taxes on VBE ===\n');

  // Get VBE journal
  const vbeJournal = await odoo.searchRead('account.journal', [['code', '=', 'VBE']], ['id'], { limit: 1 });
  const vbeJournalId = vbeJournal[0].id;

  // Find tax lines on VBE that are NOT BE* taxes
  const taxLines = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', '=', vbeJournalId],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['tax_line_id', '!=', false]
    ],
    ['id', 'move_id', 'tax_line_id', 'balance'],
    { limit: 5000 }
  );

  console.log('Total tax lines on VBE December:', taxLines.length);

  // Filter for non-BE taxes
  const wrongTaxLines = taxLines.filter(l => {
    const taxName = l.tax_line_id ? l.tax_line_id[1] : '';
    return !taxName.startsWith('BE*');
  });

  console.log('Non-BE tax lines on VBE:', wrongTaxLines.length);

  // Group by tax
  const byTax = {};
  for (const l of wrongTaxLines) {
    const taxName = l.tax_line_id ? l.tax_line_id[1] : 'Unknown';
    if (!byTax[taxName]) byTax[taxName] = { lines: [], total: 0 };
    byTax[taxName].lines.push(l);
    byTax[taxName].total += Math.abs(l.balance || 0);
  }

  console.log('\nBy tax:');
  for (const [tax, data] of Object.entries(byTax)) {
    console.log('  ' + tax + ': ' + data.lines.length + ' lines, EUR ' + data.total.toFixed(2));
  }

  // Get unique invoices
  const moveIds = [...new Set(wrongTaxLines.map(l => l.move_id[0]))];
  const invoices = await odoo.searchRead('account.move',
    [['id', 'in', moveIds]],
    ['id', 'name', 'partner_id', 'amount_total', 'payment_state'],
    { limit: 100 }
  );

  console.log('\nInvoices with wrong taxes on VBE:');
  const notPaid = [];
  const paid = [];

  for (const inv of invoices) {
    const status = inv.payment_state === 'not_paid' ? 'NOT PAID' : 'PAID';
    console.log('  ' + inv.name + ' - ' + status + ' - EUR ' + inv.amount_total + ' - ' + (inv.partner_id ? inv.partner_id[1] : 'Unknown'));

    if (inv.payment_state === 'not_paid') {
      notPaid.push(inv);
    } else {
      paid.push(inv);
    }
  }

  console.log('\nSummary:');
  console.log('  Not paid (can fix):', notPaid.length);
  console.log('  Paid (manual fix needed):', paid.length);
}

main().catch(console.error);
