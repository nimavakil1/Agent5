require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get fields on account.move model
  const fields = await odoo.execute('account.move', 'fields_get', [], {attributes: ['string', 'type', 'help']});

  // Filter for Amazon/vendor related fields
  const amazonFields = Object.entries(fields).filter(([name, info]) =>
    name.toLowerCase().includes('amazon') ||
    name.toLowerCase().includes('vendor') ||
    name.toLowerCase().includes('edi') ||
    name.toLowerCase().includes('sp_api')
  );

  console.log('=== Amazon/Vendor Related Fields on account.move ===');
  amazonFields.forEach(([name, info]) => {
    console.log(name + ' (' + info.type + '): ' + info.string);
    if (info.help) console.log('   Help: ' + info.help);
  });

  if (amazonFields.length === 0) {
    console.log('No Amazon-specific fields found. Checking for any custom fields...');
    const customFields = Object.entries(fields).filter(([name]) => name.startsWith('x_'));
    customFields.forEach(([name, info]) => {
      console.log(name + ' (' + info.type + '): ' + info.string);
    });
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
