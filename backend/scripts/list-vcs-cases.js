const { MongoClient } = require('mongodb');
require('dotenv').config();

async function run() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();

  // Get distinct tax schemes and routes
  const orders = await db.collection('amazon_vcs_orders')
    .find({ status: 'pending' })
    .project({
      orderId: 1,
      taxReportingScheme: 1,
      shipFromCountry: 1,
      shipToCountry: 1,
      totalExclusive: 1,
      totalTax: 1,
      totalInclusive: 1,
      buyerTaxRegistration: 1,
      currency: 1,
      items: 1
    })
    .limit(50)
    .toArray();

  console.log('=== PENDING VCS ORDERS - DIFFERENT CASES ===\n');
  console.log('Total pending orders:', orders.length);
  console.log('');

  // Group by tax scheme and route
  const cases = {};
  orders.forEach(o => {
    const b2b = o.buyerTaxRegistration ? ' (B2B: ' + o.buyerTaxRegistration + ')' : '';
    const key = (o.taxReportingScheme || 'Unknown') + ' | ' + (o.shipFromCountry || '?') + ' → ' + (o.shipToCountry || '?') + b2b;
    if (!cases[key]) cases[key] = [];
    cases[key].push(o);
  });

  for (const [caseType, orderList] of Object.entries(cases)) {
    console.log('-------------------------------------------');
    console.log('CASE:', caseType);
    console.log('Count:', orderList.length);
    console.log('Example orders:');
    orderList.slice(0, 3).forEach(o => {
      const sku = o.items && o.items[0] ? o.items[0].sku : 'N/A';
      const net = o.totalExclusive ? o.totalExclusive.toFixed(2) : '0.00';
      const vat = o.totalTax ? o.totalTax.toFixed(2) : '0.00';
      const total = o.totalInclusive ? o.totalInclusive.toFixed(2) : '0.00';
      console.log('  -', o.orderId);
      console.log('    SKU:', sku, '| Net:', net, '| VAT:', vat, '| Total:', total, o.currency || 'EUR');
    });
    console.log('');
  }

  await client.close();
}
run().catch(console.error);
