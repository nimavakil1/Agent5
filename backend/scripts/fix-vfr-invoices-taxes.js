/**
 * Fix wrong VFR invoices that have Belgian taxes instead of French taxes
 *
 * This script:
 * 1. Finds all VFR invoices with BE*VAT taxes
 * 2. Maps them to correct French taxes based on fiscal position
 * 3. Resets to draft, updates taxes, re-posts
 *
 * Usage: node scripts/fix-vfr-invoices-taxes.js [--dry-run] [--limit N]
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Tax mappings: BE tax ID → FR tax ID based on fiscal position
const TAX_CORRECTIONS = {
  // For FR*VAT | Régime National (ID: 33)
  'FR*VAT | Régime National': {
    1: 122,   // BE*VAT 21% → FR*VAT 20%
    2: 122,   // BE*VAT 21% S → FR*VAT 20%
    4: 122,   // BE*VAT 12% → FR*VAT 20%
    6: 123,   // BE*VAT 6% → FR*VAT 5.5%
    8: 144,   // BE*VAT 0% → FR*VAT 0% EU
  },

  // For FR*VAT | Régime National (TxIn) (ID: 58)
  'FR*VAT | Régime National (TxIn)': {
    1: 173,   // BE*VAT 21% → FR*VAT 20% Included
    2: 173,   // BE*VAT 21% S → FR*VAT 20% Included
    4: 173,   // BE*VAT 12% → FR*VAT 20% Included
    6: 175,   // BE*VAT 6% → FR*VAT 5.5% Included
    147: 173, // BE*VAT 21% Included → FR*VAT 20% Included
    148: 173, // BE*VAT 12% Included → FR*VAT 20% Included
  },

  // For FR*VAT | Régime Intra-Communautaire (ID: 37) - B2B reverse charge
  'FR*VAT | Régime Intra-Communautaire': {
    1: 144,   // BE*VAT 21% → FR*VAT 0% EU
    2: 144,   // BE*VAT 21% S → FR*VAT 0% EU
    4: 144,   // BE*VAT 12% → FR*VAT 0% EU
    6: 144,   // BE*VAT 6% → FR*VAT 0% EU
    8: 144,   // BE*VAT 0% → FR*VAT 0% EU
    147: 144, // BE*VAT 21% Included → FR*VAT 0% EU
  },

  // For FR*OSS | B2C France (ID: 14)
  'FR*OSS | B2C France': {
    1: 141,   // BE*VAT 21% → FR*OSS 20%
    2: 141,   // BE*VAT 21% S → FR*OSS 20%
    4: 141,   // BE*VAT 12% → FR*OSS 20%
    6: 87,    // BE*VAT 6% → FR*OSS 5.5%
  },

  // For FR*OSS | B2C France (TxIn) (ID: 53)
  'FR*OSS | B2C France (TxIn)': {
    1: 160,   // BE*VAT 21% → FR*OSS 20% Included
    2: 160,   // BE*VAT 21% S → FR*OSS 20% Included
    4: 160,   // BE*VAT 12% → FR*OSS 20% Included
    6: 165,   // BE*VAT 6% → FR*OSS 5.5% Included
    8: 143,   // BE*VAT 0% → FR*VAT 0% EX (export/exemption)
    147: 160, // BE*VAT 21% Included → FR*OSS 20% Included
    148: 160, // BE*VAT 12% Included → FR*OSS 20% Included
  },

  // For FR*VAT | Régime Extra-Communautaire (ID: 36) - Export
  'FR*VAT | Régime Extra-Communautaire': {
    1: 143,   // BE*VAT 21% → FR*VAT 0% EX
    2: 143,   // BE*VAT 21% S → FR*VAT 0% EX
    4: 143,   // BE*VAT 12% → FR*VAT 0% EX
    6: 143,   // BE*VAT 6% → FR*VAT 0% EX
    8: 143,   // BE*VAT 0% → FR*VAT 0% EX
  },
};

// Default mapping for invoices without fiscal position or unknown FP
// Use FR*VAT 20% (122) for standard rate
const DEFAULT_MAPPING = {
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
  console.log('Fix VFR Invoices with Belgian Taxes');
  console.log('='.repeat(60));
  console.log('Mode:', dryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify invoices)');
  if (limit) console.log('Limit:', limit, 'invoices');
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

  console.log('Belgian tax IDs:', beTaxIds.length);

  // Get all VFR invoices since Dec 2025
  console.log('\nFinding VFR invoices since 2025-12-01...');
  const allInvoices = await odoo.searchRead('account.move',
    [
      ['journal_id.code', '=', 'VFR'],
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['invoice_date', '>=', '2025-12-01']
    ],
    ['id', 'name', 'fiscal_position_id', 'state', 'payment_state'],
    { limit: 2000 }
  );

  console.log('Total VFR invoices:', allInvoices.length);

  // Find invoices with BE taxes
  console.log('Checking for Belgian taxes...');
  const wrongInvoices = [];

  for (let i = 0; i < allInvoices.length; i++) {
    const inv = allInvoices[i];
    if (i > 0 && i % 100 === 0) {
      console.log(`  Checked ${i}/${allInvoices.length}...`);
    }

    const lines = await odoo.searchRead('account.move.line',
      [['move_id', '=', inv.id], ['display_type', '=', 'product']],
      ['id', 'tax_ids', 'name'],
      { limit: 50 }
    );

    // Check if any line has BE tax
    const linesWithBeTax = lines.filter(l =>
      l.tax_ids && l.tax_ids.some(tid => beTaxIds.includes(tid))
    );

    if (linesWithBeTax.length > 0) {
      wrongInvoices.push({ ...inv, lines: linesWithBeTax });
    }
  }

  console.log('\nInvoices with Belgian taxes:', wrongInvoices.length);

  if (wrongInvoices.length === 0) {
    console.log('No invoices to fix!');
    return;
  }

  // Summary by fiscal position
  const byFP = {};
  for (const inv of wrongInvoices) {
    const fp = inv.fiscal_position_id ? inv.fiscal_position_id[1] : 'No fiscal position';
    byFP[fp] = (byFP[fp] || 0) + 1;
  }

  console.log('\nBy fiscal position:');
  for (const [fp, count] of Object.entries(byFP).sort((a, b) => b[1] - a[1])) {
    const hasMapping = TAX_CORRECTIONS[fp] ? '✓' : '○';
    console.log(`  ${hasMapping} ${fp}: ${count}`);
  }

  // Apply limit if specified
  const toFix = limit ? wrongInvoices.slice(0, limit) : wrongInvoices;
  console.log(`\nWill process: ${toFix.length} invoices`);

  // Process each invoice
  let fixed = 0;
  let failed = 0;
  let skipped = 0;

  for (const inv of toFix) {
    const fpName = inv.fiscal_position_id ? inv.fiscal_position_id[1] : null;
    const mapping = TAX_CORRECTIONS[fpName] || DEFAULT_MAPPING;

    console.log(`\n[${fixed + failed + skipped + 1}/${toFix.length}] ${inv.name}`);
    console.log(`  FP: ${fpName || 'None'}`);
    console.log(`  Payment: ${inv.payment_state}`);

    // Skip if paid
    if (inv.payment_state !== 'not_paid') {
      console.log('  ⚠ SKIPPED - Invoice has payments');
      skipped++;
      continue;
    }

    // Calculate new taxes for each line
    const lineUpdates = [];
    for (const line of inv.lines) {
      const currentTaxIds = line.tax_ids || [];
      const newTaxIds = [];
      let changed = false;

      for (const taxId of currentTaxIds) {
        if (beTaxIds.includes(taxId)) {
          const newTaxId = mapping[taxId];
          if (newTaxId) {
            newTaxIds.push(newTaxId);
            changed = true;
            console.log(`  Line ${line.id}: ${beTaxNames[taxId]} (${taxId}) → ${newTaxId}`);
          } else {
            // Debug: show mapping keys to understand mismatch
            console.log(`  Line ${line.id}: ${beTaxNames[taxId]} (${taxId}) → NO MAPPING! (keys: ${Object.keys(mapping).join(',')}, fpName: "${fpName}")`);
            newTaxIds.push(taxId); // Keep original if no mapping
          }
        } else {
          newTaxIds.push(taxId); // Keep non-BE taxes
        }
      }

      if (changed) {
        lineUpdates.push({ lineId: line.id, newTaxIds });
      }
    }

    if (lineUpdates.length === 0) {
      console.log('  No changes needed');
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log('  [DRY RUN] Would update', lineUpdates.length, 'lines');
      fixed++;
      continue;
    }

    // Actually fix the invoice
    try {
      // 1. Reset to draft - use write to set state directly (button_draft returns None which XML-RPC can't handle)
      console.log('  Resetting to draft...');
      try {
        await odoo.execute('account.move', 'button_draft', [[inv.id]]);
      } catch (e) {
        // Ignore "cannot marshal None" error - the method still executed successfully
        if (!e.message.includes('cannot marshal None')) {
          throw e;
        }
      }

      // 2. Update tax_ids on each line
      for (const { lineId, newTaxIds } of lineUpdates) {
        await odoo.execute('account.move.line', 'write', [[lineId], {
          tax_ids: [[6, 0, newTaxIds]]
        }]);
      }

      // 3. Recompute totals
      console.log('  Recomputing...');
      try {
        await odoo.execute('account.move', '_compute_amount', [[inv.id]]);
      } catch (e) {
        // Ignore "cannot marshal None" error
        if (!e.message.includes('cannot marshal None')) {
          throw e;
        }
      }

      // 4. Re-post
      console.log('  Re-posting...');
      try {
        await odoo.execute('account.move', 'action_post', [[inv.id]]);
      } catch (e) {
        // Ignore "cannot marshal None" error
        if (!e.message.includes('cannot marshal None')) {
          throw e;
        }
      }

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
  console.log('Skipped:', skipped);
  console.log('Total processed:', fixed + failed + skipped);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
