#!/usr/bin/env node
/**
 * Fix FBM (Amazon) deliveries:
 * 1. Fix duplicate names ("Name, Name" -> "Name")
 * 2. Fix "Amazon EU SARL" partners -> use actual customer from order
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function fixFbmDeliveries() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fixing FBM Deliveries ===\n');

  // Find ALL active CW/OUT deliveries
  const pickings = await odoo.searchRead('stock.picking',
    [
      ['name', 'like', 'CW/OUT/%'],
      ['state', 'in', ['assigned', 'confirmed', 'waiting']]
    ],
    ['id', 'name', 'origin', 'partner_id', 'state'],
    500
  );

  console.log(`Found ${pickings.length} CW/Stock deliveries\n`);

  let fixedDuplicate = 0;
  let fixedAmazon = 0;
  let errors = 0;

  for (const picking of pickings) {
    const partnerName = picking.partner_id?.[1] || '';
    const partnerId = picking.partner_id?.[0];

    // Check for duplicate names (contains comma and repeated name)
    const hasDuplicate = partnerName.includes(',') && checkDuplicateName(partnerName);

    // Check for Amazon billing entity
    const isAmazonBilling = partnerName.toLowerCase().includes('amazon eu sarl') ||
                            partnerName.toLowerCase().includes('amazon business eu');

    if (!hasDuplicate && !isAmazonBilling) continue;

    console.log(`\n${picking.name} | ${picking.origin || 'N/A'}`);
    console.log(`  Current partner: "${partnerName}"`);

    // Get the correct partner from sale order
    if (picking.origin) {
      const saleOrders = await odoo.searchRead('sale.order',
        [['name', '=', picking.origin]],
        ['id', 'name', 'partner_shipping_id']
      );

      if (saleOrders.length > 0) {
        const so = saleOrders[0];
        const correctPartnerId = so.partner_shipping_id?.[0];
        const correctPartnerName = so.partner_shipping_id?.[1];

        if (correctPartnerId && correctPartnerId !== partnerId) {
          try {
            await odoo.write('stock.picking', [picking.id], {
              partner_id: correctPartnerId
            });
            console.log(`  [OK] Updated to: "${correctPartnerName}"`);
            if (hasDuplicate) fixedDuplicate++;
            if (isAmazonBilling) fixedAmazon++;
          } catch (err) {
            console.log(`  [ERR] ${err.message}`);
            errors++;
          }
        } else {
          // Partner on order might also be wrong - fix the partner record
          if (partnerId && hasDuplicate) {
            const cleanName = fixDuplicateName(partnerName);
            try {
              await odoo.write('res.partner', [partnerId], {
                name: cleanName,
                parent_id: false
              });
              console.log(`  [OK] Fixed partner name to: "${cleanName}"`);
              fixedDuplicate++;
            } catch (err) {
              console.log(`  [ERR] ${err.message}`);
              errors++;
            }
          }
        }
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Fixed duplicate names: ${fixedDuplicate}`);
  console.log(`Fixed Amazon billing: ${fixedAmazon}`);
  console.log(`Errors: ${errors}`);

  process.exit(0);
}

function checkDuplicateName(name) {
  const parts = name.split(',').map(s => s.trim().toLowerCase());
  if (parts.length !== 2) return false;

  // Check if parts are same or very similar
  const p1 = parts[0];
  const p2 = parts[1];

  return p1 === p2 ||
         p1.startsWith(p2.substring(0, Math.min(5, p2.length))) ||
         p2.startsWith(p1.substring(0, Math.min(5, p1.length)));
}

function fixDuplicateName(name) {
  const parts = name.split(',').map(s => s.trim());
  // Return the longer/more complete part
  return parts[0].length >= parts[1].length ? parts[0] : parts[1];
}

fixFbmDeliveries().catch(e => { console.error(e); process.exit(1); });
