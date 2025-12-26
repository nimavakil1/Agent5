require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Search for Amazon-related models
  const models = await odoo.searchRead('ir.model',
    [['model', 'like', '%amazon%']],
    ['model', 'name'],
    {limit: 50}
  );

  console.log('=== Amazon-related Models in Odoo ===');
  models.forEach(m => {
    console.log(m.model + ' - ' + m.name);
  });

  // Check for vendor invoice specific models
  console.log('\n=== Checking for Vendor Invoice models ===');
  const vendorModels = await odoo.searchRead('ir.model',
    ['|', ['model', 'like', '%vendor%'], ['model', 'like', '%edi%']],
    ['model', 'name'],
    {limit: 30}
  );
  vendorModels.forEach(m => {
    console.log(m.model + ' - ' + m.name);
  });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
