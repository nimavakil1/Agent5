require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parse/sync');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function analyzeGap() {
  // Parse VCS
  const content = fs.readFileSync('/tmp/vcs_report.csv', 'utf-8');
  const records = csv.parse(content, { columns: true, skip_empty_lines: true });

  // Build map of VCS orders with marketplace info
  const vcsOrders = new Map();
  for (const row of records) {
    if (row['Transaction Type'] === 'SHIPMENT' && row['Order ID']) {
      if (!vcsOrders.has(row['Order ID'])) {
        vcsOrders.set(row['Order ID'], {
          marketplace: row['Marketplace ID'],
          shipDate: row['Shipment Date'],
          currency: row['Currency']
        });
      }
    }
  }

  console.log('VCS SHIPMENT orders:', vcsOrders.size);

  // Get Odoo orders
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Fetching Odoo orders...');
  const allOrders = await odoo.searchRead('sale.order',
    [['name', '=like', 'F%-%-%']],
    ['client_order_ref'],
    { limit: 100000 }
  );

  const odooRefs = new Set(allOrders.map(o => o.client_order_ref).filter(Boolean));
  console.log('Odoo orders with ref:', odooRefs.size);

  // Find missing orders and group by marketplace
  const missingByMarketplace = {};
  const missingByMonth = {};
  const missingOrders = [];

  for (const [orderId, info] of vcsOrders) {
    if (!odooRefs.has(orderId)) {
      missingOrders.push({ orderId, ...info });

      // By marketplace
      missingByMarketplace[info.marketplace] = (missingByMarketplace[info.marketplace] || 0) + 1;

      // By month
      const match = info.shipDate?.match(/(\d{2})-([A-Za-z]{3})-(\d{4})/);
      if (match) {
        const monthKey = match[2] + '-' + match[3];
        missingByMonth[monthKey] = (missingByMonth[monthKey] || 0) + 1;
      }
    }
  }

  console.log('\n========================================');
  console.log('MISSING ORDERS:', missingOrders.length);
  console.log('========================================\n');

  console.log('By MARKETPLACE:');
  const sorted = Object.entries(missingByMarketplace).sort((a, b) => b[1] - a[1]);
  for (const [mp, count] of sorted) {
    console.log('  ' + mp + ': ' + count);
  }

  console.log('\nBy MONTH:');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const sortedMonths = Object.entries(missingByMonth).sort((a, b) => {
    const [am, ay] = a[0].split('-');
    const [bm, by] = b[0].split('-');
    const aIdx = months.indexOf(am);
    const bIdx = months.indexOf(bm);
    return (ay + aIdx.toString().padStart(2, '0')).localeCompare(by + bIdx.toString().padStart(2, '0'));
  });
  for (const [month, count] of sortedMonths) {
    console.log('  ' + month + ': ' + count);
  }

  // Save missing orders to file
  fs.writeFileSync('/tmp/missing_orders.json', JSON.stringify(missingOrders, null, 2));
  console.log('\nMissing orders saved to /tmp/missing_orders.json');
}

analyzeGap().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
