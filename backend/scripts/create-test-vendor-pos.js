/**
 * Create test Vendor Purchase Orders with real products from Odoo
 * Products have real weights for accurate parcel weight calculation
 */

const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Amazon FC addresses
const FC_ADDRESSES = {
  DTM1: {
    partyId: 'DTM1',
    name: 'Amazon DTM1',
    address: {
      name: 'Amazon EU Sarl',
      addressLine1: 'Amazonstrasse 1',
      city: 'Dortmund',
      postalCode: '44145',
      countryCode: 'DE'
    }
  },
  LEJ1: {
    partyId: 'LEJ1',
    name: 'Amazon LEJ1',
    address: {
      name: 'Amazon EU Sarl',
      addressLine1: 'Amazonstrasse 1',
      city: 'Leipzig',
      postalCode: '04347',
      countryCode: 'DE'
    }
  },
  WRO5: {
    partyId: 'WRO5',
    name: 'Amazon WRO5',
    address: {
      name: 'Amazon EU Sarl',
      addressLine1: 'Amazonstrasse 1',
      city: 'Wroclaw',
      postalCode: '55-040',
      countryCode: 'PL'
    }
  }
};

async function createTestPOs() {
  console.log('Fetching products from Odoo...');

  // Get products with weights from Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const products = await odoo.searchRead('product.product',
    [['weight', '>', 0], ['barcode', '!=', false], ['active', '=', true]],
    ['id', 'name', 'default_code', 'barcode', 'weight', 'list_price'],
    100
  );

  console.log(`Found ${products.length} products with weights`);

  // Categorize products by weight for realistic scenarios
  const lightProducts = products.filter(p => p.weight <= 0.5);   // Under 500g
  const mediumProducts = products.filter(p => p.weight > 0.5 && p.weight <= 2);  // 500g - 2kg
  const heavyProducts = products.filter(p => p.weight > 2);  // Over 2kg

  console.log(`Light (≤0.5kg): ${lightProducts.length}, Medium (0.5-2kg): ${mediumProducts.length}, Heavy (>2kg): ${heavyProducts.length}`);

  // Connect to MongoDB
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5');
  await client.connect();
  const db = client.db();
  const collection = db.collection('vendor_purchase_orders');

  // Create delivery window (5 days from now)
  const deliveryStart = new Date();
  deliveryStart.setDate(deliveryStart.getDate() + 4);
  const deliveryEnd = new Date();
  deliveryEnd.setDate(deliveryEnd.getDate() + 5);

  const testPOs = [];

  // Helper to pick random products
  const pickRandom = (arr, count) => {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
  };

  // PO 1: DTM1 - Light products, many units (should fit in 1-2 parcels)
  const po1Products = pickRandom(lightProducts, 3);
  testPOs.push({
    purchaseOrderNumber: `TEST-${Date.now()}-001`,
    purchaseOrderDate: new Date().toISOString(),
    purchaseOrderState: 'Acknowledged',
    marketplaceId: 'DE',
    shipmentStatus: 'not_shipped',
    shipToParty: FC_ADDRESSES.DTM1,
    deliveryWindow: {
      startDate: deliveryStart.toISOString(),
      endDate: deliveryEnd.toISOString()
    },
    items: po1Products.map((p, i) => ({
      itemSequenceNumber: i + 1,
      vendorProductIdentifier: p.barcode,
      amazonProductIdentifier: `B0${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
      orderedQuantity: { amount: Math.floor(Math.random() * 20) + 10, unitOfMeasure: 'Each' },
      netCost: { amount: p.list_price * 0.6, currencyCode: 'EUR' },
      odooProductId: p.id,
      odooProductName: p.name,
      odooSku: p.default_code,
      weight: p.weight
    })),
    totals: {},
    _testData: true
  });

  // PO 2: DTM1 - Same FC, different products (will consolidate with PO1)
  const po2Products = pickRandom(mediumProducts, 2);
  testPOs.push({
    purchaseOrderNumber: `TEST-${Date.now()}-002`,
    purchaseOrderDate: new Date().toISOString(),
    purchaseOrderState: 'Acknowledged',
    marketplaceId: 'DE',
    shipmentStatus: 'not_shipped',
    shipToParty: FC_ADDRESSES.DTM1,
    deliveryWindow: {
      startDate: deliveryStart.toISOString(),
      endDate: deliveryEnd.toISOString()
    },
    items: po2Products.map((p, i) => ({
      itemSequenceNumber: i + 1,
      vendorProductIdentifier: p.barcode,
      amazonProductIdentifier: `B0${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
      orderedQuantity: { amount: Math.floor(Math.random() * 10) + 5, unitOfMeasure: 'Each' },
      netCost: { amount: p.list_price * 0.6, currencyCode: 'EUR' },
      odooProductId: p.id,
      odooProductName: p.name,
      odooSku: p.default_code,
      weight: p.weight
    })),
    totals: {},
    _testData: true
  });

  // PO 3: DTM1 - Heavy products (will trigger overweight warning!)
  const po3Products = pickRandom(heavyProducts, 3);
  testPOs.push({
    purchaseOrderNumber: `TEST-${Date.now()}-003`,
    purchaseOrderDate: new Date().toISOString(),
    purchaseOrderState: 'Acknowledged',
    marketplaceId: 'DE',
    shipmentStatus: 'not_shipped',
    shipToParty: FC_ADDRESSES.DTM1,
    deliveryWindow: {
      startDate: deliveryStart.toISOString(),
      endDate: deliveryEnd.toISOString()
    },
    items: po3Products.map((p, i) => ({
      itemSequenceNumber: i + 1,
      vendorProductIdentifier: p.barcode,
      amazonProductIdentifier: `B0${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
      orderedQuantity: { amount: Math.floor(Math.random() * 5) + 3, unitOfMeasure: 'Each' },  // Fewer but heavy
      netCost: { amount: p.list_price * 0.6, currencyCode: 'EUR' },
      odooProductId: p.id,
      odooProductName: p.name,
      odooSku: p.default_code,
      weight: p.weight
    })),
    totals: {},
    _testData: true
  });

  // PO 4: LEJ1 - Different FC (separate consolidation group)
  const po4Products = pickRandom([...lightProducts, ...mediumProducts], 4);
  testPOs.push({
    purchaseOrderNumber: `TEST-${Date.now()}-004`,
    purchaseOrderDate: new Date().toISOString(),
    purchaseOrderState: 'Acknowledged',
    marketplaceId: 'DE',
    shipmentStatus: 'not_shipped',
    shipToParty: FC_ADDRESSES.LEJ1,
    deliveryWindow: {
      startDate: deliveryStart.toISOString(),
      endDate: deliveryEnd.toISOString()
    },
    items: po4Products.map((p, i) => ({
      itemSequenceNumber: i + 1,
      vendorProductIdentifier: p.barcode,
      amazonProductIdentifier: `B0${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
      orderedQuantity: { amount: Math.floor(Math.random() * 15) + 5, unitOfMeasure: 'Each' },
      netCost: { amount: p.list_price * 0.6, currencyCode: 'EUR' },
      odooProductId: p.id,
      odooProductName: p.name,
      odooSku: p.default_code,
      weight: p.weight
    })),
    totals: {},
    _testData: true
  });

  // Calculate totals for each PO
  for (const po of testPOs) {
    let totalUnits = 0;
    let totalAmount = 0;
    let totalWeight = 0;

    for (const item of po.items) {
      totalUnits += item.orderedQuantity.amount;
      totalAmount += item.orderedQuantity.amount * (item.netCost?.amount || 0);
      totalWeight += item.orderedQuantity.amount * (item.weight || 0);
    }

    po.totals = {
      totalUnits,
      totalAmount,
      totalWeight,
      currency: 'EUR'
    };
  }

  // Insert test POs
  const result = await collection.insertMany(testPOs);
  console.log(`\nCreated ${result.insertedCount} test purchase orders`);

  // Print summary
  console.log('\n=== Test POs Created ===');
  for (const po of testPOs) {
    console.log(`\n${po.purchaseOrderNumber}`);
    console.log(`  FC: ${po.shipToParty.partyId}`);
    console.log(`  Items: ${po.items.length} products, ${po.totals.totalUnits} units`);
    console.log(`  Total Weight: ${po.totals.totalWeight.toFixed(2)} kg`);
    console.log(`  Products:`);
    for (const item of po.items) {
      console.log(`    - ${item.odooSku}: ${item.orderedQuantity.amount}x @ ${item.weight}kg = ${(item.orderedQuantity.amount * item.weight).toFixed(2)}kg`);
    }
  }

  await client.close();
  console.log('\nDone!');
}

createTestPOs().catch(console.error);
