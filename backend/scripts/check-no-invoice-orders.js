require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');

// Parse CSV helper
function parseCSV(content) {
  const lines = content.split('\n');
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => row[h] = values[idx] || '');
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else current += char;
  }
  result.push(current.trim());
  return result;
}

async function main() {
  console.log('=== CHECK ORDERS WITHOUT INVOICES ===\n');

  // Load VCS data
  const vcsFiles = [
    '/Users/nimavakil/Downloads/taxReport_c26b0feaf8d3ff691909ff5ae0bc274897c92e8b.csv',
    '/Users/nimavakil/Downloads/taxReport_07c4ec70eff1c89a26c1d786aba98e822e0691c0.csv'
  ];

  const vcsOrderIds = new Set();
  for (const file of vcsFiles) {
    console.log('Loading: ' + file.split('/').pop());
    const rows = parseCSV(fs.readFileSync(file, 'utf-8'));
    rows.forEach(r => { if (r['Order ID']) vcsOrderIds.add(r['Order ID']); });
  }
  console.log('VCS order IDs loaded: ' + vcsOrderIds.size + '\n');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get orders WITHOUT invoices
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '=', false],
      '|', ['name', 'like', 'FBA%'], ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'date_order'],
    { limit: 5000 }
  );

  console.log('Orders without invoices: ' + orders.length);

  let inVcs = 0;
  let notInVcs = [];

  for (const order of orders) {
    const amazonId = order.name.replace(/^FBA|^FBM/, '');
    if (vcsOrderIds.has(amazonId)) {
      inVcs++;
    } else {
      notInVcs.push({
        name: order.name,
        amazonId,
        amount: order.amount_total,
        date: order.date_order ? order.date_order.substring(0, 10) : ''
      });
    }
  }

  console.log('  In VCS: ' + inVcs);
  console.log('  NOT in VCS: ' + notInVcs.length);

  // Date breakdown of NOT in VCS
  const byMonth = {};
  for (const o of notInVcs) {
    const month = o.date ? o.date.substring(0, 7) : 'unknown';
    byMonth[month] = (byMonth[month] || 0) + 1;
  }
  console.log('\nOrders NOT in VCS by month:');
  Object.keys(byMonth).sort().forEach(m => console.log('  ' + m + ': ' + byMonth[m]));

  // Export
  const csv = 'Order Name,Amazon ID,Amount,Date\n' +
    notInVcs.map(o => [o.name, o.amazonId, o.amount.toFixed(2), o.date].join(',')).join('\n');
  fs.writeFileSync('/Users/nimavakil/Downloads/NO_INVOICE_NOT_IN_VCS.csv', csv);
  console.log('\nExported to ~/Downloads/NO_INVOICE_NOT_IN_VCS.csv');
}

main().catch(e => console.error(e));
