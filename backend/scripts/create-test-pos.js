const { MongoClient } = require('mongodb');

async function createConsolidatableTestPOs() {
  const client = await MongoClient.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  const db = client.db();
  const collection = db.collection('vendor_purchase_orders');

  // First, delete existing test data
  const deleted = await collection.deleteMany({ _testData: true });
  console.log('Deleted', deleted.deletedCount, 'existing test POs');

  // Get a template PO for items structure
  const template = await collection.findOne({ items: { $exists: true, $ne: [] } });
  if (!template) {
    console.log('No template PO found');
    await client.close();
    return;
  }

  const now = new Date();
  const deliveryDate1 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const deliveryDate2 = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000); // 10 days

  // Create test POs - multiple per FC for consolidation
  const testPOs = [
    // DTM1 - 3 orders for same delivery window (consolidatable!)
    { fc: 'DTM1', fcName: 'Dortmund', deliveryEnd: deliveryDate1, poNum: 1 },
    { fc: 'DTM1', fcName: 'Dortmund', deliveryEnd: deliveryDate1, poNum: 2 },
    { fc: 'DTM1', fcName: 'Dortmund', deliveryEnd: deliveryDate1, poNum: 3 },

    // DTM2 - 2 orders (consolidatable!)
    { fc: 'DTM2', fcName: 'Werne', deliveryEnd: deliveryDate1, poNum: 4 },
    { fc: 'DTM2', fcName: 'Werne', deliveryEnd: deliveryDate1, poNum: 5 },

    // XOR1 - 2 orders different delivery window
    { fc: 'XOR1', fcName: 'Oranienburg', deliveryEnd: deliveryDate1, poNum: 6 },
    { fc: 'XOR1', fcName: 'Oranienburg', deliveryEnd: deliveryDate2, poNum: 7 },

    // LEJ1 - 3 orders (consolidatable!)
    { fc: 'LEJ1', fcName: 'Leipzig', deliveryEnd: deliveryDate2, poNum: 8 },
    { fc: 'LEJ1', fcName: 'Leipzig', deliveryEnd: deliveryDate2, poNum: 9 },
    { fc: 'LEJ1', fcName: 'Leipzig', deliveryEnd: deliveryDate2, poNum: 10 },
  ];

  const created = [];

  for (const config of testPOs) {
    // Use different items from template for variety
    const numItems = Math.floor(Math.random() * 3) + 1;
    const itemsToUse = template.items.slice(0, numItems);

    const items = itemsToUse.map((item, idx) => {
      const qty = Math.floor(Math.random() * 20) + 5;
      const price = item.netCost?.amount || 5;
      return {
        ...item,
        itemSequenceNumber: String(idx + 1),
        orderedQuantity: {
          amount: qty,
          unitOfMeasure: 'Each'
        }
      };
    });

    const totalUnits = items.reduce((sum, item) => sum + (item.orderedQuantity?.amount || 0), 0);
    const totalAmount = items.reduce((sum, item) => {
      const qty = item.orderedQuantity?.amount || 0;
      const price = item.netCost?.amount || 5;
      return sum + (qty * price);
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
      buyingParty: template.buyingParty,
      sellingParty: template.sellingParty,
      items: items,
      totals: {
        totalUnits,
        totalAmount,
        currency: 'EUR'
      },
      odoo: null,
      invoice: null,
      shipment: null,
      acknowledgment: null
    };

    await collection.insertOne(testPO);
    created.push(testPO.purchaseOrderNumber + ' -> ' + config.fc);
  }

  console.log('\nCreated', created.length, 'test POs:');
  created.forEach(p => console.log(' ', p));

  // Summary
  console.log('\nConsolidation groups:');
  console.log('  DTM1 (Dortmund): 3 POs - ' + deliveryDate1.toISOString().split('T')[0]);
  console.log('  DTM2 (Werne): 2 POs - ' + deliveryDate1.toISOString().split('T')[0]);
  console.log('  XOR1 (Oranienburg): 1 PO each on 2 different dates');
  console.log('  LEJ1 (Leipzig): 3 POs - ' + deliveryDate2.toISOString().split('T')[0]);

  await client.close();
}

createConsolidatableTestPOs().catch(console.error);
