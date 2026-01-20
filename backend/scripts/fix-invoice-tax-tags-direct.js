/**
 * Fix remaining invoice tax line without tags by updating directly
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

  // Get the invoice
  const inv = await odoo.searchRead('account.move',
    [['name', '=', 'VOS/2025/12/03769']],
    ['id'],
    { limit: 1 }
  );

  if (inv.length === 0) {
    console.log('Invoice not found');
    return;
  }

  // Get all tax lines
  const taxLines = await odoo.searchRead('account.move.line',
    [['move_id', '=', inv[0].id], ['tax_line_id', '!=', false]],
    ['id', 'tax_line_id', 'balance', 'tax_tag_ids'],
    { limit: 20 }
  );

  console.log('Tax lines:');
  for (const l of taxLines) {
    console.log('  ID:', l.id, '| Tax:', l.tax_line_id[1], '| Tax ID:', l.tax_line_id[0], '| Tags:', l.tax_tag_ids);
  }

  // Find lines with no tags
  const noTagLines = taxLines.filter(l => !l.tax_tag_ids || l.tax_tag_ids.length === 0);

  if (noTagLines.length === 0) {
    console.log('\nAll lines have tags already!');
    return;
  }

  console.log('\nLines without tags:', noTagLines.length);

  // Reset to draft first
  console.log('\n1. Reset to draft...');
  await safeExecute(odoo, 'account.move', 'button_draft', [[inv[0].id]]);
  await sleep(300);

  // Fix each line
  for (const line of noTagLines) {
    console.log('\nFixing line', line.id, '| Tax:', line.tax_line_id[1]);

    // Get the tax repartition line tags
    const taxId = line.tax_line_id[0];
    const tax = await odoo.searchRead('account.tax',
      [['id', '=', taxId]],
      ['id', 'name', 'invoice_repartition_line_ids'],
      { limit: 1 }
    );

    console.log('  Tax:', tax[0].name);
    const repLines = await odoo.searchRead('account.tax.repartition.line',
      [['id', 'in', tax[0].invoice_repartition_line_ids]],
      ['id', 'repartition_type', 'tag_ids'],
      { limit: 10 }
    );

    // Get the correct tag for tax type
    const taxRepLine = repLines.find(r => r.repartition_type === 'tax');
    if (taxRepLine && taxRepLine.tag_ids && taxRepLine.tag_ids.length > 0) {
      console.log('  Updating with tags:', taxRepLine.tag_ids);
      await odoo.write('account.move.line', [line.id], {
        tax_tag_ids: [[6, 0, taxRepLine.tag_ids]]
      });
    } else {
      console.log('  WARNING: Tax repartition line has no tags');
    }
  }

  // Post again
  console.log('\n2. Post invoice...');
  await safeExecute(odoo, 'account.move', 'action_post', [[inv[0].id]]);
  await sleep(300);

  // Verify
  console.log('\n3. Verifying...');
  const verifyLines = await odoo.searchRead('account.move.line',
    [['move_id', '=', inv[0].id], ['tax_line_id', '!=', false]],
    ['id', 'tax_line_id', 'tax_tag_ids'],
    { limit: 20 }
  );

  let allGood = true;
  for (const l of verifyLines) {
    const hasTag = l.tax_tag_ids && l.tax_tag_ids.length > 0;
    console.log('  ID:', l.id, '| Tax:', l.tax_line_id[1], '| Tags:', l.tax_tag_ids, hasTag ? '✓' : '✗');
    if (!hasTag) allGood = false;
  }

  console.log(allGood ? '\nSUCCESS: All tax lines now have tags!' : '\nWARNING: Some lines still missing tags');
}

main().catch(console.error);
