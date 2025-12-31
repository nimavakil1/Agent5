#!/usr/bin/env node
/**
 * Fix BOL delivery duplicate names and wrong warehouse issues
 *
 * Issues found:
 * 1. Contact names show "Name, Name" (duplicate from parent-child relationship)
 * 2. Some returns use CW warehouse instead of BOL
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function fixBolDuplicates() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Analyzing BOL Delivery Partners ===\n');

  // Get all BOL deliveries
  const pickings = await odoo.searchRead('stock.picking',
    [['name', 'like', 'BOL%']],
    ['id', 'name', 'partner_id', 'location_id', 'state'],
    500
  );

  console.log(`Found ${pickings.length} BOL deliveries\n`);

  // Get unique partner IDs
  const partnerIds = [...new Set(pickings.map(p => p.partner_id?.[0]).filter(Boolean))];
  console.log(`Unique partners: ${partnerIds.length}`);

  // Get partner details
  const partners = await odoo.searchRead('res.partner',
    [['id', 'in', partnerIds]],
    ['id', 'name', 'display_name', 'parent_id', 'type', 'street', 'city', 'zip']
  );

  // Find partners with duplicate names (name appears twice in display_name)
  const duplicatePartners = [];
  for (const p of partners) {
    const name = p.name || '';
    const displayName = p.display_name || '';

    // Check if name appears more than once in display_name
    // Or if display_name contains comma and both parts are similar
    if (displayName.includes(',')) {
      const parts = displayName.split(',').map(s => s.trim());
      if (parts.length === 2) {
        const part1 = parts[0].toLowerCase();
        const part2 = parts[1].toLowerCase();
        // Check if parts are same or one starts with the other
        if (part1 === part2 || part1.startsWith(part2) || part2.startsWith(part1)) {
          duplicatePartners.push(p);
        }
      }
    }
  }

  console.log(`\nPartners with duplicate names: ${duplicatePartners.length}`);

  if (duplicatePartners.length > 0) {
    console.log('\n--- Duplicate Name Partners ---');
    for (const p of duplicatePartners.slice(0, 30)) {
      console.log(`ID ${p.id}: "${p.display_name}" | Name: "${p.name}" | Parent: ${p.parent_id ? p.parent_id[1] : 'none'}`);
    }
    if (duplicatePartners.length > 30) {
      console.log(`... and ${duplicatePartners.length - 30} more`);
    }
  }

  // The issue is that these partners have a parent_id pointing to themselves or similar
  // Let's fix by removing the parent_id if it causes duplication
  console.log('\n=== Fixing Duplicate Partners ===');

  let fixed = 0;
  for (const p of duplicatePartners) {
    if (p.parent_id) {
      // Check if parent name is same/similar to child name
      const parentName = p.parent_id[1]?.toLowerCase() || '';
      const childName = p.name?.toLowerCase() || '';

      if (parentName === childName || parentName.includes(childName) || childName.includes(parentName)) {
        console.log(`Removing parent from "${p.name}" (parent was: "${p.parent_id[1]}")`);

        await odoo.write('res.partner', [p.id], {
          parent_id: false,
          type: 'contact' // Make it a standalone contact
        });
        fixed++;
      }
    }
  }

  console.log(`\nFixed ${fixed} partners by removing duplicate parent references`);

  // Now check for CW warehouse issues in returns
  console.log('\n=== Checking Returns/Transfers with Wrong Warehouse ===');

  const returns = await odoo.searchRead('stock.picking',
    [['name', 'like', 'WH/%'], ['origin', 'like', 'BOL%']],
    ['id', 'name', 'origin', 'location_id', 'location_dest_id', 'state'],
    50
  );

  // Also check returns related to BOL by location
  const cwReturns = await odoo.searchRead('stock.picking',
    [['location_id.name', 'ilike', 'CW'], ['name', 'like', 'WH/RET%']],
    ['id', 'name', 'origin', 'location_id', 'location_dest_id', 'state', 'partner_id'],
    50
  );

  console.log(`\nFound ${returns.length} WH/* transfers with BOL origin`);
  console.log(`Found ${cwReturns.length} WH/RET* with CW location`);

  for (const r of cwReturns.slice(0, 10)) {
    console.log(`${r.name} | Origin: ${r.origin || 'N/A'} | From: ${r.location_id?.[1]} | To: ${r.location_dest_id?.[1]} | Partner: ${r.partner_id?.[1]?.substring(0, 25) || 'N/A'}`);
  }

  console.log('\n=== Done ===');
  process.exit(0);
}

fixBolDuplicates().catch(e => { console.error(e); process.exit(1); });
