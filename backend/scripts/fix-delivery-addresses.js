#!/usr/bin/env node
/**
 * Fix delivery addresses - sync stock.picking partner_id with sale.order partner_shipping_id
 *
 * This ensures warehouse personnel ship to the correct address
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const DRY_RUN = process.argv.includes('--dry-run');

async function fixDeliveryAddresses() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fixing Delivery Addresses ===');
  console.log(DRY_RUN ? '(DRY RUN)\n' : '\n');

  // Find all active deliveries (not done/cancelled)
  const pickings = await odoo.searchRead('stock.picking',
    [
      ['state', 'in', ['assigned', 'confirmed', 'waiting']],
      ['picking_type_code', '=', 'outgoing']  // Only outgoing deliveries
    ],
    ['id', 'name', 'origin', 'partner_id', 'state'],
    1000
  );

  console.log(`Found ${pickings.length} active outgoing deliveries\n`);

  let checked = 0;
  let fixed = 0;
  let errors = 0;

  for (const picking of pickings) {
    checked++;

    if (!picking.origin) continue;

    // Find the sale order by origin (which is the sale order name)
    const saleOrders = await odoo.searchRead('sale.order',
      [['name', '=', picking.origin]],
      ['id', 'name', 'partner_shipping_id']
    );

    if (saleOrders.length === 0) continue;

    const so = saleOrders[0];
    const soShippingPartnerId = so.partner_shipping_id ? so.partner_shipping_id[0] : null;
    const pickingPartnerId = picking.partner_id ? picking.partner_id[0] : null;

    // Check if they match
    if (soShippingPartnerId && soShippingPartnerId !== pickingPartnerId) {
      const soPartnerName = so.partner_shipping_id[1];
      const pickingPartnerName = picking.partner_id ? picking.partner_id[1] : 'None';

      if (DRY_RUN) {
        console.log(`[DRY] ${picking.name} | ${picking.origin}`);
        console.log(`       Current: "${pickingPartnerName}"`);
        console.log(`       Should be: "${soPartnerName}"`);
        fixed++;
      } else {
        try {
          await odoo.write('stock.picking', [picking.id], {
            partner_id: soShippingPartnerId
          });
          console.log(`[OK] ${picking.name} -> "${soPartnerName}"`);
          fixed++;
        } catch (err) {
          console.log(`[ERR] ${picking.name}: ${err.message}`);
          errors++;
        }
      }
    }

    if (checked % 100 === 0) {
      console.log(`Progress: ${checked}/${pickings.length} checked...`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Checked: ${checked}`);
  console.log(`Fixed: ${fixed}`);
  console.log(`Errors: ${errors}`);

  if (DRY_RUN) {
    console.log('\n(Dry run - run without --dry-run to apply changes)');
  }

  process.exit(0);
}

fixDeliveryAddresses().catch(e => { console.error(e); process.exit(1); });
