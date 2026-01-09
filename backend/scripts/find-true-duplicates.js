/**
 * Find TRUE duplicate invoices (same origin + same amount + same date)
 * vs legitimate multi-invoice orders (different amounts or dates)
 */
require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Finding TRUE Duplicate Invoices ===\n');

  // Get all posted customer invoices with invoice_origin
  const invoices = await odoo.searchRead('account.move',
    [
      ['state', '=', 'posted'],
      ['move_type', '=', 'out_invoice'],
      ['invoice_origin', '!=', false]
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'amount_total', 'invoice_date'],
    { limit: 200000 }
  );

  console.log(`Total posted invoices: ${invoices.length}\n`);

  // Group by origin + amount + date (TRUE duplicates)
  const byKey = {};
  for (const inv of invoices) {
    const key = `${inv.invoice_origin}|${inv.amount_total?.toFixed(2)}|${inv.invoice_date}`;
    if (!byKey[key]) {
      byKey[key] = [];
    }
    byKey[key].push(inv);
  }

  // Find duplicates (same origin + amount + date)
  const duplicates = Object.entries(byKey)
    .filter(([_, invs]) => invs.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  console.log(`Invoice groups (origin+amount+date) with duplicates: ${duplicates.length}\n`);

  // Count total duplicate invoices (extras beyond the first)
  let totalDuplicates = 0;
  for (const [_, invs] of duplicates) {
    totalDuplicates += invs.length - 1; // All but the first are duplicates
  }
  console.log(`Total duplicate invoices to remove: ${totalDuplicates}\n`);

  // Show distribution
  const dist = {};
  for (const [_, invs] of duplicates) {
    const count = invs.length;
    dist[count] = (dist[count] || 0) + 1;
  }

  console.log('Distribution (# of identical invoices):');
  for (const [count, groups] of Object.entries(dist).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  ${count} identical: ${groups} groups (${groups * (count - 1)} extra invoices)`);
  }

  // Show first 20 examples
  console.log('\n=== Examples of TRUE Duplicates ===\n');
  for (const [key, invs] of duplicates.slice(0, 20)) {
    const [origin, amount, date] = key.split('|');
    console.log(`${origin} | €${amount} | ${date}`);
    console.log(`  ${invs.length} identical invoices:`);
    for (const inv of invs) {
      console.log(`    ${inv.name}`);
    }
    console.log('');
  }

  // Calculate total over-invoiced value from these duplicates
  let totalOverValue = 0;
  for (const [key, invs] of duplicates) {
    const [_, amount, __] = key.split('|');
    totalOverValue += (invs.length - 1) * parseFloat(amount);
  }
  console.log('\n=== SUMMARY ===');
  console.log(`Duplicate groups: ${duplicates.length}`);
  console.log(`Total duplicate invoices (to cancel): ${totalDuplicates}`);
  console.log(`Total over-invoiced value: €${totalOverValue.toFixed(2)}`);

  // Export the list for potential cleanup
  console.log('\n\nInvoice IDs to consider canceling (first 100):');
  const idsToCancel = [];
  for (const [_, invs] of duplicates) {
    // Keep the first, mark the rest for cancellation
    for (const inv of invs.slice(1)) {
      idsToCancel.push(inv.id);
    }
  }
  console.log(idsToCancel.slice(0, 100).join(', '));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
