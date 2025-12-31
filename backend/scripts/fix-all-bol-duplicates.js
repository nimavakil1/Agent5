#!/usr/bin/env node
/**
 * Fix ALL BOL delivery duplicate names - broader search
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function fixAllBolDuplicates() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Searching ALL BOL Deliveries ===\n');

  // Get ALL BOL deliveries (higher limit)
  const pickings = await odoo.searchRead('stock.picking',
    [['name', 'like', 'BOL%']],
    ['id', 'name', 'partner_id'],
    2000
  );

  console.log(`Found ${pickings.length} BOL deliveries\n`);

  // Get unique partner IDs
  const partnerIds = [...new Set(pickings.map(p => p.partner_id?.[0]).filter(Boolean))];
  console.log(`Unique partners: ${partnerIds.length}`);

  // Get ALL partner details in batches
  const allPartners = [];
  const batchSize = 200;
  for (let i = 0; i < partnerIds.length; i += batchSize) {
    const batchIds = partnerIds.slice(i, i + batchSize);
    const batch = await odoo.searchRead('res.partner',
      [['id', 'in', batchIds]],
      ['id', 'name', 'display_name', 'parent_id', 'type']
    );
    allPartners.push(...batch);
  }

  console.log(`Fetched ${allPartners.length} partners\n`);

  // Find partners with duplicate names
  const duplicatePartners = [];
  for (const p of allPartners) {
    const name = p.name || '';
    const displayName = p.display_name || '';

    if (displayName.includes(',')) {
      const parts = displayName.split(',').map(s => s.trim().toLowerCase());
      if (parts.length === 2) {
        const part1 = parts[0];
        const part2 = parts[1];
        // Check similarity
        if (part1 === part2 ||
            part1.startsWith(part2) ||
            part2.startsWith(part1) ||
            (part1.length > 3 && part2.length > 3 && (part1.includes(part2.substring(0, 5)) || part2.includes(part1.substring(0, 5))))) {
          duplicatePartners.push(p);
        }
      }
    }
  }

  console.log(`Partners with duplicate names: ${duplicatePartners.length}`);

  if (duplicatePartners.length === 0) {
    console.log('No more duplicates found!');
    process.exit(0);
    return;
  }

  console.log('\n--- Fixing Duplicate Partners ---\n');

  let fixed = 0;
  for (const p of duplicatePartners) {
    if (p.parent_id) {
      const parentName = p.parent_id[1]?.toLowerCase() || '';
      const childName = p.name?.toLowerCase() || '';

      // More flexible matching
      if (parentName === childName ||
          parentName.includes(childName) ||
          childName.includes(parentName) ||
          (childName.length > 5 && parentName.includes(childName.substring(0, 6)))) {

        console.log(`Fixing: "${p.display_name}" -> "${p.name}"`);

        await odoo.write('res.partner', [p.id], {
          parent_id: false,
          type: 'contact'
        });
        fixed++;
      }
    }
  }

  console.log(`\nFixed ${fixed} partners`);

  // Verify
  console.log('\n=== Verification ===');
  const remaining = await odoo.searchRead('res.partner',
    [['id', 'in', duplicatePartners.map(p => p.id)]],
    ['id', 'name', 'display_name', 'parent_id']
  );

  const stillDuplicate = remaining.filter(p => p.display_name?.includes(','));
  console.log(`Partners still with comma in display_name: ${stillDuplicate.length}`);

  if (stillDuplicate.length > 0) {
    for (const p of stillDuplicate.slice(0, 10)) {
      console.log(`  ${p.id}: "${p.display_name}" | Parent: ${p.parent_id ? p.parent_id[1] : 'none'}`);
    }
  }

  process.exit(0);
}

fixAllBolDuplicates().catch(e => { console.error(e); process.exit(1); });
