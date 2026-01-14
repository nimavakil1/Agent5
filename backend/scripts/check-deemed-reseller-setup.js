require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkDeemedResellerSetup() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // 1. Check for 0% tax codes that could be used for deemed reseller
  console.log('========================================');
  console.log('CHECKING TAX CODES');
  console.log('========================================\n');

  const taxes = await odoo.searchRead('account.tax',
    [['amount', '=', 0]],
    ['id', 'name', 'amount', 'type_tax_use', 'description', 'active'],
    { limit: 100 }
  );

  console.log('0% Tax codes found:', taxes.length);
  for (const tax of taxes) {
    console.log('  ID:', tax.id, '| Name:', tax.name);
    console.log('    Type:', tax.type_tax_use, '| Active:', tax.active);
    console.log('    Description:', tax.description || 'N/A');
    console.log('');
  }

  // Also check for taxes with "deemed" or "reseller" or "marketplace" in the name
  const deemedTaxes = await odoo.searchRead('account.tax',
    ['|', '|', ['name', 'ilike', 'deemed'], ['name', 'ilike', 'reseller'], ['name', 'ilike', 'marketplace']],
    ['id', 'name', 'amount', 'type_tax_use', 'description', 'active'],
    { limit: 100 }
  );

  if (deemedTaxes.length > 0) {
    console.log('\nTaxes with "deemed/reseller/marketplace" in name:');
    for (const tax of deemedTaxes) {
      console.log('  ID:', tax.id, '| Name:', tax.name, '| Amount:', tax.amount + '%');
    }
  } else {
    console.log('\nNo taxes found with "deemed/reseller/marketplace" in name');
  }

  // 2. Check for Amazon UK partner by VAT number
  console.log('\n========================================');
  console.log('CHECKING FOR AMAZON UK PARTNER');
  console.log('========================================\n');

  // Amazon UK VAT number is GB727255821
  const amazonVatNumbers = ['GB727255821', '727255821', 'GB 727 255 821'];

  for (const vat of amazonVatNumbers) {
    const partners = await odoo.searchRead('res.partner',
      [['vat', 'ilike', vat]],
      ['id', 'name', 'vat', 'is_company', 'country_id'],
      { limit: 10 }
    );

    if (partners.length > 0) {
      console.log('Found partners with VAT like "' + vat + '":');
      for (const p of partners) {
        console.log('  ID:', p.id, '| Name:', p.name);
        console.log('    VAT:', p.vat, '| Company:', p.is_company);
        console.log('    Country:', p.country_id ? p.country_id[1] : 'N/A');
      }
    }
  }

  // Also search by name
  const amazonPartners = await odoo.searchRead('res.partner',
    [['name', 'ilike', 'amazon']],
    ['id', 'name', 'vat', 'is_company', 'country_id', 'active'],
    { limit: 20 }
  );

  console.log('\nPartners with "Amazon" in name:', amazonPartners.length);
  for (const p of amazonPartners) {
    console.log('  ID:', p.id, '| Name:', p.name);
    console.log('    VAT:', p.vat || 'N/A', '| Company:', p.is_company, '| Active:', p.active);
    console.log('    Country:', p.country_id ? p.country_id[1] : 'N/A');
    console.log('');
  }

  // 3. Check fiscal positions for deemed reseller
  console.log('\n========================================');
  console.log('CHECKING FISCAL POSITIONS');
  console.log('========================================\n');

  const fiscalPositions = await odoo.searchRead('account.fiscal.position',
    [],
    ['id', 'name', 'auto_apply', 'country_id', 'vat_required'],
    { limit: 50 }
  );

  console.log('Fiscal positions:', fiscalPositions.length);
  for (const fp of fiscalPositions) {
    console.log('  ID:', fp.id, '| Name:', fp.name);
    console.log('    Auto-apply:', fp.auto_apply, '| VAT required:', fp.vat_required);
    console.log('    Country:', fp.country_id ? fp.country_id[1] : 'Any');
    console.log('');
  }
}

checkDeemedResellerSetup().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
