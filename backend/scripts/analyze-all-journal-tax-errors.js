/**
 * Analyze all journals for wrong taxes in December 2025
 * Report only - no changes made
 *
 * Rules:
 * - VBE should have BE* taxes only
 * - VDE should have DE* taxes only
 * - VFR should have FR* taxes only
 * - VNL should have NL* taxes only
 * - VIT should have IT* taxes only
 * - VGB should have GB* taxes only
 * - VOS should have *OSS taxes only
 * - VEX lines with BE*VAT should go to VBE, DE*VAT to VDE, etc.
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Journal to expected tax prefix mapping
const JOURNAL_TAX_RULES = {
  'VBE': { expected: ['BE*'], name: 'Belgium' },
  'VDE': { expected: ['DE*'], name: 'Germany' },
  'VFR': { expected: ['FR*'], name: 'France' },
  'VNL': { expected: ['NL*'], name: 'Netherlands' },
  'VIT': { expected: ['IT*'], name: 'Italy' },
  'VGB': { expected: ['GB*'], name: 'UK' },
  'VCZ': { expected: ['CZ*'], name: 'Czech Republic' },
  'VPL': { expected: ['PL*'], name: 'Poland' },
  'VOS': { expected: ['*OSS'], name: 'OSS' },
  'VEX': { expected: ['EX*', '0%'], name: 'Export (0%)' }
};

// Tax prefix to target journal mapping (for VEX split)
const TAX_TO_JOURNAL = {
  'BE': 'VBE',
  'DE': 'VDE',
  'FR': 'VFR',
  'NL': 'VNL',
  'IT': 'VIT',
  'GB': 'VGB',
  'CZ': 'VCZ',
  'PL': 'VPL'
};

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('='.repeat(100));
  console.log('Analysis: Wrong Taxes on All Journals (December 2025)');
  console.log('='.repeat(100));

  // Get all sales journals
  const journals = await odoo.searchRead('account.journal',
    [['type', '=', 'sale']],
    ['id', 'code', 'name'],
    { limit: 50 }
  );

  const journalMap = {};
  for (const j of journals) {
    journalMap[j.code] = { id: j.id, name: j.name };
  }

  console.log('Sales Journals found:', Object.keys(journalMap).join(', '));

  // Get all taxes
  const allTaxes = await odoo.searchRead('account.tax',
    [['type_tax_use', '=', 'sale']],
    ['id', 'name'],
    { limit: 500 }
  );

  const taxNames = {};
  for (const t of allTaxes) {
    taxNames[t.id] = t.name;
  }

  const allErrors = {};

  // Check each journal
  for (const [journalCode, rules] of Object.entries(JOURNAL_TAX_RULES)) {
    if (!journalMap[journalCode]) {
      console.log('\nSkipping ' + journalCode + ' - not found');
      continue;
    }

    const journalId = journalMap[journalCode].id;
    console.log('\n' + '='.repeat(80));
    console.log('Checking ' + journalCode + ' (' + rules.name + ')');
    console.log('Expected taxes: ' + rules.expected.join(', '));
    console.log('='.repeat(80));

    // Get December invoices and credit notes
    const invoices = await odoo.searchRead('account.move',
      [
        ['journal_id', '=', journalId],
        ['move_type', 'in', ['out_invoice', 'out_refund']],
        ['state', '=', 'posted'],
        ['invoice_date', '>=', '2025-12-01'],
        ['invoice_date', '<=', '2025-12-31']
      ],
      ['id', 'name', 'move_type', 'invoice_date', 'partner_id', 'amount_total', 'payment_state'],
      { limit: 5000 }
    );

    console.log('Found ' + invoices.length + ' posted documents');

    const errors = [];
    let checked = 0;

    for (const inv of invoices) {
      checked++;
      if (checked % 500 === 0) {
        console.log('  Checked ' + checked + ' / ' + invoices.length + '...');
      }

      // Get invoice lines
      const lines = await odoo.searchRead('account.move.line',
        [['move_id', '=', inv.id], ['display_type', '=', 'product']],
        ['id', 'name', 'tax_ids', 'price_subtotal'],
        { limit: 100 }
      );

      // Check each line's taxes
      const wrongLines = [];
      for (const line of lines) {
        if (!line.tax_ids || line.tax_ids.length === 0) continue;

        for (const taxId of line.tax_ids) {
          const taxName = taxNames[taxId] || '';

          // Check if tax matches expected pattern
          let isCorrect = false;

          if (journalCode === 'VOS') {
            // VOS should have OSS taxes
            isCorrect = taxName.includes('OSS');
          } else if (journalCode === 'VEX') {
            // VEX should have EX* or 0% taxes (export)
            isCorrect = taxName.startsWith('EX*') || taxName.includes('0%') || taxName.includes('Export');
          } else {
            // Country-specific journals should have matching country prefix
            const expectedPrefix = rules.expected[0].replace('*', '');
            isCorrect = taxName.startsWith(expectedPrefix + '*');
          }

          if (!isCorrect) {
            wrongLines.push({
              lineId: line.id,
              lineName: line.name,
              taxId: taxId,
              taxName: taxName,
              amount: line.price_subtotal
            });
          }
        }
      }

      if (wrongLines.length > 0) {
        errors.push({
          id: inv.id,
          name: inv.name,
          type: inv.move_type === 'out_invoice' ? 'Invoice' : 'Credit Note',
          date: inv.invoice_date,
          partner: inv.partner_id ? inv.partner_id[1] : 'Unknown',
          amount: inv.amount_total,
          paymentState: inv.payment_state,
          wrongLines: wrongLines
        });
      }
    }

    if (errors.length > 0) {
      allErrors[journalCode] = errors;
      console.log('\nFound ' + errors.length + ' documents with wrong taxes:');

      // Group by wrong tax type
      const byTax = {};
      for (const err of errors) {
        for (const line of err.wrongLines) {
          const taxPrefix = line.taxName.match(/^([A-Z]{2})\*/)?.[1] || 'OTHER';
          if (!byTax[taxPrefix]) byTax[taxPrefix] = [];
          byTax[taxPrefix].push({ inv: err.name, line: line });
        }
      }

      for (const [taxPrefix, items] of Object.entries(byTax)) {
        console.log('  ' + taxPrefix + '* taxes: ' + items.length + ' lines');
      }
    } else {
      console.log('No errors found');
    }
  }

  // Print detailed report
  console.log('\n\n' + '='.repeat(100));
  console.log('DETAILED REPORT');
  console.log('='.repeat(100));

  let totalInvoices = 0;
  let totalCreditNotes = 0;
  let totalNotPaid = 0;
  let totalPaid = 0;

  for (const [journalCode, errors] of Object.entries(allErrors)) {
    console.log('\n' + '-'.repeat(80));
    console.log(journalCode + ' - ' + errors.length + ' documents with wrong taxes');
    console.log('-'.repeat(80));

    for (const err of errors) {
      if (err.type === 'Invoice') totalInvoices++;
      else totalCreditNotes++;

      if (err.paymentState === 'not_paid') totalNotPaid++;
      else totalPaid++;

      console.log('\n' + err.name + ' (' + err.type + ') - ' + err.paymentState);
      console.log('  Date: ' + err.date + ' | Amount: EUR ' + err.amount.toFixed(2));
      console.log('  Partner: ' + err.partner);
      console.log('  Wrong lines:');
      for (const line of err.wrongLines) {
        console.log('    - Line ' + line.lineId + ': ' + line.taxName + ' (EUR ' + line.amount.toFixed(2) + ')');
      }
      console.log('  URL: https://acropaq.odoo.com/web#id=' + err.id + '&model=account.move&view_type=form');
    }
  }

  console.log('\n\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));

  let grandTotal = 0;
  for (const [journalCode, errors] of Object.entries(allErrors)) {
    const notPaid = errors.filter(e => e.paymentState === 'not_paid').length;
    const paid = errors.filter(e => e.paymentState !== 'not_paid').length;
    console.log(journalCode + ': ' + errors.length + ' documents (' + notPaid + ' not paid, ' + paid + ' paid/partial)');
    grandTotal += errors.length;
  }

  console.log('\nTotal documents with wrong taxes: ' + grandTotal);
  console.log('  - Invoices: ' + totalInvoices);
  console.log('  - Credit Notes: ' + totalCreditNotes);
  console.log('  - Not paid (can fix automatically): ' + totalNotPaid);
  console.log('  - Paid/Partial (need manual fix): ' + totalPaid);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
