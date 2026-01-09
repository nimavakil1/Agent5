require('dotenv').config();
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');

async function analyzeToInvoiceOrders() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Analyzing Amazon seller orders with invoice_status = "to invoice"...\n');

  const toInvoiceOrders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['team_id.name', 'ilike', 'Amazon']
    ],
    ['name', 'partner_id', 'amount_total', 'date_order', 'invoice_ids', 'team_id', 'client_order_ref', 'state', 'delivery_status']
  );

  console.log('Found ' + toInvoiceOrders.length + ' orders\n');

  // Group by team
  const byTeam = {};
  // Group by state
  const byState = {};
  // Group by month
  const byMonth = {};

  for (const order of toInvoiceOrders) {
    const team = order.team_id ? order.team_id[1] : 'No Team';
    byTeam[team] = (byTeam[team] || 0) + 1;

    byState[order.state] = (byState[order.state] || 0) + 1;

    const month = order.date_order ? order.date_order.substring(0, 7) : 'Unknown';
    byMonth[month] = (byMonth[month] || 0) + 1;
  }

  console.log('=== BY TEAM ===');
  for (const [team, count] of Object.entries(byTeam).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + team + ': ' + count);
  }

  console.log('\n=== BY STATE ===');
  for (const [state, count] of Object.entries(byState).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + state + ': ' + count);
  }

  console.log('\n=== BY MONTH ===');
  for (const [month, count] of Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log('  ' + month + ': ' + count);
  }

  // Show sample of older orders (before current month)
  const currentMonth = new Date().toISOString().substring(0, 7);
  const olderOrders = toInvoiceOrders.filter(o => {
    const month = o.date_order ? o.date_order.substring(0, 7) : '';
    return month && month < currentMonth;
  });

  console.log('\n=== OLDER ORDERS (before ' + currentMonth + ') ===');
  console.log('Count: ' + olderOrders.length);

  if (olderOrders.length > 0) {
    console.log('\nSample of older orders not yet invoiced:');
    const sample = olderOrders.slice(0, 20);
    for (const order of sample) {
      console.log('  ' + order.name + ' | ' + order.client_order_ref + ' | ' + order.date_order.substring(0, 10) + ' | EUR ' + order.amount_total.toFixed(2) + ' | ' + order.state + ' | ' + (order.team_id ? order.team_id[1] : 'N/A'));
    }
  }

  // Check for delivered but not invoiced
  console.log('\n=== DELIVERY STATUS CHECK ===');
  let delivered = 0;
  let notDelivered = 0;
  let unknown = 0;

  for (const order of toInvoiceOrders) {
    if (order.delivery_status === 'full') {
      delivered++;
    } else if (order.delivery_status === 'pending' || order.delivery_status === 'partial') {
      notDelivered++;
    } else {
      unknown++;
    }
  }

  console.log('  Fully delivered: ' + delivered);
  console.log('  Not fully delivered: ' + notDelivered);
  console.log('  Unknown/No status: ' + unknown);
}

analyzeToInvoiceOrders()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
