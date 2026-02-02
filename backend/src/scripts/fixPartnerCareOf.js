/**
 * Fix partner c/o address - move from street2 to name
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

async function main() {
  const partnerId = 240636;

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get current partner data
  const partner = await odoo.searchRead('res.partner', [['id', '=', partnerId]], ['name', 'street', 'street2']);
  console.log('Current:', partner[0]);

  if (!partner[0]) {
    console.log('Partner not found');
    process.exit(1);
  }

  // Check if street2 has c/o that needs moving
  const street2 = partner[0].street2;
  if (street2 && /c\/o/i.test(street2)) {
    // Append c/o to name, clear street2
    const newName = partner[0].name.replace(/\s*c\/o.*$/i, '') + ' ' + street2;

    await odoo.write('res.partner', [partnerId], {
      name: newName.trim(),
      street2: false
    });

    // Verify
    const updated = await odoo.searchRead('res.partner', [['id', '=', partnerId]], ['name', 'street', 'street2']);
    console.log('Updated:', updated[0]);
  } else {
    console.log('No c/o found in street2, nothing to fix');
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
