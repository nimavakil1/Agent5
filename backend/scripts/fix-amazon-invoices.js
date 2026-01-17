require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');

// Load VCS data from our lookup
const vcsResults = JSON.parse(fs.readFileSync('/tmp/vcs_complete_lookup.json', 'utf-8'));
const vcsMap = new Map();
for (const item of vcsResults.found) {
  vcsMap.set(item.orderId, item);
}

// Add the 2 missing orders (user provided info: dispatched from IT)
vcsMap.set('402-6819718-3689940', {
  orderId: '402-6819718-3689940',
  marketplace: 'DE',
  shipFromCountry: 'IT',
  shipToCountry: 'DE',
  taxScheme: 'VCS_EU_OSS',
  currency: 'EUR'
});
vcsMap.set('405-7668060-9687549', {
  orderId: '405-7668060-9687549',
  marketplace: 'FR',
  shipFromCountry: 'IT',
  shipToCountry: 'FR',
  taxScheme: 'VCS_EU_OSS',
  currency: 'EUR'
});

// VAT rates by country
const VAT_RATES = {
  'DE': 19,
  'FR': 20,
  'BE': 21,
  'IT': 22,
  'NL': 21,
  'ES': 21,
  'PL': 23,
  'AT': 20,
  'SE': 25,
  'CZ': 21,
  'GB': 20
};

