require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Find the Vendor sales team
  console.log('=== Finding Sales Teams ===');
  const teams = await odoo.searchRead('crm.team',
    [['name', 'ilike', 'vendor']],
    ['id', 'name'],
    { limit: 10 }
  );
  console.log('Vendor teams found:', teams);

  if (teams.length === 0) {
    console.log('No vendor team found, checking all teams...');
    const allTeams = await odoo.searchRead('crm.team', [], ['id', 'name'], { limit: 20 });
    console.log('All teams:', allTeams);
    return;
  }

  const vendorTeamIds = teams.map(t => t.id);
  console.log('Vendor team IDs:', vendorTeamIds);

  // Get invoices with Sales Team = Vendor
  console.log('\n=== Vendor Team Invoices ===');
  const invoices = await odoo.searchRead('account.move',
    [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['team_id', 'in', vendorTeamIds]],
    ['id', 'name', 'partner_id', 'amount_total', 'invoice_date', 'team_id'],
    { limit: 50, order: 'invoice_date desc' }
  );

  console.log('Found', invoices.length, 'invoices');

  // Group by partner
  const byPartner = {};
  invoices.forEach(inv => {
    const partner = inv.partner_id ? inv.partner_id[1] : 'Unknown';
    if (!byPartner[partner]) byPartner[partner] = { count: 0, total: 0 };
    byPartner[partner].count++;
    byPartner[partner].total += inv.amount_total;
  });

  console.log('\nBy Partner (sample):');
  Object.entries(byPartner).forEach(([partner, data]) => {
    console.log(`  ${partner}: ${data.count} invoices, EUR ${data.total.toFixed(2)}`);
  });

  // Get total count
  const totalCount = await odoo.execute('account.move', 'search_count', [
    [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['team_id', 'in', vendorTeamIds]]
  ]);
  console.log('\nTotal vendor invoices:', totalCount);

  // Show recent invoices
  console.log('\n=== Recent Vendor Invoices ===');
  invoices.slice(0, 20).forEach(inv => {
    const partner = inv.partner_id ? inv.partner_id[1].substring(0, 30) : '-';
    console.log(`${inv.name} | ${partner.padEnd(30)} | EUR ${inv.amount_total.toFixed(2).padStart(10)} | ${inv.invoice_date}`);
  });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
