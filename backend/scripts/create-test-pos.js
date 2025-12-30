const { MongoClient } = require('mongodb');

async function createConsolidatableTestPOs() {
  const client = await MongoClient.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  const db = client.db();
  const collection = db.collection('vendor_purchase_orders');

  // First, delete existing test data
  const deleted = await collection.deleteMany({ _testData: true });
  console.log('Deleted', deleted.deletedCount, 'existing test POs');

  // Get template for buyingParty/sellingParty
  const template = await collection.findOne({ buyingParty: { $exists: true } });

  const now = new Date();
  const deliveryDate1 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Define a catalog of test products
  const productCatalog = [
    { ean: '5400882001234', asin: 'B00TEST001', name: 'Acropaq Laminating Pouches A4 100-pack', sku: 'LAM-A4-100', price: 12.50 },
    { ean: '5400882001235', asin: 'B00TEST002', name: 'Acropaq Laminating Pouches A3 50-pack', sku: 'LAM-A3-50', price: 18.90 },
    { ean: '5400882001236', asin: 'B00TEST003', name: 'Acropaq Paper Trimmer A4', sku: 'TRIM-A4', price: 24.99 },
    { ean: '5400882001237', asin: 'B00TEST004', name: 'Acropaq Binding Machine', sku: 'BIND-01', price: 45.00 },
    { ean: '5400882001238', asin: 'B00TEST005', name: 'Acropaq Binding Combs 100-pack', sku: 'COMB-100', price: 8.50 },
    { ean: '5400882001239', asin: 'B00TEST006', name: 'Acropaq Laminator A4', sku: 'LMTR-A4', price: 35.00 },
    { ean: '5400882001240', asin: 'B00TEST007', name: 'Acropaq Laminator A3', sku: 'LMTR-A3', price: 55.00 },
    { ean: '5400882001241', asin: 'B00TEST008', name: 'Acropaq Paper Shredder', sku: 'SHRED-01', price: 89.00 },
  ];

  // Define PO configurations with specific items
  // DTM1 group: 3 POs with overlapping products
  const poConfigs = [
    // === DTM1 GROUP (3 POs) ===
    // PO1: Products 0, 1, 2 (Pouches A4, Pouches A3, Trimmer)
    {
      fc: 'DTM1', fcName: 'Dortmund', deliveryEnd: deliveryDate1, poNum: 1,
      items: [
        { productIdx: 0, qty: 50 },  // Pouches A4 - appears in PO1 & PO2 (will be consolidated)
        { productIdx: 1, qty: 25 },  // Pouches A3 - appears in PO1 & PO3 (will be consolidated)
        { productIdx: 2, qty: 10 },  // Trimmer - only in PO1
      ]
    },
    // PO2: Products 0, 3, 4 (Pouches A4, Binding Machine, Binding Combs)
    {
      fc: 'DTM1', fcName: 'Dortmund', deliveryEnd: deliveryDate1, poNum: 2,
      items: [
        { productIdx: 0, qty: 30 },  // Pouches A4 - also in PO1 (consolidated: 50+30=80)
        { productIdx: 3, qty: 5 },   // Binding Machine - only in PO2
        { productIdx: 4, qty: 100 }, // Binding Combs - appears in PO2 & PO3
      ]
    },
    // PO3: Products 1, 4, 5 (Pouches A3, Binding Combs, Laminator A4)
    {
      fc: 'DTM1', fcName: 'Dortmund', deliveryEnd: deliveryDate1, poNum: 3,
      items: [
        { productIdx: 1, qty: 15 },  // Pouches A3 - also in PO1 (consolidated: 25+15=40)
        { productIdx: 4, qty: 50 },  // Binding Combs - also in PO2 (consolidated: 100+50=150)
        { productIdx: 5, qty: 20 },  // Laminator A4 - only in PO3
      ]
    },

    // === DTM2 GROUP (2 POs) ===
    // PO4: Products 6, 7 (Laminator A3, Shredder)
    {
      fc: 'DTM2', fcName: 'Werne', deliveryEnd: deliveryDate1, poNum: 4,
      items: [
        { productIdx: 6, qty: 8 },   // Laminator A3 - appears in both PO4 & PO5
        { productIdx: 7, qty: 3 },   // Shredder - only in PO4
      ]
    },
    // PO5: Products 6, 0, 2 (Laminator A3, Pouches A4, Trimmer)
    {
      fc: 'DTM2', fcName: 'Werne', deliveryEnd: deliveryDate1, poNum: 5,
      items: [
        { productIdx: 6, qty: 12 },  // Laminator A3 - also in PO4 (consolidated: 8+12=20)
        { productIdx: 0, qty: 40 },  // Pouches A4 - only in PO5 for this group
        { productIdx: 2, qty: 15 },  // Trimmer - only in PO5 for this group
      ]
    },
  ];

  const created = [];

  for (const config of poConfigs) {
    const items = config.items.map((itemConfig, idx) => {
      const product = productCatalog[itemConfig.productIdx];
      return {
        itemSequenceNumber: String(idx + 1),
        vendorProductIdentifier: product.ean,
        amazonProductIdentifier: product.asin,
        odooProductId: 1000 + itemConfig.productIdx,
        odooProductName: product.name,
        odooSku: product.sku,
        orderedQuantity: {
          amount: itemConfig.qty,
          unitOfMeasure: 'Each'
        },
        netCost: {
          amount: product.price,
          currencyCode: 'EUR'
        }
      };
    });

    const totalUnits = items.reduce((sum, item) => sum + item.orderedQuantity.amount, 0);
    const totalAmount = items.reduce((sum, item) => {
      return sum + (item.orderedQuantity.amount * item.netCost.amount);
    }, 0);

    const testPO = {
      purchaseOrderNumber: 'TEST-PO-' + now.getTime() + '-' + config.poNum,
      purchaseOrderState: 'New',
      purchaseOrderType: 'RegularOrder',
      purchaseOrderDate: now,
      marketplaceId: 'DE',
      _testData: true,
      _generatedAt: now,
      deliveryWindow: {
        startDate: new Date(config.deliveryEnd.getTime() - 3 * 24 * 60 * 60 * 1000),
        endDate: config.deliveryEnd
      },
      shipToParty: {
        partyId: config.fc,
        address: {
          name: 'Amazon ' + config.fcName + ' ' + config.fc,
          city: config.fcName,
          countryCode: 'DE'
        }
      },
      buyingParty: template?.buyingParty || { partyId: 'AMAZON' },
      sellingParty: template?.sellingParty || { partyId: 'ACROPAQ' },
      items: items,
      totals: {
        totalUnits,
        totalAmount: Math.round(totalAmount * 100) / 100,
        currency: 'EUR'
      },
      odoo: null,
      invoice: null,
      shipment: null,
      acknowledgment: null
    };

    await collection.insertOne(testPO);
    created.push({
      po: testPO.purchaseOrderNumber,
      fc: config.fc,
      items: items.length,
      products: items.map(i => i.odooSku).join(', ')
    });
  }

  console.log('\nCreated', created.length, 'test POs:\n');

  // Group by FC for display
  const byFC = {};
  created.forEach(c => {
    if (!byFC[c.fc]) byFC[c.fc] = [];
    byFC[c.fc].push(c);
  });

  for (const [fc, pos] of Object.entries(byFC)) {
    console.log(`=== ${fc} ===`);
    pos.forEach(p => {
      console.log(`  ${p.po}: ${p.items} items (${p.products})`);
    });
    console.log('');
  }

  console.log('Expected consolidation results:');
  console.log('DTM1 group should consolidate to 6 unique products:');
  console.log('  - LAM-A4-100: 50+30 = 80 units (from PO1+PO2)');
  console.log('  - LAM-A3-50: 25+15 = 40 units (from PO1+PO3)');
  console.log('  - TRIM-A4: 10 units (from PO1 only)');
  console.log('  - BIND-01: 5 units (from PO2 only)');
  console.log('  - COMB-100: 100+50 = 150 units (from PO2+PO3)');
  console.log('  - LMTR-A4: 20 units (from PO3 only)');
  console.log('');
  console.log('DTM2 group should consolidate to 4 unique products:');
  console.log('  - LMTR-A3: 8+12 = 20 units (from PO4+PO5)');
  console.log('  - SHRED-01: 3 units (from PO4 only)');
  console.log('  - LAM-A4-100: 40 units (from PO5 only)');
  console.log('  - TRIM-A4: 15 units (from PO5 only)');

  await client.close();
}

createConsolidatableTestPOs().catch(console.error);