async function fixAmazonInvoices() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('========================================');
  console.log('FIXING AMAZON INVOICES');
  console.log('========================================\n');

  // Step 1: Get all available fiscal positions
  console.log('Loading fiscal positions...');
  const fiscalPositions = await odoo.searchRead('account.fiscal.position',
    [],
    ['id', 'name'],
    { limit: 200 }
  );

  const fpByCountry = { domestic: {}, oss: {} };

  for (const fp of fiscalPositions) {
    // Parse fiscal position names
    // Format: "DE*VAT | Régime National", "FR*OSS | B2C France (TxIn)"
    const match = fp.name.match(/^([A-Z]{2})\*(VAT|OSS)/);
    if (match) {
      const country = match[1];
      const type = match[2];
      if (type === 'VAT' && (fp.name.includes('National') || fp.name.includes('Régime'))) {
        fpByCountry.domestic[country] = { id: fp.id, name: fp.name };
      } else if (type === 'OSS') {
        fpByCountry.oss[country] = { id: fp.id, name: fp.name };
      }
    }
  }

  console.log('Domestic FP:', Object.keys(fpByCountry.domestic).join(', '));
  console.log('OSS FP:', Object.keys(fpByCountry.oss).join(', '));

  // Step 2: Get all available taxes
  console.log('\nLoading taxes...');
  const taxes = await odoo.searchRead('account.tax',
    [['type_tax_use', '=', 'sale']],
    ['id', 'name', 'amount', 'country_id'],
    { limit: 500 }
  );

  const taxByCountryRate = {};
  for (const tax of taxes) {
    // Format: "DE*VAT | 19% (Goods)", "FR*OSS | 20%"
    const match = tax.name.match(/^([A-Z]{2})\*(VAT|OSS)\s*\|\s*(\d+)%/);
    if (match) {
      const country = match[1];
      const type = match[2];
      const rate = parseInt(match[3]);
      const key = `${country}_${rate}_${type}`;
      taxByCountryRate[key] = { id: tax.id, name: tax.name, rate, country, type };
    }
  }

  console.log('Tax mappings:', Object.keys(taxByCountryRate).length);
  console.log('Available:', Object.keys(taxByCountryRate).join(', '));

  // Step 3: Get all sales teams
  console.log('\nLoading sales teams...');
  const teams = await odoo.searchRead('crm.team',
    [],
    ['id', 'name'],
    { limit: 50 }
  );

  const teamByMarketplace = {};
  for (const team of teams) {
    if (team.name.includes('Amazon')) {
      if (team.name.includes(' DE')) teamByMarketplace['DE'] = { id: team.id, name: team.name };
      if (team.name.includes(' FR')) teamByMarketplace['FR'] = { id: team.id, name: team.name };
      if (team.name.includes(' UK') || team.name.includes(' GB')) {
        teamByMarketplace['GB'] = { id: team.id, name: team.name };
        teamByMarketplace['UK'] = { id: team.id, name: team.name };
      }
      if (team.name.includes(' IT')) teamByMarketplace['IT'] = { id: team.id, name: team.name };
      if (team.name.includes(' ES')) teamByMarketplace['ES'] = { id: team.id, name: team.name };
      if (team.name.includes(' NL')) teamByMarketplace['NL'] = { id: team.id, name: team.name };
      if (team.name.includes(' BE')) teamByMarketplace['BE'] = { id: team.id, name: team.name };
      if (team.name.includes(' PL')) teamByMarketplace['PL'] = { id: team.id, name: team.name };
      if (team.name.includes(' SE')) teamByMarketplace['SE'] = { id: team.id, name: team.name };
    }
  }

  console.log('Team mappings:', Object.entries(teamByMarketplace).map(([k,v]) => `${k}=${v.id}`).join(', '));

  // Step 4: Get all Amazon invoices with FBA pattern
  console.log('\nLoading Amazon invoices (FBA pattern)...');
  const invoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['ref', 'like', 'FBA%-%-%'],
      ['create_date', '>=', '2026-01-10'],
      ['create_date', '<=', '2026-01-15 23:59:59']
    ],
    ['id', 'name', 'ref', 'state', 'team_id', 'fiscal_position_id', 'amount_total'],
    { limit: 500 }
  );

  // Also get the 2 special invoices with direct order IDs
  const specialInvoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['ref', 'in', ['402-6819718-3689940', '405-7668060-9687549']]
    ],
    ['id', 'name', 'ref', 'state', 'team_id', 'fiscal_position_id', 'amount_total'],
    { limit: 10 }
  );

  const allInvoices = [...invoices, ...specialInvoices];
  console.log('Total Amazon invoices found:', allInvoices.length);

  // Step 5: Process each invoice
  console.log('\n========================================');
  console.log('PROCESSING INVOICES');
  console.log('========================================\n');

  const results = {
    updated: [],
    skipped: [],
    errors: [],
    noVcsData: []
  };

  for (const inv of allInvoices) {
    // Extract Amazon order ID from ref
    // Format: "FBA407-7977232-3148356 - Balance correction" or "402-6819718-3689940"
    const ref = inv.ref || '';
    let orderId = null;

    // Try FBA format first
    const fbaMatch = ref.match(/FBA(\d{3}-\d{7}-\d{7})/);
    if (fbaMatch) {
      orderId = fbaMatch[1];
    } else {
      // Try direct order ID format
      const directMatch = ref.match(/(\d{3}-\d{7}-\d{7})/);
      if (directMatch) {
        orderId = directMatch[1];
      }
    }

    if (!orderId) {
      console.log(`Skipping ${inv.name} - cannot extract order ID from ref: ${ref}`);
      continue;
    }

    const vcs = vcsMap.get(orderId);

    if (!vcs) {
      results.noVcsData.push({ invoiceId: inv.id, invoiceName: inv.name, orderId, ref });
      console.log(`${inv.name} | ${orderId} - NO VCS DATA`);
      continue;
    }

    const marketplace = vcs.marketplace;
    const shipFrom = vcs.shipFromCountry;
    const shipTo = vcs.shipToCountry;
    const isDomestic = shipFrom === shipTo;

    // Determine expected values
    const expectedTeam = teamByMarketplace[marketplace];

    let expectedFp;
    if (isDomestic) {
      expectedFp = fpByCountry.domestic[shipTo];
    } else {
      expectedFp = fpByCountry.oss[shipTo];
    }

    // Get expected tax for invoice lines
    const vatRate = VAT_RATES[shipTo] || 19;
    const taxType = isDomestic ? 'VAT' : 'OSS';
    let expectedTax = taxByCountryRate[`${shipTo}_${vatRate}_${taxType}`];

    // Fallback: try to find any tax for the destination country
    if (!expectedTax) {
      const fallbackKey = Object.keys(taxByCountryRate).find(k => k.startsWith(`${shipTo}_${vatRate}`));
      if (fallbackKey) {
        expectedTax = taxByCountryRate[fallbackKey];
      }
    }

    // Check current values
    const currentTeamId = inv.team_id ? inv.team_id[0] : null;
    const currentFpId = inv.fiscal_position_id ? inv.fiscal_position_id[0] : null;

    const needsTeamUpdate = expectedTeam && currentTeamId !== expectedTeam.id;
    const needsFpUpdate = expectedFp && currentFpId !== expectedFp.id;

    console.log(`${inv.name} | ${orderId}`);
    console.log(`  Route: ${shipFrom} -> ${shipTo} | MP: ${marketplace} | ${isDomestic ? 'Domestic' : 'OSS'}`);

    if (needsTeamUpdate) {
      console.log(`  Team: ${inv.team_id ? inv.team_id[1] : 'None'} -> ${expectedTeam.name}`);
    }
    if (needsFpUpdate) {
      console.log(`  FP: ${inv.fiscal_position_id ? inv.fiscal_position_id[1] : 'None'} -> ${expectedFp.name}`);
    }
    if (expectedTax) {
      console.log(`  Tax: ${expectedTax.name}`);
    }

    // Build update object
    const updates = {};

    if (needsTeamUpdate) {
      updates.team_id = expectedTeam.id;
    }

    if (needsFpUpdate) {
      updates.fiscal_position_id = expectedFp.id;
    }

    const isPosted = inv.state === 'posted';

    if (Object.keys(updates).length > 0 || expectedTax) {
      try {
        // If posted, reset to draft
        if (isPosted) {
          try {
            await odoo.execute('account.move', 'button_draft', [[inv.id]]);
          } catch (e) {
            // button_draft returns None which causes XML-RPC error, but action succeeds
            if (!e.message.includes('cannot marshal None')) {
              throw e;
            }
          }
          console.log('  -> Reset to draft');
        }

        // Update invoice header
        if (Object.keys(updates).length > 0) {
          await odoo.write('account.move', [inv.id], updates);
          console.log('  -> Updated header');
        }

        // Update invoice line taxes
        if (expectedTax) {
          const lines = await odoo.searchRead('account.move.line',
            [['move_id', '=', inv.id], ['display_type', '=', 'product']],
            ['id', 'tax_ids'],
            { limit: 50 }
          );

          for (const line of lines) {
            await odoo.write('account.move.line', [line.id], {
              tax_ids: [[6, 0, [expectedTax.id]]]
            });
          }
          console.log(`  -> Updated ${lines.length} lines with tax`);
        }

        // Repost if was posted
        if (isPosted) {
          try {
            await odoo.execute('account.move', 'action_post', [[inv.id]]);
          } catch (e) {
            if (!e.message.includes('cannot marshal None')) {
              throw e;
            }
          }
          console.log('  -> Reposted');
        }

        results.updated.push({
          invoiceId: inv.id,
          invoiceName: inv.name,
          orderId,
          marketplace,
          route: `${shipFrom} -> ${shipTo}`,
          updates: Object.keys(updates),
          taxUpdated: !!expectedTax
        });

      } catch (error) {
        console.log('  -> ERROR:', error.message);
        results.errors.push({
          invoiceId: inv.id,
          invoiceName: inv.name,
          orderId,
          error: error.message
        });
      }
    } else {
      results.skipped.push({
        invoiceId: inv.id,
        invoiceName: inv.name,
        orderId,
        reason: 'No changes needed or missing mappings'
      });
      console.log('  -> Skipped');
    }

    console.log('');
  }

  // Summary
  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log('Total processed:', allInvoices.length);
  console.log('Updated:', results.updated.length);
  console.log('Skipped:', results.skipped.length);
  console.log('Errors:', results.errors.length);
  console.log('No VCS data:', results.noVcsData.length);

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.forEach(e => console.log(`  ${e.invoiceName}: ${e.error}`));
  }

  if (results.noVcsData.length > 0) {
    console.log('\nNo VCS data (first 20):');
    results.noVcsData.slice(0, 20).forEach(e => console.log(`  ${e.invoiceName}: ${e.orderId}`));
  }

  // Save results
  fs.writeFileSync('/tmp/amazon_invoice_fix_results.json', JSON.stringify(results, null, 2));
  console.log('\nResults saved to /tmp/amazon_invoice_fix_results.json');
}

fixAmazonInvoices().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
