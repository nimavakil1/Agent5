require('dotenv').config();
const { MongoClient } = require('mongodb');

async function testConsolidate() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();

  // Simulate what the consolidate/:groupId endpoint does
  const fcPartyId = 'BRE4';
  const dateStr = '2026-01-12';

  const query = {
    channel: 'amazon-vendor',
    'amazonVendor.shipToParty.partyId': fcPartyId,
    consolidationOverride: { $ne: true },
    'amazonVendor.purchaseOrderState': { $in: ['New', 'Acknowledged'] },
    'amazonVendor.shipmentStatus': 'not_shipped',
    _testData: { $ne: true },
    'sourceIds.amazonVendorPONumber': { $not: /^TST/ }
  };

  // Add date filter
  const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
  const endOfDay = new Date(dateStr + 'T00:00:00.000Z');
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
  query['amazonVendor.deliveryWindow.endDate'] = { $gte: startOfDay, $lt: endOfDay };

  const orders = await db.collection('unified_orders').find(query).toArray();
  console.log('Found', orders.length, 'orders');

  // Build consolidatedItems - same logic as vendor.api.js
  const itemMap = {};
  for (const order of orders) {
    for (const item of (order.items || [])) {
      const key = item.vendorProductIdentifier || item.amazonProductIdentifier;

      if (!itemMap[key]) {
        const displaySku = item.odooSku || item.sku || item.vendorProductIdentifier || '-';
        const displayName = item.odooProductName || item.name || item.title ||
          (item.vendorProductIdentifier ? 'Product ' + item.vendorProductIdentifier : '-');

        itemMap[key] = {
          vendorProductIdentifier: item.vendorProductIdentifier,
          odooSku: displaySku,
          odooBarcode: item.odooBarcode,
          odooProductName: displayName,
          totalQty: 0
        };
      }

      const qty = item.orderedQuantity?.amount || item.quantity || 0;
      itemMap[key].totalQty += qty;
    }
  }

  console.log('\nConsolidated items:');
  for (const [key, item] of Object.entries(itemMap)) {
    console.log('Key:', key);
    console.log('  odooSku:', item.odooSku);
    console.log('  odooBarcode:', item.odooBarcode);
    console.log('  odooProductName:', item.odooProductName);
    console.log('  totalQty:', item.totalQty);
    console.log('');
  }

  await client.close();
}

testConsolidate().catch(e => { console.error(e); process.exit(1); });
