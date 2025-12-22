require('dotenv').config();
const Odoo = require('./src/services/odoo/OdooClient');

async function check() {
  const odoo = new Odoo();
  await odoo.connect();

  // Find all Export-related fiscal positions
  console.log('=== Fiscal Positions with "Export" ===');
  const exportFPs = await odoo.searchRead('account.fiscal.position',
    [['name', 'ilike', 'export']],
    ['id', 'name', 'country_id', 'country_group_id', 'auto_apply']
  );
  for (const fp of exportFPs) {
    console.log('ID ' + fp.id + ': ' + fp.name);
    console.log('  country_id:', fp.country_id);
    console.log('  country_group_id:', fp.country_group_id);
    console.log('  auto_apply:', fp.auto_apply);
  }

  // Find all fiscal positions for Switzerland
  console.log('\n=== Fiscal Positions for Switzerland (CH) ===');
  const chFPs = await odoo.searchRead('account.fiscal.position',
    [['country_id.code', '=', 'CH']],
    ['id', 'name']
  );
  for (const fp of chFPs) {
    console.log('ID ' + fp.id + ': ' + fp.name);
  }

  // Check all sale journals
  console.log('\n=== Sale Journals ===');
  const journals = await odoo.searchRead('account.journal',
    [['type', '=', 'sale']],
    ['id', 'name', 'code', 'type']
  );
  for (const j of journals) {
    console.log('ID ' + j.id + ': ' + j.name + ' (' + j.code + ') - type: ' + j.type);
  }

  process.exit(0);
}
check();
