/**
 * Fix draft VFR invoices that were left in draft state
 * Updates Belgian taxes to French taxes and re-posts
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Tax mappings: BE tax ID → FR tax ID
const TAX_MAPPING = {
  1: 122,   // BE*VAT 21% → FR*VAT 20%
  2: 122,   // BE*VAT 21% S → FR*VAT 20%
  4: 122,   // BE*VAT 12% → FR*VAT 20%
  6: 123,   // BE*VAT 6% → FR*VAT 5.5%
  8: 144,   // BE*VAT 0% → FR*VAT 0% EU
  147: 173, // BE*VAT 21% Included → FR*VAT 20% Included
  148: 173, // BE*VAT 12% Included → FR*VAT 20% Included
};

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit'));
  const limit = limitArg ? parseInt(limitArg.split('=')[1] || args[args.indexOf('--limit') + 1]) : null;

  console.log('='.repeat(60));
  console.log('Fix Draft VFR Invoices');
  console.log('='.repeat(60));
  console.log('Mode:', dryRun ? 'DRY RUN' : 'LIVE');
  if (limit) console.log('Limit:', limit);
  console.log('');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Get BE tax IDs
  const beTaxes = await odoo.searchRead('account.tax',
    [['name', 'like', 'BE%'], ['type_tax_use', '=', 'sale']],
    ['id', 'name'],
    { limit: 100 }
  );
  const beTaxIds = beTaxes.map(t => t.id);
  const beTaxNames = {};
  for (const t of beTaxes) beTaxNames[t.id] = t.name;

  // Get all draft VFR invoices
  const draftInvoices = await odoo.searchRead('account.move',
    [
      ['journal_id.code', '=', 'VFR'],
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'draft'],
      ['invoice_date', '>=', '2025-12-01']
    ],
    ['id', 'name'],
    { limit: limit || 1000 }
  );

  console.log('Draft VFR invoices found:', draftInvoices.length);

  let fixed = 0;
  let failed = 0;

  for (let i = 0; i < draftInvoices.length; i++) {
    const inv = draftInvoices[i];
    console.log(`\n[${i + 1}/${draftInvoices.length}] ${inv.name}`);

    try {
      // Get lines with taxes
      const lines = await odoo.searchRead('account.move.line',
        [['move_id', '=', inv.id], ['display_type', '=', 'product']],
        ['id', 'tax_ids', 'name'],
        { limit: 50 }
      );

      // Update each line's taxes
      let linesUpdated = 0;
      for (const line of lines) {
        const currentTaxIds = line.tax_ids || [];
        const newTaxIds = [];
        let changed = false;

        for (const taxId of currentTaxIds) {
          if (beTaxIds.includes(taxId)) {
            const newTaxId = TAX_MAPPING[taxId];
            if (newTaxId) {
              newTaxIds.push(newTaxId);
              changed = true;
              console.log(`  Line ${line.id}: ${beTaxNames[taxId]} → ${newTaxId}`);
            } else {
              newTaxIds.push(taxId);
              console.log(`  Line ${line.id}: ${beTaxNames[taxId]} → NO MAPPING (keeping)`);
            }
          } else {
            newTaxIds.push(taxId);
          }
        }

        if (changed && !dryRun) {
          await odoo.execute('account.move.line', 'write', [[line.id], {
            tax_ids: [[6, 0, newTaxIds]]
          }]);
          linesUpdated++;
        } else if (changed) {
          linesUpdated++;
        }
      }

      if (linesUpdated > 0) {
        console.log(`  Updated ${linesUpdated} lines`);
      }

      // Re-post the invoice
      if (!dryRun) {
        console.log('  Re-posting...');
        try {
          await odoo.execute('account.move', 'action_post', [[inv.id]]);
        } catch (e) {
          if (!e.message.includes('cannot marshal None')) {
            throw e;
          }
        }
      }

      console.log('  ✓ Done');
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
  console.log('Total:', fixed + failed);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
