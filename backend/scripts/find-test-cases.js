const { MongoClient } = require('mongodb');
require('dotenv').config();

async function run() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();

  const allOrders = await db.collection('amazon_vcs_orders')
    .find({ status: 'pending' })
    .toArray();

  console.log('=== FINDING TEST CASES ===\n');
  console.log('Total pending orders:', allOrders.length, '\n');

  const testCases = {};

  // Helper to add a test case
  const addCase = (name, order) => {
    if (!testCases[name]) {
      const sku = order.items && order.items[0] ? order.items[0].sku : 'N/A';
      testCases[name] = {
        orderId: order.orderId,
        sku: sku,
        scheme: order.taxReportingScheme || 'Unknown',
        route: `${order.shipFromCountry || '?'} → ${order.shipToCountry || '?'}`,
        net: (order.totalExclusive || 0).toFixed(2),
        vat: (order.totalTax || 0).toFixed(2),
        total: (order.totalInclusive || 0).toFixed(2),
        buyerVat: order.buyerTaxRegistration || null
      };
    }
  };

  for (const order of allOrders) {
    const sku = order.items && order.items[0] ? order.items[0].sku : '';
    const from = order.shipFromCountry;
    const to = order.shipToCountry;
    const scheme = order.taxReportingScheme;
    const buyerVat = order.buyerTaxRegistration;

    // 1. FBM order (has -FBM suffix)
    if (sku.includes('-FBM')) {
      addCase('1. FBM Order (-FBM suffix)', order);
    }

    // 2. FBA order (no -FBM suffix, from Amazon warehouse)
    if (!sku.includes('-FBM') && from && from !== 'BE') {
      addCase('2. FBA Order (from Amazon warehouse)', order);
    }

    // 3. Return SKU (long strange SKUs or R4 suffix)
    if (sku.includes('R4') || sku.length > 15) {
      addCase('3. Return/Strange SKU (R4 or long)', order);
    }

    // 4. Stickerless SKU
    if (sku.includes('-stickerless') || sku.includes('-stickerles')) {
      addCase('4. Stickerless SKU', order);
    }

    // 5. OSS (VCS_EU_OSS)
    if (scheme === 'VCS_EU_OSS') {
      addCase('5. OSS Order (VCS_EU_OSS)', order);
    }

    // 6. Intra-community B2B (EU to EU with buyer VAT, 0% VAT)
    if (buyerVat && from !== to && order.totalTax === 0) {
      addCase('6. Intra-Community B2B (reverse charge)', order);
    }

    // 7. Belgian B2B (BE to BE with Belgian VAT)
    if (from === 'BE' && to === 'BE' && buyerVat && buyerVat.startsWith('BE')) {
      addCase('7. Belgian B2B (domestic)', order);
    }

    // 8. German B2B (DE to DE with German VAT)
    if (from === 'DE' && to === 'DE' && buyerVat && buyerVat.startsWith('DE')) {
      addCase('8. German B2B (domestic)', order);
    }

    // 9. Different country routes
    const routeKey = `${from} → ${to}`;
    if (from && to) {
      addCase(`Route: ${routeKey}`, order);
    }
  }

  // Print test cases
  console.log('=== RECOMMENDED TEST CASES ===\n');

  const priority = [
    '1. FBM Order (-FBM suffix)',
    '2. FBA Order (from Amazon warehouse)',
    '3. Return/Strange SKU (R4 or long)',
    '4. Stickerless SKU',
    '5. OSS Order (VCS_EU_OSS)',
    '6. Intra-Community B2B (reverse charge)',
    '7. Belgian B2B (domestic)',
    '8. German B2B (domestic)',
  ];

  for (const key of priority) {
    if (testCases[key]) {
      const tc = testCases[key];
      console.log('-------------------------------------------');
      console.log('CASE:', key);
      console.log('  Order ID:', tc.orderId);
      console.log('  SKU:', tc.sku);
      console.log('  Scheme:', tc.scheme);
      console.log('  Route:', tc.route);
      console.log('  Net:', tc.net, '| VAT:', tc.vat, '| Total:', tc.total, 'EUR');
      if (tc.buyerVat) console.log('  Buyer VAT:', tc.buyerVat);
      console.log('');
    } else {
      console.log('-------------------------------------------');
      console.log('CASE:', key);
      console.log('  ⚠️  NOT FOUND in pending orders');
      console.log('');
    }
  }

  // Print unique routes
  console.log('=== ALL UNIQUE ROUTES ===\n');
  const routes = Object.keys(testCases).filter(k => k.startsWith('Route:'));
  routes.forEach(r => {
    const tc = testCases[r];
    console.log(r, '- Order:', tc.orderId, '| SKU:', tc.sku);
  });

  await client.close();
}
run().catch(console.error);
