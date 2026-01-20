/**
 * Repost invoices to apply updated tax tags
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

  // The invoice that needs reposting
  const invoiceName = 'VOS/2025/12/03769';

  console.log('=== Reposting invoice to apply new tax tags ===\n');

  const invoices = await odoo.searchRead('account.move',
    [['name', '=', invoiceName]],
    ['id', 'name', 'state', 'payment_state'],
    { limit: 1 }
  );

  if (invoices.length === 0) {
    console.error('Invoice not found:', invoiceName);
    return;
  }

  const inv = invoices[0];
  console.log('Invoice:', inv.name, '| State:', inv.state, '| Payment:', inv.payment_state);

  if (inv.payment_state !== 'not_paid') {
    console.log('Cannot repost - invoice is paid');
    return;
  }

  try {
    // Step 1: Reset to draft
    console.log('1. Reset to draft...');
    await safeExecute(odoo, 'account.move', 'button_draft', [[inv.id]]);
    await sleep(300);

    // Step 2: Post again (this will regenerate tax lines with new tags)
    console.log('2. Post invoice...');
    await safeExecute(odoo, 'account.move', 'action_post', [[inv.id]]);
    await sleep(300);

    // Verify the tax tags
    console.log('3. Verifying tax tags...');
    const taxLines = await odoo.searchRead('account.move.line',
      [['move_id', '=', inv.id], ['tax_line_id', '!=', false]],
      ['id', 'tax_line_id', 'balance', 'tax_tag_ids'],
      { limit: 20 }
    );

    console.log('\nTax lines after repost:');
    for (const l of taxLines) {
      const taxName = l.tax_line_id ? l.tax_line_id[1] : 'Unknown';
      const tags = l.tax_tag_ids || [];
      console.log('  - ' + taxName + ' | EUR ' + Math.abs(l.balance).toFixed(2) + ' | Tags: ' + (tags.length > 0 ? tags.join(', ') : 'NONE'));
    }

    console.log('\nSUCCESS: Invoice reposted with updated tax tags');

  } catch (err) {
    console.error('ERROR:', err.message);
  }
}

main().catch(console.error);
