require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function createDeemedResellerTax() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // First check if it already exists
  const existing = await odoo.searchRead('account.tax',
    [['name', '=', 'GB*VAT | 0% Deemed Reseller']],
    ['id', 'name'],
    { limit: 1 }
  );

  if (existing.length > 0) {
    console.log('Tax code already exists:');
    console.log('  ID:', existing[0].id);
    console.log('  Name:', existing[0].name);
    return;
  }

  // Get the company ID (should be the main company)
  const companies = await odoo.searchRead('res.company',
    [],
    ['id', 'name'],
    { limit: 1 }
  );
  const companyId = companies[0].id;
  console.log('Company:', companies[0].name, '(ID:', companyId, ')');

  // Get an existing 0% tax to use as reference for account settings
  const refTax = await odoo.searchRead('account.tax',
    [['name', '=', 'GB*VAT | 0% EX']],
    ['id', 'name', 'invoice_repartition_line_ids', 'refund_repartition_line_ids', 'tax_group_id'],
    { limit: 1 }
  );

  if (refTax.length === 0) {
    console.log('Reference tax GB*VAT | 0% EX not found, trying BE*VAT | 0%');
    const refTax2 = await odoo.searchRead('account.tax',
      [['name', '=', 'BE*VAT | 0%']],
      ['id', 'name', 'tax_group_id'],
      { limit: 1 }
    );
    if (refTax2.length > 0) {
      console.log('Using BE*VAT | 0% as reference');
    }
  }

  // Get tax group for 0%
  const taxGroups = await odoo.searchRead('account.tax.group',
    [['name', 'ilike', '0%']],
    ['id', 'name'],
    { limit: 5 }
  );
  console.log('\nTax groups with 0%:', taxGroups.length);
  for (const tg of taxGroups) {
    console.log('  ID:', tg.id, '| Name:', tg.name);
  }

  // Try to find UK-related tax group or use first 0% group
  let taxGroupId = taxGroups.length > 0 ? taxGroups[0].id : null;

  // Get the UK country ID
  const uk = await odoo.searchRead('res.country',
    [['code', '=', 'GB']],
    ['id', 'name'],
    { limit: 1 }
  );
  const ukCountryId = uk.length > 0 ? uk[0].id : null;
  console.log('\nUK Country ID:', ukCountryId);

  // Create the tax
  console.log('\n========================================');
  console.log('CREATING DEEMED RESELLER TAX CODE');
  console.log('========================================\n');

  const taxData = {
    name: 'GB*VAT | 0% Deemed Reseller',
    amount: 0,
    amount_type: 'percent',
    type_tax_use: 'sale',
    description: '0% - Deemed Reseller (Amazon Marketplace)',
    active: true,
    company_id: companyId,
    country_id: ukCountryId,
    tax_group_id: taxGroupId
  };

  console.log('Creating tax with data:', JSON.stringify(taxData, null, 2));

  try {
    const taxId = await odoo.create('account.tax', taxData);
    console.log('\nSUCCESS! Created tax ID:', taxId);

    // Verify
    const newTax = await odoo.searchRead('account.tax',
      [['id', '=', taxId]],
      ['id', 'name', 'amount', 'type_tax_use', 'description', 'active']
    );
    console.log('\nVerification:');
    console.log('  ID:', newTax[0].id);
    console.log('  Name:', newTax[0].name);
    console.log('  Amount:', newTax[0].amount + '%');
    console.log('  Type:', newTax[0].type_tax_use);
    console.log('  Description:', newTax[0].description);
    console.log('  Active:', newTax[0].active);

  } catch (error) {
    console.error('Error creating tax:', error.message);
  }
}

createDeemedResellerTax().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
