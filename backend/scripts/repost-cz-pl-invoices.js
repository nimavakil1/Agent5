/**
 * Repost CZ and PL invoices to apply new tax tags
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

  console.log('=== Reposting CZ and PL invoices ===\n');

  const invoiceNames = ['VCZ/2025/00001', 'VCZ/2025/00002', 'VPL/2025/00001'];

  for (const name of invoiceNames) {
    console.log('Processing:', name);

    const invoices = await odoo.searchRead('account.move',
      [['name', '=', name]],
      ['id', 'name', 'state', 'payment_state'],
      { limit: 1 }
    );

    if (invoices.length === 0) {
      console.log('  Not found, skipping');
      continue;
    }

    const inv = invoices[0];

    if (inv.payment_state !== 'not_paid') {
      console.log('  Cannot repost - payment_state:', inv.payment_state);
      continue;
    }

    try {
      // Reset to draft
      console.log('  1. Reset to draft...');
      await safeExecute(odoo, 'account.move', 'button_draft', [[inv.id]]);
      await sleep(300);

      // Post again
      console.log('  2. Post invoice...');
      await safeExecute(odoo, 'account.move', 'action_post', [[inv.id]]);
      await sleep(300);

      // Verify tags
      const taxLines = await odoo.searchRead('account.move.line',
        [['move_id', '=', inv.id], ['tax_line_id', '!=', false]],
        ['id', 'tax_line_id', 'tax_tag_ids'],
        { limit: 10 }
      );

      let allGood = true;
      for (const l of taxLines) {
        if (!l.tax_tag_ids || l.tax_tag_ids.length === 0) {
          allGood = false;
          // Try to fix directly
          const taxId = l.tax_line_id[0];
          const tax = await odoo.searchRead('account.tax',
            [['id', '=', taxId]],
            ['id', 'invoice_repartition_line_ids'],
            { limit: 1 }
          );
          const repLines = await odoo.searchRead('account.tax.repartition.line',
            [['id', 'in', tax[0].invoice_repartition_line_ids], ['repartition_type', '=', 'tax']],
            ['id', 'tag_ids'],
            { limit: 5 }
          );
          if (repLines[0]?.tag_ids?.length > 0) {
            await safeExecute(odoo, 'account.move', 'button_draft', [[inv.id]]);
            await odoo.write('account.move.line', [l.id], {
              tax_tag_ids: [[6, 0, repLines[0].tag_ids]]
            });
            await safeExecute(odoo, 'account.move', 'action_post', [[inv.id]]);
            console.log('  Fixed tax line directly');
            allGood = true;
          }
        }
      }

      console.log('  ' + (allGood ? 'SUCCESS' : 'WARNING: Some tags missing'));

    } catch (err) {
      console.log('  ERROR:', err.message);
    }
  }

  // Final verification
  console.log('\n=== Final Verification ===');
  const saleJournals = await odoo.searchRead('account.journal',
    [['type', '=', 'sale']],
    ['id'],
    { limit: 50 }
  );
  const saleJournalIds = saleJournals.map(j => j.id);

  const taxLinesNoTags = await odoo.searchRead('account.move.line',
    [
      ['parent_state', '=', 'posted'],
      ['journal_id', 'in', saleJournalIds],
      ['date', '>=', '2025-12-01'],
      ['date', '<=', '2025-12-31'],
      ['tax_line_id', '!=', false],
      ['tax_tag_ids', '=', false]
    ],
    ['id', 'move_id', 'tax_line_id', 'balance'],
    { limit: 100 }
  );

  console.log('Tax lines still without tags:', taxLinesNoTags.length);
  if (taxLinesNoTags.length > 0) {
    for (const l of taxLinesNoTags) {
      console.log('  -', l.move_id[1], '|', l.tax_line_id[1], '| EUR', Math.abs(l.balance).toFixed(2));
    }
  }
}

main().catch(console.error);
