/**
 * Check CZ*VAT and PL*VAT tax configuration
 * Why don't they have proper tax tags?
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Checking CZ and PL VAT Tax Configuration ===\n');

  // Get CZ and PL taxes
  const taxes = await odoo.searchRead('account.tax',
    [['name', 'like', '%*VAT%'], ['type_tax_use', '=', 'sale']],
    ['id', 'name', 'amount', 'invoice_repartition_line_ids', 'country_id'],
    { limit: 100 }
  );

  // Filter for CZ and PL
  const czPlTaxes = taxes.filter(t => t.name.startsWith('CZ*') || t.name.startsWith('PL*'));

  console.log('CZ/PL Sale Taxes found:', czPlTaxes.length);

  for (const tax of czPlTaxes) {
    console.log('\n--- ' + tax.name + ' (ID: ' + tax.id + ') ---');
    console.log('Amount:', tax.amount + '%');
    console.log('Country:', tax.country_id ? tax.country_id[1] : 'None');
    console.log('Repartition line IDs:', tax.invoice_repartition_line_ids);

    // Get the repartition lines to see their tags
    if (tax.invoice_repartition_line_ids && tax.invoice_repartition_line_ids.length > 0) {
      const repLines = await odoo.searchRead('account.tax.repartition.line',
        [['id', 'in', tax.invoice_repartition_line_ids]],
        ['id', 'repartition_type', 'tag_ids', 'account_id', 'factor_percent'],
        { limit: 20 }
      );

      console.log('Repartition lines:');
      for (const rl of repLines) {
        const tagNames = [];
        if (rl.tag_ids && rl.tag_ids.length > 0) {
          const tags = await odoo.searchRead('account.account.tag',
            [['id', 'in', rl.tag_ids]],
            ['id', 'name'],
            { limit: 20 }
          );
          for (const t of tags) tagNames.push(t.name);
        }
        console.log('  - Type:', rl.repartition_type, '| Factor:', rl.factor_percent + '%', '| Tags:', tagNames.length > 0 ? tagNames.join(', ') : 'NONE');
      }
    }
  }

  // Compare with a working tax (e.g., BE*VAT 21%)
  console.log('\n\n=== Comparing with BE*VAT 21% (working tax) ===\n');

  const beTax = taxes.find(t => t.name.includes('BE*VAT') && t.name.includes('21'));
  if (beTax) {
    console.log('--- ' + beTax.name + ' (ID: ' + beTax.id + ') ---');
    console.log('Country:', beTax.country_id ? beTax.country_id[1] : 'None');

    if (beTax.invoice_repartition_line_ids && beTax.invoice_repartition_line_ids.length > 0) {
      const repLines = await odoo.searchRead('account.tax.repartition.line',
        [['id', 'in', beTax.invoice_repartition_line_ids]],
        ['id', 'repartition_type', 'tag_ids', 'account_id', 'factor_percent'],
        { limit: 20 }
      );

      console.log('Repartition lines:');
      for (const rl of repLines) {
        const tagNames = [];
        if (rl.tag_ids && rl.tag_ids.length > 0) {
          const tags = await odoo.searchRead('account.account.tag',
            [['id', 'in', rl.tag_ids]],
            ['id', 'name'],
            { limit: 20 }
          );
          for (const t of tags) tagNames.push(t.name);
        }
        console.log('  - Type:', rl.repartition_type, '| Factor:', rl.factor_percent + '%', '| Tags:', tagNames.length > 0 ? tagNames.join(', ') : 'NONE');
      }
    }
  }

  // Check also ES*OSS and the battery tax
  console.log('\n\n=== Checking ES*OSS and Battery Tax ===\n');

  const esOss = taxes.find(t => t.name.includes('ES*OSS') && t.name.includes('21'));
  if (esOss) {
    console.log('--- ' + esOss.name + ' (ID: ' + esOss.id + ') ---');
    if (esOss.invoice_repartition_line_ids && esOss.invoice_repartition_line_ids.length > 0) {
      const repLines = await odoo.searchRead('account.tax.repartition.line',
        [['id', 'in', esOss.invoice_repartition_line_ids]],
        ['id', 'repartition_type', 'tag_ids'],
        { limit: 20 }
      );
      for (const rl of repLines) {
        const tagNames = [];
        if (rl.tag_ids && rl.tag_ids.length > 0) {
          const tags = await odoo.searchRead('account.account.tag',
            [['id', 'in', rl.tag_ids]],
            ['id', 'name'],
            { limit: 20 }
          );
          for (const t of tags) tagNames.push(t.name);
        }
        console.log('  - Type:', rl.repartition_type, '| Tags:', tagNames.length > 0 ? tagNames.join(', ') : 'NONE');
      }
    }
  }

  // Check battery tax
  const batteryTaxes = await odoo.searchRead('account.tax',
    [['name', 'like', 'BE*BEB%'], ['type_tax_use', '=', 'sale']],
    ['id', 'name', 'invoice_repartition_line_ids'],
    { limit: 10 }
  );

  for (const tax of batteryTaxes.slice(0, 2)) {
    console.log('\n--- ' + tax.name + ' (ID: ' + tax.id + ') ---');
    if (tax.invoice_repartition_line_ids && tax.invoice_repartition_line_ids.length > 0) {
      const repLines = await odoo.searchRead('account.tax.repartition.line',
        [['id', 'in', tax.invoice_repartition_line_ids]],
        ['id', 'repartition_type', 'tag_ids'],
        { limit: 20 }
      );
      for (const rl of repLines) {
        const tagNames = [];
        if (rl.tag_ids && rl.tag_ids.length > 0) {
          const tags = await odoo.searchRead('account.account.tag',
            [['id', 'in', rl.tag_ids]],
            ['id', 'name'],
            { limit: 20 }
          );
          for (const t of tags) tagNames.push(t.name);
        }
        console.log('  - Type:', rl.repartition_type, '| Tags:', tagNames.length > 0 ? tagNames.join(', ') : 'NONE');
      }
    }
  }
}

main().catch(console.error);
