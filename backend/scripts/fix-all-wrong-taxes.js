/**
 * Fix ALL invoices with wrong taxes across all V* journals
 * Each journal should only have taxes matching its country
 * VFR → FR*, VBE → BE*, VDE → DE*, VNL → NL*, VIT → IT*
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Journal code to expected tax country
const JOURNAL_TAX_COUNTRY = {
  'VFR': 'FR',
  'VBE': 'BE',
  'VDE': 'DE',
  'VNL': 'NL',
  'VIT': 'IT',
  'VGB': 'GB',
  'VPL': 'PL',
  'VCZ': 'CZ',
  // VOS and VEX are special - skip them
};

// Tax mappings: source country → target country → { sourceTaxId: targetTaxId }
// Will be populated dynamically based on rate matching
let TAX_MAPPINGS = {};

async function buildTaxMappings(odoo) {
  // Get all sale taxes
  const allTaxes = await odoo.searchRead('account.tax',
    [['type_tax_use', '=', 'sale']],
    ['id', 'name', 'amount'],
    { limit: 500 }
  );

  // Group by country and rate
  const taxesByCountryRate = {};
  const taxesByCountry = {};

  for (const t of allTaxes) {
    const match = t.name.match(/^([A-Z]{2})\*/);
    if (!match) continue;

    const country = match[1];
    const rate = t.amount;
    const isIncluded = t.name.includes('Included') || t.name.includes('TxIn');
    const key = `${country}_${rate}_${isIncluded}`;

    if (!taxesByCountryRate[key]) taxesByCountryRate[key] = [];
    taxesByCountryRate[key].push(t);

    if (!taxesByCountry[country]) taxesByCountry[country] = [];
    taxesByCountry[country].push(t.id);
  }

  // Build mappings between countries
  // For each source country, map to each target country based on rate
  const countries = Object.keys(JOURNAL_TAX_COUNTRY).map(j => JOURNAL_TAX_COUNTRY[j]);

  for (const sourceCountry of ['BE', 'FR', 'DE', 'NL', 'IT']) {
    TAX_MAPPINGS[sourceCountry] = {};

    for (const targetCountry of countries) {
      if (sourceCountry === targetCountry) continue;

      TAX_MAPPINGS[sourceCountry][targetCountry] = {};

      // Find source taxes and map to target taxes with similar rates
      const sourceTaxes = allTaxes.filter(t => t.name.startsWith(sourceCountry + '*'));

      for (const srcTax of sourceTaxes) {
        const srcRate = srcTax.amount;
        const srcIncluded = srcTax.name.includes('Included');

        // Find matching target tax
        const targetTaxes = allTaxes.filter(t =>
          t.name.startsWith(targetCountry + '*') &&
          t.name.includes('Included') === srcIncluded
        );

        // Find closest rate match
        let bestMatch = null;
        let bestDiff = Infinity;

        for (const tgtTax of targetTaxes) {
          const diff = Math.abs(tgtTax.amount - srcRate);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestMatch = tgtTax;
          }
        }

        if (bestMatch) {
          TAX_MAPPINGS[sourceCountry][targetCountry][srcTax.id] = bestMatch.id;
        }
      }
    }
  }

  return { taxesByCountry, allTaxes };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const journalFilter = args.find(a => a.startsWith('--journal='));
  const filterJournal = journalFilter ? journalFilter.split('=')[1] : null;

  console.log('='.repeat(70));
  console.log('Fix All Wrong Taxes Across V* Journals');
  console.log('='.repeat(70));
  console.log('Mode:', dryRun ? 'DRY RUN' : 'LIVE');
  if (filterJournal) console.log('Journal filter:', filterJournal);
  console.log('');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Build tax mappings
  console.log('Building tax mappings...');
  const { taxesByCountry, allTaxes } = await buildTaxMappings(odoo);

  const taxNames = {};
  for (const t of allTaxes) taxNames[t.id] = t.name;

  // Get all V* journals
  const journals = await odoo.searchRead('account.journal',
    [['code', 'like', 'V%'], ['type', '=', 'sale']],
    ['id', 'code', 'name'],
    { limit: 20 }
  );

  let totalFixed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const journal of journals) {
    const expectedCountry = JOURNAL_TAX_COUNTRY[journal.code];
    if (!expectedCountry) {
      console.log('\nSkipping', journal.code, '(no expected country defined)');
      continue;
    }

    if (filterJournal && journal.code !== filterJournal) continue;

    console.log('\n' + '='.repeat(70));
    console.log('Processing', journal.code, '(' + journal.name + ')');
    console.log('Expected taxes:', expectedCountry + '*');
    console.log('='.repeat(70));

    // Get all posted invoices since Dec 1
    const invoices = await odoo.searchRead('account.move',
      [
        ['journal_id', '=', journal.id],
        ['move_type', '=', 'out_invoice'],
        ['state', '=', 'posted'],
        ['invoice_date', '>=', '2025-12-01']
      ],
      ['id', 'name', 'payment_state'],
      { limit: 5000 }
    );

    console.log('Total invoices:', invoices.length);

    // Find invoices with wrong taxes
    const wrongInvoices = [];

    for (let i = 0; i < invoices.length; i++) {
      const inv = invoices[i];
      if (i > 0 && i % 500 === 0) {
        console.log('  Checked', i, '/', invoices.length, '...');
      }

      const lines = await odoo.searchRead('account.move.line',
        [['move_id', '=', inv.id], ['display_type', '=', 'product']],
        ['id', 'tax_ids'],
        { limit: 50 }
      );

      // Check if any line has wrong country tax
      const wrongLines = [];
      for (const line of lines) {
        if (!line.tax_ids || line.tax_ids.length === 0) continue;

        for (const taxId of line.tax_ids) {
          const taxName = taxNames[taxId] || '';
          const taxCountryMatch = taxName.match(/^([A-Z]{2})\*/);
          if (taxCountryMatch && taxCountryMatch[1] !== expectedCountry) {
            wrongLines.push({ lineId: line.id, taxIds: line.tax_ids, wrongTaxId: taxId });
            break;
          }
        }
      }

      if (wrongLines.length > 0) {
        wrongInvoices.push({ ...inv, wrongLines });
      }
    }

    console.log('Invoices with wrong taxes:', wrongInvoices.length);

    if (wrongInvoices.length === 0) {
      console.log('✓ No fixes needed');
      continue;
    }

    // Process each wrong invoice
    let fixed = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < wrongInvoices.length; i++) {
      const inv = wrongInvoices[i];

      if (i < 5 || i % 100 === 0) {
        console.log('\n[' + (i + 1) + '/' + wrongInvoices.length + '] ' + inv.name);
      }

      // Skip if paid
      if (inv.payment_state !== 'not_paid') {
        if (i < 5) console.log('  ⚠ SKIPPED - has payments');
        skipped++;
        continue;
      }

      // Calculate new taxes for each wrong line
      const lineUpdates = [];
      for (const wl of inv.wrongLines) {
        const newTaxIds = [];
        let hasChanges = false;

        for (const taxId of wl.taxIds) {
          const taxName = taxNames[taxId] || '';
          const taxCountryMatch = taxName.match(/^([A-Z]{2})\*/);

          if (taxCountryMatch && taxCountryMatch[1] !== expectedCountry) {
            const sourceCountry = taxCountryMatch[1];
            const mapping = TAX_MAPPINGS[sourceCountry]?.[expectedCountry];
            const newTaxId = mapping?.[taxId];

            if (newTaxId) {
              newTaxIds.push(newTaxId);
              hasChanges = true;
              if (i < 5) {
                console.log('  Line ' + wl.lineId + ': ' + taxName + ' → ' + taxNames[newTaxId]);
              }
            } else {
              newTaxIds.push(taxId); // Keep original if no mapping
              if (i < 5) {
                console.log('  Line ' + wl.lineId + ': ' + taxName + ' → NO MAPPING');
              }
            }
          } else {
            newTaxIds.push(taxId);
          }
        }

        if (hasChanges) {
          lineUpdates.push({ lineId: wl.lineId, newTaxIds });
        }
      }

      if (lineUpdates.length === 0) {
        skipped++;
        continue;
      }

      if (dryRun) {
        if (i < 5) console.log('  [DRY RUN] Would update', lineUpdates.length, 'lines');
        fixed++;
        continue;
      }

      // Actually fix the invoice
      try {
        // Reset to draft
        try {
          await odoo.execute('account.move', 'button_draft', [[inv.id]]);
        } catch (e) {
          if (!e.message.includes('cannot marshal None')) throw e;
        }

        // Update taxes
        for (const { lineId, newTaxIds } of lineUpdates) {
          await odoo.execute('account.move.line', 'write', [[lineId], {
            tax_ids: [[6, 0, newTaxIds]]
          }]);
        }

        // Re-post
        try {
          await odoo.execute('account.move', 'action_post', [[inv.id]]);
        } catch (e) {
          if (!e.message.includes('cannot marshal None')) throw e;
        }

        if (i < 5) console.log('  ✓ Fixed');
        fixed++;

      } catch (error) {
        if (i < 5) console.log('  ✗ ERROR:', error.message);
        failed++;
      }
    }

    console.log('\n' + journal.code + ' Summary: Fixed=' + fixed + ', Failed=' + failed + ', Skipped=' + skipped);
    totalFixed += fixed;
    totalFailed += failed;
    totalSkipped += skipped;
  }

  console.log('\n' + '='.repeat(70));
  console.log('TOTAL SUMMARY');
  console.log('='.repeat(70));
  console.log('Fixed:', totalFixed);
  console.log('Failed:', totalFailed);
  console.log('Skipped:', totalSkipped);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
