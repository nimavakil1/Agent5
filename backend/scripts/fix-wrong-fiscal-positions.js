/**
 * Fix VFR invoices with wrong fiscal positions
 * Updates DE, IT, BE fiscal positions to FR*VAT | Régime National
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Get French fiscal position IDs
  const frFPs = await odoo.searchRead('account.fiscal.position',
    [['name', 'ilike', 'FR%VAT%Régime National']],
    ['id', 'name'],
    { limit: 5 }
  );

  console.log('Available FR*VAT Régime National fiscal positions:');
  for (const fp of frFPs) {
    console.log('  ID', fp.id, ':', fp.name);
  }

  // Get FR*VAT | Régime National (standard one)
  const targetFP = frFPs.find(fp => fp.name === 'FR*VAT | Régime National');
  if (!targetFP) {
    console.log('ERROR: Could not find FR*VAT | Régime National');
    return;
  }

  console.log('\nTarget fiscal position: ID', targetFP.id, '-', targetFP.name);

  // The 8 invoices with wrong fiscal positions
  const invoiceNames = [
    'VFR/2026/01/00117',
    'VFR/2026/01/00114',
    'VFR/2026/01/00111',
    'VFR/2026/01/00106',
    'VFR/2026/01/00105',
    'VFR/2026/01/00104',
    'VFR/2026/01/00098',
    'VFR/2026/01/00097'
  ];

  console.log('\nFixing fiscal positions...');
  console.log('='.repeat(60));

  let fixed = 0;
  let failed = 0;

  for (const name of invoiceNames) {
    const invoices = await odoo.searchRead('account.move',
      [['name', '=', name]],
      ['id', 'name', 'fiscal_position_id', 'state'],
      { limit: 1 }
    );

    if (invoices.length === 0) {
      console.log(name + ': NOT FOUND');
      failed++;
      continue;
    }

    const inv = invoices[0];
    const oldFP = inv.fiscal_position_id ? inv.fiscal_position_id[1] : 'None';

    console.log('\n' + inv.name);
    console.log('  Old FP:', oldFP);
    console.log('  State:', inv.state);

    try {
      // Reset to draft
      try {
        await odoo.execute('account.move', 'button_draft', [[inv.id]]);
      } catch (e) {
        if (!e.message.includes('cannot marshal None')) throw e;
      }

      // Update fiscal position
      await odoo.execute('account.move', 'write', [[inv.id], {
        fiscal_position_id: targetFP.id
      }]);

      // Re-post
      try {
        await odoo.execute('account.move', 'action_post', [[inv.id]]);
      } catch (e) {
        if (!e.message.includes('cannot marshal None')) throw e;
      }

      console.log('  New FP:', targetFP.name);
      console.log('  ✓ Fixed');
      fixed++;

    } catch (error) {
      console.log('  ✗ ERROR:', error.message);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log('Fixed:', fixed);
  console.log('Failed:', failed);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
