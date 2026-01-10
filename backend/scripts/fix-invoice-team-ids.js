/**
 * Fix invoice team_ids
 *
 * Finds invoices linked to BOL sale orders that have the wrong team_id
 * and updates them to match the sale order's team_id.
 */
require('dotenv').config();

async function main() {
  const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fix Invoice Team IDs ===\n');

  // BOL team IDs
  const BOL_TEAM_IDS = [9, 10]; // BOL and BOL NL teams

  // Step 1: Find all sale orders with BOL team
  console.log('Finding BOL sale orders...');
  const bolOrderIds = await odoo.execute('sale.order', 'search', [[
    ['team_id', 'in', BOL_TEAM_IDS]
  ]]);
  console.log(`Found ${bolOrderIds.length} BOL sale orders`);

  // Step 2: Find invoices linked to these orders that have wrong team
  console.log('\nFinding invoices with wrong team_id...');

  // Get invoices where invoice_origin matches BOL order names
  const bolOrders = await odoo.execute('sale.order', 'read', [bolOrderIds], {
    fields: ['name', 'team_id']
  });

  const orderNameToTeam = {};
  for (const order of bolOrders) {
    orderNameToTeam[order.name] = order.team_id[0];
  }

  // Find invoices with wrong team (not in BOL teams but linked to BOL orders)
  const invoiceIds = await odoo.execute('account.move', 'search', [[
    ['move_type', '=', 'out_invoice'],
    ['team_id', 'not in', BOL_TEAM_IDS],
    ['invoice_origin', '!=', false]
  ]]);

  console.log(`Found ${invoiceIds.length} invoices with non-BOL team to check`);

  // Check which ones are linked to BOL orders
  const invoicesToFix = [];
  const batchSize = 100;

  for (let i = 0; i < invoiceIds.length; i += batchSize) {
    const batch = invoiceIds.slice(i, i + batchSize);
    const invoices = await odoo.execute('account.move', 'read', [batch], {
      fields: ['id', 'name', 'invoice_origin', 'team_id']
    });

    for (const inv of invoices) {
      // Check if invoice_origin matches a BOL order
      const origin = inv.invoice_origin;
      if (origin && orderNameToTeam[origin]) {
        const correctTeamId = orderNameToTeam[origin];
        const currentTeamId = inv.team_id ? inv.team_id[0] : null;

        if (currentTeamId !== correctTeamId) {
          invoicesToFix.push({
            id: inv.id,
            name: inv.name,
            origin: origin,
            currentTeam: inv.team_id ? inv.team_id[1] : 'None',
            correctTeamId: correctTeamId
          });
        }
      }
    }

    if (i % 1000 === 0 && i > 0) {
      console.log(`  Checked ${i} invoices...`);
    }
  }

  console.log(`\nFound ${invoicesToFix.length} invoices to fix`);

  if (invoicesToFix.length === 0) {
    console.log('No invoices need fixing!');
    process.exit(0);
  }

  // Show sample
  console.log('\nSample invoices to fix:');
  for (const inv of invoicesToFix.slice(0, 10)) {
    console.log(`  ${inv.name} (${inv.origin}): ${inv.currentTeam} → team_id ${inv.correctTeamId}`);
  }

  // Group by correct team
  const byTeam = {};
  for (const inv of invoicesToFix) {
    byTeam[inv.correctTeamId] = byTeam[inv.correctTeamId] || [];
    byTeam[inv.correctTeamId].push(inv.id);
  }

  console.log('\nBreakdown by target team:');
  for (const [teamId, ids] of Object.entries(byTeam)) {
    console.log(`  Team ${teamId}: ${ids.length} invoices`);
  }

  // Fix the invoices
  console.log('\n--- Fixing invoices ---');

  let fixed = 0;
  let errors = 0;

  for (const [teamId, ids] of Object.entries(byTeam)) {
    console.log(`\nUpdating ${ids.length} invoices to team_id ${teamId}...`);

    // Update in batches
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);

      try {
        await odoo.execute('account.move', 'write', [batch, {
          team_id: parseInt(teamId)
        }]);
        fixed += batch.length;

        if (i % 200 === 0 && i > 0) {
          console.log(`  Updated ${i} of ${ids.length}...`);
        }
      } catch (error) {
        console.error(`  Error updating batch: ${error.message}`);
        errors += batch.length;
      }
    }
  }

  console.log('\n=== DONE ===');
  console.log(`Fixed: ${fixed} invoices`);
  console.log(`Errors: ${errors}`);

  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
