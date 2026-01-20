/**
 * Fix invoices with BE*VAT taxes on VOS/VIT/VGB/VEX journals
 * Move them to VBE journal
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
  console.log('Fix: BE*VAT taxes on VOS/VIT/VGB/VEX -> Move to VBE (December 2025)');
  console.log('='.repeat(100));

  // Get journals
  const journals = await odoo.searchRead('account.journal',
    [['code', 'in', ['VBE', 'VOS', 'VIT', 'VGB', 'VEX']]],
    ['id', 'code', 'name'],
    { limit: 10 }
  );

  const journalMap = {};
  for (const j of journals) {
    journalMap[j.code] = { id: j.id, name: j.name };
  }
  console.log('Journals:', Object.keys(journalMap).join(', '));

  const vbeJournalId = journalMap['VBE'].id;

  // Get BE*VAT taxes
  const beTaxes = await odoo.searchRead('account.tax',
    [['type_tax_use', '=', 'sale'], ['name', 'like', 'BE*VAT%']],
    ['id', 'name'],
    { limit: 50 }
  );
  const beTaxIds = beTaxes.map(t => t.id);
  console.log('BE*VAT tax IDs:', beTaxIds.join(', '));

  const results = { fixed: 0, skipped: 0, errors: [] };

  // Process each journal
  for (const journalCode of ['VOS', 'VIT', 'VGB', 'VEX']) {
    if (!journalMap[journalCode]) continue;

    const journalId = journalMap[journalCode].id;
    console.log('\n' + '='.repeat(80));
    console.log('Processing ' + journalCode);
    console.log('='.repeat(80));

    // Get NOT PAID December invoices with BE*VAT taxes
    const invoices = await withRetry(() => odoo.searchRead('account.move',
      [
        ['journal_id', '=', journalId],
        ['move_type', 'in', ['out_invoice', 'out_refund']],
        ['state', '=', 'posted'],
        ['payment_state', '=', 'not_paid'],
        ['invoice_date', '>=', '2025-12-01'],
        ['invoice_date', '<=', '2025-12-31']
      ],
      ['id', 'name', 'move_type', 'invoice_date', 'partner_id', 'amount_total', 'currency_id',
       'invoice_origin', 'narration', 'ref', 'invoice_payment_term_id', 'fiscal_position_id'],
      { limit: 5000 }
    ));

    console.log('Found ' + invoices.length + ' not-paid documents');

    // Fetch all lines
    const invoiceIds = invoices.map(inv => inv.id);
    const allLines = [];
    for (let i = 0; i < invoiceIds.length; i += 500) {
      const batchIds = invoiceIds.slice(i, i + 500);
      const batchLines = await withRetry(() => odoo.searchRead('account.move.line',
        [['move_id', 'in', batchIds], ['display_type', '=', 'product']],
        ['id', 'name', 'move_id', 'product_id', 'quantity', 'price_unit', 'discount',
         'tax_ids', 'price_subtotal', 'account_id', 'analytic_distribution'],
        { limit: 50000 }
      ));
      allLines.push(...batchLines);
      await sleep(100);
    }

    // Group lines by invoice
    const linesByInvoice = {};
    for (const line of allLines) {
      const invId = Array.isArray(line.move_id) ? line.move_id[0] : line.move_id;
      if (!linesByInvoice[invId]) linesByInvoice[invId] = [];
      linesByInvoice[invId].push(line);
    }

    // Process each invoice
    for (const inv of invoices) {
      const lines = linesByInvoice[inv.id] || [];

      // Check if any line has BE*VAT tax
      let hasBeTax = false;
      for (const line of lines) {
        if (!line.tax_ids) continue;
        for (const taxId of line.tax_ids) {
          if (beTaxIds.includes(taxId)) {
            hasBeTax = true;
            break;
          }
        }
        if (hasBeTax) break;
      }

      if (!hasBeTax) {
        results.skipped++;
        continue;
      }

      console.log('\n  Processing: ' + inv.name + ' -> VBE');

      try {
        // Step 1: Reset to draft
        console.log('    1. Reset to draft...');
        await safeExecute(odoo, 'account.move', 'button_draft', [[inv.id]]);
        await sleep(200);

        // Step 2: Cancel
        console.log('    2. Cancel invoice...');
        await odoo.write('account.move', [inv.id], { state: 'cancel' });
        await sleep(200);

        // Step 3: Create new invoice on VBE
        console.log('    3. Create new invoice on VBE...');

        const invoiceLines = [];
        for (const line of lines) {
          invoiceLines.push([0, 0, {
            product_id: line.product_id ? line.product_id[0] : false,
            name: line.name,
            quantity: line.quantity,
            price_unit: line.price_unit,
            discount: line.discount || 0,
            tax_ids: [[6, 0, line.tax_ids || []]],
            account_id: line.account_id ? line.account_id[0] : false,
            analytic_distribution: line.analytic_distribution || false
          }]);
        }

        const newInvoiceData = {
          move_type: inv.move_type,
          journal_id: vbeJournalId,
          partner_id: inv.partner_id ? inv.partner_id[0] : false,
          invoice_date: inv.invoice_date,
          date: inv.invoice_date,
          currency_id: inv.currency_id ? inv.currency_id[0] : false,
          invoice_origin: inv.invoice_origin || false,
          narration: inv.narration || false,
          ref: inv.ref || false,
          invoice_payment_term_id: inv.invoice_payment_term_id ? inv.invoice_payment_term_id[0] : false,
          fiscal_position_id: inv.fiscal_position_id ? inv.fiscal_position_id[0] : false,
          invoice_line_ids: invoiceLines
        };

        const newInvoiceId = await odoo.create('account.move', newInvoiceData);
        await sleep(200);

        // Step 4: Post
        console.log('    4. Post new invoice...');
        await safeExecute(odoo, 'account.move', 'action_post', [[newInvoiceId]]);
        await sleep(200);

        const newInvoice = await odoo.searchRead('account.move', [['id', '=', newInvoiceId]], ['name'], { limit: 1 });
        console.log('    SUCCESS: ' + inv.name + ' -> ' + (newInvoice[0]?.name || newInvoiceId));
        results.fixed++;

      } catch (err) {
        console.log('    ERROR: ' + err.message);
        results.errors.push({ invoice: inv.name, error: err.message });
      }

      await sleep(100);
    }
  }

  // Summary
  console.log('\n\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));
  console.log('Fixed (moved to VBE): ' + results.fixed);
  console.log('Skipped (no BE*VAT): ' + results.skipped);
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
