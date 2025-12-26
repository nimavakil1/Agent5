require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get fields on vendor transaction history
  const fields = await odoo.execute('amazon.vendor.transaction.history', 'fields_get', [], {attributes: ['string', 'type']});
  console.log('=== amazon.vendor.transaction.history Fields ===');
  Object.entries(fields).slice(0, 30).forEach(([name, info]) => {
    console.log(name + ' (' + info.type + '): ' + info.string);
  });

  console.log('\n=== Recent Vendor Transaction History ===');
  const history = await odoo.searchRead('amazon.vendor.transaction.history',
    [],
    Object.keys(fields).filter(f => !f.startsWith('_')),
    {limit: 20, order: 'create_date desc'}
  );

  history.forEach((h, i) => {
    console.log('\n--- Record ' + (i+1) + ' ---');
    Object.entries(h).forEach(([k, v]) => {
      if (v && k !== 'id' && !k.startsWith('_')) {
        console.log('  ' + k + ': ' + (Array.isArray(v) ? v[1] || v[0] : v));
      }
    });
  });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
