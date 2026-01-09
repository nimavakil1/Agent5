require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function showDeliveredNotInvoiced() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Finding delivered but not invoiced Amazon orders...\n');

  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['team_id.name', 'ilike', 'Amazon'],
      ['delivery_status', '=', 'full']
    ],
    ['name', 'partner_id', 'amount_total', 'date_order', 'team_id', 'client_order_ref', 'state']
  );

  console.log('Found ' + orders.length + ' delivered but not invoiced orders:\n');

  // Sort by date
  orders.sort((a, b) => a.date_order.localeCompare(b.date_order));

  for (const order of orders) {
    console.log(order.name + ' | ' + (order.client_order_ref || 'N/A') + ' | ' + order.date_order.substring(0, 10) + ' | EUR ' + order.amount_total.toFixed(2) + ' | ' + (order.team_id ? order.team_id[1] : 'N/A'));
  }

  // Summary by team
  console.log('\n=== BY TEAM ===');
  const byTeam = {};
  for (const order of orders) {
    const team = order.team_id ? order.team_id[1] : 'No Team';
    byTeam[team] = (byTeam[team] || 0) + 1;
  }
  for (const [team, count] of Object.entries(byTeam).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + team + ': ' + count);
  }

  console.log('\nTotal value: EUR ' + orders.reduce((sum, o) => sum + o.amount_total, 0).toFixed(2));
}

showDeliveredNotInvoiced()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
