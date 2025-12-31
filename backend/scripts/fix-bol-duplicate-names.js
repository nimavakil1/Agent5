#!/usr/bin/env node
/**
 * Fix BOL/OUT deliveries with duplicate names caused by parent_id relationship
 * E.g., "Robert butlink, Robert butlink" → "Robert butlink"
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function fixBolDeliveries() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fixing BOL/OUT Deliveries with Duplicate Names ===\n');

  // Find ALL active BOL/OUT deliveries
  const pickings = await odoo.searchRead('stock.picking',
    [
      ['name', 'like', 'BOL/OUT/%'],
      ['state', 'in', ['assigned', 'confirmed', 'waiting']]
    ],
    ['id', 'name', 'origin', 'partner_id', 'state'],
    500
  );

  console.log(`Found ${pickings.length} active BOL/OUT deliveries\n`);

  let fixed = 0;
  let errors = 0;

  for (const p of pickings) {
    const partnerName = p.partner_id ? p.partner_id[1] : '';
    const partnerId = p.partner_id ? p.partner_id[0] : null;

    // Check for duplicate names (contains comma)
    if (!partnerName.includes(',') || !partnerId) continue;

    // Get partner details
    const partners = await odoo.searchRead('res.partner',
      [['id', '=', partnerId]],
      ['id', 'name', 'parent_id']
    );

    if (partners.length === 0) continue;
    const partner = partners[0];

    // If partner has parent_id, that's causing the display_name issue
    if (partner.parent_id) {
      console.log(`${p.name} | ${p.origin || 'N/A'}`);
      console.log(`  Display: ${partnerName.substring(0, 50)}`);
      console.log(`  Actual name: ${partner.name}`);
      console.log(`  Has parent_id: ${partner.parent_id[0]} - ${partner.parent_id[1]}`);

      try {
        await odoo.write('res.partner', [partnerId], { parent_id: false });
        console.log('  [OK] Removed parent_id');
        fixed++;
      } catch (err) {
        console.log(`  [ERR] ${err.message}`);
        errors++;
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Fixed: ${fixed}`);
  console.log(`Errors: ${errors}`);

  process.exit(0);
}

fixBolDeliveries().catch(e => { console.error(e); process.exit(1); });
