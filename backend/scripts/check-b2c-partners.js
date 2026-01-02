const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function checkB2CPartners() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Check what Amazon B2C partners exist
  const b2cPartners = await odoo.searchRead('res.partner',
    [['name', 'ilike', 'Amazon | AMZ_B2C']],
    ['id', 'name', 'country_id'],
    50
  );

  console.log('=== Amazon B2C Partners ===');
  console.log('Total:', b2cPartners.length);
  console.log('');

  for (const p of b2cPartners) {
    console.log('ID:', p.id.toString().padStart(5), '| Name:', p.name, '| Country:', p.country_id ? p.country_id[1] : 'N/A');
  }

  // Check for any partner named "Amazon | AMZ_B2C_FR"
  const frPartner = await odoo.searchRead('res.partner',
    [['name', '=', 'Amazon | AMZ_B2C_FR']],
    ['id', 'name']
  );
  console.log('\n=== Exact match for "Amazon | AMZ_B2C_FR" ===');
  console.log('Found:', frPartner.length);
  if (frPartner.length > 0) {
    console.log('ID:', frPartner[0].id, '| Name:', frPartner[0].name);
  }

  // Check for any partner named "Amazon | AMZ_B2C_DE"
  const dePartner = await odoo.searchRead('res.partner',
    [['name', '=', 'Amazon | AMZ_B2C_DE']],
    ['id', 'name']
  );
  console.log('\n=== Exact match for "Amazon | AMZ_B2C_DE" ===');
  console.log('Found:', dePartner.length);
  if (dePartner.length > 0) {
    console.log('ID:', dePartner[0].id, '| Name:', dePartner[0].name);
  }

  // Check Elisa Barbier's ID
  const elisa = await odoo.searchRead('res.partner',
    [['id', '=', 3150]],
    ['id', 'name', 'ref', 'email']
  );
  console.log('\n=== Partner ID 3150 ===');
  if (elisa.length > 0) {
    console.log('Name:', elisa[0].name);
    console.log('Ref:', elisa[0].ref || 'N/A');
    console.log('Email:', elisa[0].email || 'N/A');
  }

  // Check Gerstner's ID
  const gerstner = await odoo.searchRead('res.partner',
    [['id', '=', 3146]],
    ['id', 'name', 'ref', 'email']
  );
  console.log('\n=== Partner ID 3146 ===');
  if (gerstner.length > 0) {
    console.log('Name:', gerstner[0].name);
    console.log('Ref:', gerstner[0].ref || 'N/A');
    console.log('Email:', gerstner[0].email || 'N/A');
  }
}

checkB2CPartners().catch(console.error);
