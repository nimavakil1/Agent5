/**
 * Setup CZ and PL VAT tax tags for proper VAT reporting
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Setting up CZ and PL VAT Tax Tags ===\n');

  // Check existing tax tags
  const existingTags = await odoo.searchRead('account.account.tag',
    [['applicability', '=', 'taxes']],
    ['id', 'name', 'country_id'],
    { limit: 500 }
  );

  console.log('Existing tax tags:', existingTags.length);

  // Filter for CZ and PL
  const czTags = existingTags.filter(t => t.country_id && t.country_id[1] === 'Czech Republic');
  const plTags = existingTags.filter(t => t.country_id && t.country_id[1] === 'Poland');

  console.log('CZ tax tags:', czTags.length);
  console.log('PL tax tags:', plTags.length);

  if (czTags.length > 0) {
    console.log('\nExisting CZ tags:');
    for (const t of czTags.slice(0, 10)) {
      console.log('  - ' + t.name + ' (ID: ' + t.id + ')');
    }
  }

  if (plTags.length > 0) {
    console.log('\nExisting PL tags:');
    for (const t of plTags.slice(0, 10)) {
      console.log('  - ' + t.name + ' (ID: ' + t.id + ')');
    }
  }

  // Get country IDs
  const countries = await odoo.searchRead('res.country',
    [['code', 'in', ['CZ', 'PL']]],
    ['id', 'code', 'name'],
    { limit: 5 }
  );

  const czCountry = countries.find(c => c.code === 'CZ');
  const plCountry = countries.find(c => c.code === 'PL');

  console.log('\nCountries:', czCountry?.name, '(ID:', czCountry?.id + '),', plCountry?.name, '(ID:', plCountry?.id + ')');

  // Create tags if they don't exist
  let czBaseTaxTag, czTaxTag, plBaseTaxTag, plTaxTag;

  // CZ tags
  if (czTags.length === 0) {
    console.log('\nCreating CZ tax tags...');

    // Create base tag (for base amount)
    const czBaseTagId = await odoo.create('account.account.tag', {
      name: '+CZ_BASE',
      applicability: 'taxes',
      country_id: czCountry.id,
      active: true
    });
    console.log('  Created +CZ_BASE (ID:', czBaseTagId + ')');

    // Create tax tag (for tax amount)
    const czTaxTagId = await odoo.create('account.account.tag', {
      name: '+CZ_TAX',
      applicability: 'taxes',
      country_id: czCountry.id,
      active: true
    });
    console.log('  Created +CZ_TAX (ID:', czTaxTagId + ')');

    czBaseTaxTag = czBaseTagId;
    czTaxTag = czTaxTagId;
  } else {
    // Use existing tags - find base and tax tags
    czBaseTaxTag = czTags.find(t => t.name.toLowerCase().includes('base'))?.id || czTags[0]?.id;
    czTaxTag = czTags.find(t => t.name.toLowerCase().includes('tax') && !t.name.toLowerCase().includes('base'))?.id || czTags[0]?.id;
    console.log('\nUsing existing CZ tags:', czBaseTaxTag, czTaxTag);
  }

  // PL tags
  if (plTags.length === 0) {
    console.log('\nCreating PL tax tags...');

    // Create base tag
    const plBaseTagId = await odoo.create('account.account.tag', {
      name: '+PL_BASE',
      applicability: 'taxes',
      country_id: plCountry.id,
      active: true
    });
    console.log('  Created +PL_BASE (ID:', plBaseTagId + ')');

    // Create tax tag
    const plTaxTagId = await odoo.create('account.account.tag', {
      name: '+PL_TAX',
      applicability: 'taxes',
      country_id: plCountry.id,
      active: true
    });
    console.log('  Created +PL_TAX (ID:', plTaxTagId + ')');

    plBaseTaxTag = plBaseTagId;
    plTaxTag = plTaxTagId;
  } else {
    plBaseTaxTag = plTags.find(t => t.name.toLowerCase().includes('base'))?.id || plTags[0]?.id;
    plTaxTag = plTags.find(t => t.name.toLowerCase().includes('tax') && !t.name.toLowerCase().includes('base'))?.id || plTags[0]?.id;
    console.log('\nUsing existing PL tags:', plBaseTaxTag, plTaxTag);
  }

  // Now update the CZ*VAT and PL*VAT taxes with these tags
  console.log('\n=== Updating CZ*VAT taxes ===');

  const czTaxes = await odoo.searchRead('account.tax',
    [['name', 'like', 'CZ*VAT%'], ['type_tax_use', '=', 'sale']],
    ['id', 'name', 'invoice_repartition_line_ids'],
    { limit: 20 }
  );

  for (const tax of czTaxes) {
    console.log('\nUpdating:', tax.name);
    const repLines = await odoo.searchRead('account.tax.repartition.line',
      [['id', 'in', tax.invoice_repartition_line_ids]],
      ['id', 'repartition_type', 'tag_ids'],
      { limit: 10 }
    );

    for (const rl of repLines) {
      if (rl.tag_ids && rl.tag_ids.length > 0) {
        console.log('  ' + rl.repartition_type + ' already has tags');
        continue;
      }

      const newTags = rl.repartition_type === 'base' ? [czBaseTaxTag] : [czTaxTag];
      console.log('  Updating ' + rl.repartition_type + ' with tags:', newTags);
      await odoo.write('account.tax.repartition.line', [rl.id], {
        tag_ids: [[6, 0, newTags]]
      });
    }
  }

  console.log('\n=== Updating PL*VAT taxes ===');

  const plTaxes = await odoo.searchRead('account.tax',
    [['name', 'like', 'PL*VAT%'], ['type_tax_use', '=', 'sale']],
    ['id', 'name', 'invoice_repartition_line_ids'],
    { limit: 20 }
  );

  for (const tax of plTaxes) {
    console.log('\nUpdating:', tax.name);
    const repLines = await odoo.searchRead('account.tax.repartition.line',
      [['id', 'in', tax.invoice_repartition_line_ids]],
      ['id', 'repartition_type', 'tag_ids'],
      { limit: 10 }
    );

    for (const rl of repLines) {
      if (rl.tag_ids && rl.tag_ids.length > 0) {
        console.log('  ' + rl.repartition_type + ' already has tags');
        continue;
      }

      const newTags = rl.repartition_type === 'base' ? [plBaseTaxTag] : [plTaxTag];
      console.log('  Updating ' + rl.repartition_type + ' with tags:', newTags);
      await odoo.write('account.tax.repartition.line', [rl.id], {
        tag_ids: [[6, 0, newTags]]
      });
    }
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
