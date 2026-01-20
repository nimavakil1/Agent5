/**
 * Analyze IT, GB, OSS, VEX journals for wrong taxes in December 2025
 * Report only - no changes made
 *
 * Updated with retry logic and rate limiting for large journals
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Journals to check
const JOURNALS_TO_CHECK = ['VIT', 'VGB', 'VOS', 'VEX'];

// Tax prefix to target journal mapping
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

// Helper for delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper for retry with exponential backoff
async function withRetry(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`  Retry ${attempt}/${maxRetries} after ${delay}ms: ${err.message}`);
      await sleep(delay);
    }
  }
}

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('='.repeat(100));
  console.log('Analysis: Wrong Taxes on IT, GB, OSS, VEX Journals (December 2025)');
  console.log('='.repeat(100));

  // Get journals
  const journals = await odoo.searchRead('account.journal',
    [['code', 'in', JOURNALS_TO_CHECK]],
    ['id', 'code', 'name'],
    { limit: 10 }
  );

  const journalMap = {};
  for (const j of journals) {
    journalMap[j.code] = { id: j.id, name: j.name };
  }

  console.log('Checking journals:', Object.keys(journalMap).join(', '));

  // Get all taxes upfront
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

  for (const journalCode of JOURNALS_TO_CHECK) {
    if (!journalMap[journalCode]) {
      console.log('\nSkipping ' + journalCode + ' - not found');
      continue;
    }

    const journalId = journalMap[journalCode].id;
    console.log('\n' + '='.repeat(80));
    console.log('Checking ' + journalCode + ' (' + journalMap[journalCode].name + ')');
    console.log('='.repeat(80));

    // Get December invoices and credit notes
    const invoices = await withRetry(() => odoo.searchRead('account.move',
      [
        ['journal_id', '=', journalId],
        ['move_type', 'in', ['out_invoice', 'out_refund']],
        ['state', '=', 'posted'],
        ['invoice_date', '>=', '2025-12-01'],
        ['invoice_date', '<=', '2025-12-31']
      ],
      ['id', 'name', 'move_type', 'invoice_date', 'partner_id', 'amount_total', 'payment_state'],
      { limit: 5000 }
    ));

    console.log('Found ' + invoices.length + ' posted documents');

    // For large journals, fetch all lines at once instead of per-invoice
    const invoiceIds = invoices.map(inv => inv.id);
    console.log('Fetching all invoice lines in batches...');

    // Fetch lines in batches of 500 invoices
    const allLines = [];
    const batchSize = 500;
    for (let i = 0; i < invoiceIds.length; i += batchSize) {
      const batchIds = invoiceIds.slice(i, i + batchSize);
      console.log(`  Fetching lines for invoices ${i + 1}-${Math.min(i + batchSize, invoiceIds.length)}...`);

      const batchLines = await withRetry(() => odoo.searchRead('account.move.line',
        [['move_id', 'in', batchIds], ['display_type', '=', 'product']],
        ['id', 'name', 'move_id', 'tax_ids', 'price_subtotal'],
        { limit: 50000 }
      ));

      allLines.push(...batchLines);
      await sleep(100); // Small delay between batches
    }

    console.log('Total lines fetched: ' + allLines.length);

    // Group lines by invoice
    const linesByInvoice = {};
    for (const line of allLines) {
      const invId = Array.isArray(line.move_id) ? line.move_id[0] : line.move_id;
      if (!linesByInvoice[invId]) linesByInvoice[invId] = [];
      linesByInvoice[invId].push(line);
    }

    const errors = [];
    let checked = 0;

    for (const inv of invoices) {
      checked++;
      if (checked % 500 === 0) {
        console.log('  Checked ' + checked + ' / ' + invoices.length + '...');
      }

      const lines = linesByInvoice[inv.id] || [];

      // Check each line's taxes
      const wrongLines = [];
      for (const line of lines) {
        if (!line.tax_ids || line.tax_ids.length === 0) continue;

        for (const taxId of line.tax_ids) {
          const taxName = taxNames[taxId] || '';
          const taxMatch = taxName.match(/^([A-Z]{2})\*/);
          const taxPrefix = taxMatch ? taxMatch[1] : null;

          let isCorrect = false;
          let suggestedJournal = null;

          if (journalCode === 'VIT') {
            isCorrect = taxName.startsWith('IT*');
            if (!isCorrect && taxPrefix && TAX_TO_JOURNAL[taxPrefix]) {
              suggestedJournal = TAX_TO_JOURNAL[taxPrefix];
            }
          } else if (journalCode === 'VGB') {
            isCorrect = taxName.startsWith('GB*');
            if (!isCorrect && taxPrefix && TAX_TO_JOURNAL[taxPrefix]) {
              suggestedJournal = TAX_TO_JOURNAL[taxPrefix];
            }
          } else if (journalCode === 'VOS') {
            isCorrect = taxName.includes('OSS');
            if (!isCorrect && taxPrefix && TAX_TO_JOURNAL[taxPrefix]) {
              suggestedJournal = TAX_TO_JOURNAL[taxPrefix];
            }
          } else if (journalCode === 'VEX') {
            // VEX should have EX* or 0% taxes (export)
            isCorrect = taxName.startsWith('EX*') || taxName.includes('0%') || taxName.includes('Export');
            if (!isCorrect && taxPrefix && TAX_TO_JOURNAL[taxPrefix]) {
              suggestedJournal = TAX_TO_JOURNAL[taxPrefix];
            }
          }

          if (!isCorrect) {
            wrongLines.push({
              lineId: line.id,
              lineName: line.name,
              taxId: taxId,
              taxName: taxName,
              taxPrefix: taxPrefix,
              suggestedJournal: suggestedJournal,
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

      // Group by suggested journal
      const byJournal = {};
      for (const err of errors) {
        for (const line of err.wrongLines) {
          const target = line.suggestedJournal || 'UNKNOWN';
          if (!byJournal[target]) byJournal[target] = { count: 0, invoices: new Set() };
          byJournal[target].count++;
          byJournal[target].invoices.add(err.name);
        }
      }

      console.log('Found ' + errors.length + ' documents with wrong taxes:');
      for (const [target, data] of Object.entries(byJournal)) {
        console.log('  -> ' + target + ': ' + data.count + ' lines in ' + data.invoices.size + ' documents');
      }
    } else {
      console.log('No errors found');
    }
  }

  // Print detailed report
  console.log('\n\n' + '='.repeat(100));
  console.log('DETAILED REPORT');
  console.log('='.repeat(100));

  let totalDocs = 0;
  let totalNotPaid = 0;
  let totalPaid = 0;

  for (const [journalCode, errors] of Object.entries(allErrors)) {
    console.log('\n' + '-'.repeat(80));
    console.log(journalCode + ' - ' + errors.length + ' documents with wrong taxes');
    console.log('-'.repeat(80));

    for (const err of errors) {
      totalDocs++;
      if (err.paymentState === 'not_paid') totalNotPaid++;
      else totalPaid++;

      console.log('\n' + err.name + ' (' + err.type + ') - ' + err.paymentState);
      console.log('  Date: ' + err.date + ' | Amount: EUR ' + err.amount.toFixed(2));
      console.log('  Partner: ' + err.partner);
      console.log('  Wrong taxes:');
      for (const line of err.wrongLines) {
        const suggestion = line.suggestedJournal ? ' -> should be ' + line.suggestedJournal : '';
        console.log('    - ' + line.taxName + suggestion);
      }
      console.log('  URL: https://acropaq.odoo.com/web#id=' + err.id + '&model=account.move&view_type=form');
    }
  }

  console.log('\n\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));

  for (const [journalCode, errors] of Object.entries(allErrors)) {
    const notPaid = errors.filter(e => e.paymentState === 'not_paid').length;
    const paid = errors.filter(e => e.paymentState !== 'not_paid').length;
    console.log(journalCode + ': ' + errors.length + ' documents (' + notPaid + ' not paid, ' + paid + ' paid/partial)');
  }

  console.log('\nTotal: ' + totalDocs + ' documents');
  console.log('  - Not paid (can fix): ' + totalNotPaid);
  console.log('  - Paid/Partial (manual): ' + totalPaid);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
