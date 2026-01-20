/**
 * Fix mixed-tax invoices on VBE
 * These have promotion discount lines with BE*VAT that should have OSS tax
 * December 2025 - NOT PAID only
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

async function safeExecute(odoo, model, method, args) {
  try {
    return await odoo.execute(model, method, args);
  } catch (err) {
    if (err.message && err.message.includes('cannot marshal None')) {
      return true;
    }
    throw err;
  }
}

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('='.repeat(100));
  console.log('Fix: Mixed-tax invoices on VBE (promotion discount has wrong BE*VAT tax)');
  console.log('='.repeat(100));

  // Get VBE journal
  const vbeJournal = await odoo.searchRead('account.journal', [['code', '=', 'VBE']], ['id'], { limit: 1 });
  const vbeJournalId = vbeJournal[0].id;

  // Get all taxes
  const allTaxes = await odoo.searchRead('account.tax', [['type_tax_use', '=', 'sale']], ['id', 'name'], { limit: 500 });
  const taxMap = {};
  for (const t of allTaxes) taxMap[t.id] = t.name;

  // Get NOT PAID December invoices from VBE
  const invoices = await withRetry(() => odoo.searchRead('account.move',
    [
      ['journal_id', '=', vbeJournalId],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['state', '=', 'posted'],
      ['payment_state', '=', 'not_paid'],
      ['invoice_date', '>=', '2025-12-01'],
      ['invoice_date', '<=', '2025-12-31']
    ],
    ['id', 'name', 'partner_id', 'amount_total'],
    { limit: 5000 }
  ));

  console.log('VBE not-paid December invoices:', invoices.length);

  // Get all lines
  const invoiceIds = invoices.map(i => i.id);
  const allLines = [];
  for (let i = 0; i < invoiceIds.length; i += 500) {
    const batchIds = invoiceIds.slice(i, i + 500);
    const batchLines = await withRetry(() => odoo.searchRead('account.move.line',
      [['move_id', 'in', batchIds], ['display_type', '=', 'product']],
      ['id', 'move_id', 'tax_ids', 'name', 'price_subtotal', 'product_id'],
      { limit: 50000 }
    ));
    allLines.push(...batchLines);
    await sleep(100);
  }

  // Group by invoice
  const linesByInvoice = {};
  for (const line of allLines) {
    const invId = Array.isArray(line.move_id) ? line.move_id[0] : line.move_id;
    if (!linesByInvoice[invId]) linesByInvoice[invId] = [];
    linesByInvoice[invId].push(line);
  }

  const results = { fixed: 0, skipped: 0, errors: [] };

  // Find and fix mixed-tax invoices
  for (const inv of invoices) {
    const invLines = linesByInvoice[inv.id] || [];

    // Separate lines into discount and product lines
    let promotionDiscountLine = null;
    const productLines = [];

    for (const line of invLines) {
      const lineName = (line.name || '').toLowerCase();
      if (lineName.includes('promotion discount') || lineName.includes('promo discount')) {
        promotionDiscountLine = line;
      } else {
        productLines.push(line);
      }
    }

    // Skip if no promotion discount line
    if (!promotionDiscountLine) {
      results.skipped++;
      continue;
    }

    // Get taxes from lines
    const discountTaxIds = promotionDiscountLine.tax_ids || [];
    const discountTaxNames = discountTaxIds.map(tid => taxMap[tid] || '');
    const hasBeVatOnDiscount = discountTaxNames.some(name => name.startsWith('BE*'));

    // Get the correct tax from product lines (should be OSS or other non-BE tax)
    let correctTaxId = null;
    let correctTaxName = null;
    for (const line of productLines) {
      if (!line.tax_ids || line.tax_ids.length === 0) continue;
      for (const taxId of line.tax_ids) {
        const taxName = taxMap[taxId] || '';
        if (!taxName.startsWith('BE*')) {
          correctTaxId = taxId;
          correctTaxName = taxName;
          break;
        }
      }
      if (correctTaxId) break;
    }

    // Skip if discount doesn't have BE*VAT or we can't find correct tax
    if (!hasBeVatOnDiscount || !correctTaxId) {
      results.skipped++;
      continue;
    }

    console.log('\n  Processing: ' + inv.name);
    console.log('    Discount tax: ' + discountTaxNames.join(', ') + ' -> ' + correctTaxName);

    try {
      // Step 1: Reset to draft
      console.log('    1. Reset to draft...');
      await safeExecute(odoo, 'account.move', 'button_draft', [[inv.id]]);
      await sleep(200);

      // Step 2: Update promotion discount line tax
      console.log('    2. Update promotion discount line tax...');
      await odoo.execute('account.move.line', 'write', [[promotionDiscountLine.id], {
        tax_ids: [[6, 0, [correctTaxId]]]
      }]);
      await sleep(200);

      // Step 3: Post again
      console.log('    3. Post invoice...');
      await safeExecute(odoo, 'account.move', 'action_post', [[inv.id]]);
      await sleep(200);

      console.log('    SUCCESS: Fixed ' + inv.name);
      results.fixed++;

    } catch (err) {
      console.log('    ERROR: ' + err.message);
      results.errors.push({ invoice: inv.name, error: err.message });
    }

    await sleep(100);
  }

  // Summary
  console.log('\n\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));
  console.log('Fixed (tax corrected): ' + results.fixed);
  console.log('Skipped (no issue): ' + results.skipped);
  console.log('Errors: ' + results.errors.length);

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    for (const err of results.errors) {
      console.log('  - ' + err.invoice + ': ' + err.error);
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
