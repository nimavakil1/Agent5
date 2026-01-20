/**
 * Fix ES*OSS Included taxes - add missing OSS tags
 * Copy tags from regular ES*OSS taxes to Included variants
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fixing OSS Included Tax Tags ===\n');

  // Get all OSS taxes (both regular and Included)
  const ossTaxes = await odoo.searchRead('account.tax',
    [['name', 'like', '%OSS%'], ['type_tax_use', '=', 'sale']],
    ['id', 'name', 'invoice_repartition_line_ids'],
    { limit: 100 }
  );

  console.log('Found', ossTaxes.length, 'OSS sale taxes');

  // Separate regular and Included taxes
  const regularTaxes = ossTaxes.filter(t => !t.name.includes('Included'));
  const includedTaxes = ossTaxes.filter(t => t.name.includes('Included'));

  console.log('Regular OSS taxes:', regularTaxes.length);
  console.log('Included OSS taxes:', includedTaxes.length);

  // Get the OSS tag IDs from a regular tax
  const sampleRegular = regularTaxes.find(t => t.name.includes('21.0%'));
  if (!sampleRegular) {
    console.error('Could not find a regular OSS 21% tax to copy tags from');
    return;
  }

  const regularRepLines = await odoo.searchRead('account.tax.repartition.line',
    [['id', 'in', sampleRegular.invoice_repartition_line_ids]],
    ['id', 'repartition_type', 'tag_ids'],
    { limit: 10 }
  );

  const baseTags = regularRepLines.find(r => r.repartition_type === 'base')?.tag_ids || [];
  const taxTags = regularRepLines.find(r => r.repartition_type === 'tax')?.tag_ids || [];

  console.log('\nTags from', sampleRegular.name + ':');
  console.log('  Base tags:', baseTags);
  console.log('  Tax tags:', taxTags);

  if (baseTags.length === 0 && taxTags.length === 0) {
    console.error('No tags found on regular OSS tax!');
    return;
  }

  // Fix each Included tax
  let fixed = 0;
  for (const tax of includedTaxes) {
    console.log('\nProcessing:', tax.name);

    const repLines = await odoo.searchRead('account.tax.repartition.line',
      [['id', 'in', tax.invoice_repartition_line_ids]],
      ['id', 'repartition_type', 'tag_ids'],
      { limit: 10 }
    );

    for (const rl of repLines) {
      const currentTags = rl.tag_ids || [];
      let newTags;

      if (rl.repartition_type === 'base') {
        newTags = baseTags;
      } else if (rl.repartition_type === 'tax') {
        newTags = taxTags;
      } else {
        continue;
      }

      if (currentTags.length === 0 && newTags.length > 0) {
        console.log('  Updating', rl.repartition_type, 'line (ID:', rl.id + ') with tags:', newTags);
        await odoo.write('account.tax.repartition.line', [rl.id], {
          tag_ids: [[6, 0, newTags]]
        });
        fixed++;
      } else if (currentTags.length > 0) {
        console.log('  ', rl.repartition_type, 'line already has tags:', currentTags);
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log('Fixed', fixed, 'repartition lines');

  // Verify by checking one of the fixed taxes
  if (includedTaxes.length > 0) {
    console.log('\nVerifying fix on', includedTaxes[0].name + ':');
    const verifyLines = await odoo.searchRead('account.tax.repartition.line',
      [['id', 'in', includedTaxes[0].invoice_repartition_line_ids]],
      ['id', 'repartition_type', 'tag_ids'],
      { limit: 10 }
    );
    for (const rl of verifyLines) {
      console.log('  ', rl.repartition_type, '| Tags:', rl.tag_ids);
    }
  }
}

main().catch(console.error);
