/**
 * Export Orders Needing Invoice
 *
 * Exports all Odoo orders with "to invoice" status to CSV
 * Columns: Odoo order nr, Amazon order nr, order date, ship-to-country, Amount EX VAT, VAT amount
 */

const fs = require('fs');
const xmlrpc = require('xmlrpc');

// Odoo connection
const ODOO_URL = 'acropaq.odoo.com';
const ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670';
const ODOO_USERNAME = 'nima@acropaq.com';
const ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd';

const commonClient = xmlrpc.createSecureClient({
  host: ODOO_URL,
  port: 443,
  path: '/xmlrpc/2/common'
});
const objectClient = xmlrpc.createSecureClient({
  host: ODOO_URL,
  port: 443,
  path: '/xmlrpc/2/object'
});

let uid = null;

function authenticate() {
  return new Promise((resolve, reject) => {
    commonClient.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function execute(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    objectClient.methodCall('execute_kw', [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('='.repeat(60));
  console.log('Export Orders Needing Invoice');
  console.log('='.repeat(60));

  // Connect to Odoo
  console.log('\nConnecting to Odoo...');
  uid = await authenticate();
  console.log(`Connected as uid: ${uid}`);

  // Get total count first
  console.log('\nCounting orders with "to invoice" status...');
  const totalCount = await execute('sale.order', 'search_count', [
    [['invoice_status', '=', 'to invoice']]
  ]);
  console.log(`Total orders to export: ${totalCount}`);

  // Fetch in batches
  const batchSize = 500;
  const allOrders = [];

  console.log('\nFetching orders...');
  for (let offset = 0; offset < totalCount; offset += batchSize) {
    const orders = await execute('sale.order', 'search_read', [
      [['invoice_status', '=', 'to invoice']]
    ], {
      fields: ['name', 'amz_order_reference', 'date_order', 'partner_shipping_id', 'amount_untaxed', 'amount_tax'],
      offset: offset,
      limit: batchSize,
      order: 'date_order desc'
    });

    allOrders.push(...orders);
    console.log(`  Fetched ${Math.min(offset + batchSize, totalCount)}/${totalCount}`);
    await sleep(100);
  }

  // Get unique partner IDs to fetch countries
  console.log('\nFetching shipping country information...');
  const partnerIds = [...new Set(allOrders.map(o => o.partner_shipping_id ? o.partner_shipping_id[0] : null).filter(Boolean))];

  // Fetch partner countries in batches
  const partnerCountryMap = {};
  for (let i = 0; i < partnerIds.length; i += batchSize) {
    const batchIds = partnerIds.slice(i, i + batchSize);
    const partners = await execute('res.partner', 'search_read', [
      [['id', 'in', batchIds]]
    ], {
      fields: ['id', 'country_id']
    });

    for (const p of partners) {
      partnerCountryMap[p.id] = p.country_id ? p.country_id[1] : '';
    }

    if ((i + batchSize) % 2000 === 0 || i + batchSize >= partnerIds.length) {
      console.log(`  Fetched countries for ${Math.min(i + batchSize, partnerIds.length)}/${partnerIds.length} partners`);
    }
    await sleep(50);
  }

  // Build CSV
  console.log('\nBuilding CSV...');
  const csvLines = ['Odoo Order Nr,Amazon Order Nr,Order Date,Ship-to Country,Amount EX VAT,VAT Amount'];

  for (const order of allOrders) {
    const odooOrderNr = order.name || '';
    const amazonOrderNr = order.amz_order_reference || '';
    const orderDate = order.date_order ? order.date_order.split(' ')[0] : '';
    const partnerId = order.partner_shipping_id ? order.partner_shipping_id[0] : null;
    const shipToCountry = partnerId ? (partnerCountryMap[partnerId] || '') : '';
    const amountExVat = (order.amount_untaxed || 0).toFixed(2);
    const vatAmount = (order.amount_tax || 0).toFixed(2);

    // Escape fields that might contain commas
    const escapeCsv = (val) => {
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    csvLines.push([
      escapeCsv(odooOrderNr),
      escapeCsv(amazonOrderNr),
      orderDate,
      escapeCsv(shipToCountry),
      amountExVat,
      vatAmount
    ].join(','));
  }

  // Write to file
  const outputPath = '/Users/nimavakil/Agent5/backend/output/to-invoice-orders.csv';

  // Ensure output directory exists
  const outputDir = '/Users/nimavakil/Agent5/backend/output';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, csvLines.join('\n'), 'utf-8');

  console.log('\n' + '='.repeat(60));
  console.log('EXPORT COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total orders exported: ${allOrders.length}`);
  console.log(`Output file: ${outputPath}`);

  // Summary by country
  const byCountry = {};
  for (const order of allOrders) {
    const partnerId = order.partner_shipping_id ? order.partner_shipping_id[0] : null;
    const country = partnerId ? (partnerCountryMap[partnerId] || 'Unknown') : 'Unknown';
    byCountry[country] = (byCountry[country] || 0) + 1;
  }

  console.log('\nOrders by ship-to country:');
  const sortedCountries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]);
  for (const [country, count] of sortedCountries.slice(0, 15)) {
    console.log(`  ${country}: ${count}`);
  }
  if (sortedCountries.length > 15) {
    console.log(`  ... and ${sortedCountries.length - 15} more countries`);
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
