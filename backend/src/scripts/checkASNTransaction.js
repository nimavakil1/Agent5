/**
 * Check ASN Transaction Status with Amazon
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { connectDb, getDb } = require('../db');
const { VendorClient } = require('../services/amazon/vendor/VendorClient');

async function main() {
  await connectDb();
  const db = getDb();

  // Find the most recent consolidated shipment for 58AIYHEC
  const shipment = await db.collection('vendor_shipments').findOne({
    transactionId: '6fc54205-3bd9-4d3b-8f29-0f08a1f4bbfa-20260202113515'
  }) || await db.collection('vendor_shipments').findOne({
    shipmentId: { $regex: /CONS.*58AIYHEC/ }
  }, { sort: { submittedAt: -1 } });

  if (!shipment) {
    console.log('Shipment not found');
    return;
  }

  console.log('Shipment found:');
  console.log('  ID:', shipment.shipmentId);
  console.log('  Transaction:', shipment.transactionId);
  console.log('  Status:', shipment.status);
  console.log('  Submitted:', shipment.submittedAt);
  console.log('  Marketplace:', shipment.marketplaceId);
  console.log('  POs:', shipment.purchaseOrderNumbers?.join(', ') || shipment.purchaseOrderNumber);

  // Check transaction status with Amazon
  // Use the marketplaceId stored in shipment (which is now the token key based on vendor code)
  const tokenKey = shipment.marketplaceId || shipment.vendorCode === 'HN6VB' ? 'NL' : 'FR';
  console.log('\nChecking transaction status with Amazon using', tokenKey, 'credentials...');
  const client = new VendorClient(tokenKey);
  await client.init();

  try {
    const status = await client.getTransactionStatus(shipment.transactionId);
    console.log('\nAmazon Transaction Status:');
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    console.error('Error checking status:', error.message);
    if (error.response?.data) {
      console.log('Response data:', JSON.stringify(error.response.data, null, 2));
    }
  }

  // Also check what partyId is in the PO
  console.log('\n--- Checking PO partyId values ---');
  const po = await db.collection('unified_orders').findOne({
    'sourceIds.amazonVendorPONumber': '58AIYHEC'
  });

  if (po) {
    console.log('PO 58AIYHEC (unified_orders):');
    console.log('  unifiedOrderId:', po.unifiedOrderId);
    console.log('  sellingParty:', JSON.stringify(po.sellingParty));
    console.log('  amazonVendor.sellingParty:', JSON.stringify(po.amazonVendor?.sellingParty));
    console.log('  shipToParty:', JSON.stringify(po.shipToParty));
    console.log('  amazonVendor.shipToParty:', JSON.stringify(po.amazonVendor?.shipToParty));
  }

  // Check if there's also data in the old lookup format
  const poByUnifiedId = await db.collection('unified_orders').findOne({
    unifiedOrderId: 'AmazonVendor:58AIYHEC'
  });

  if (poByUnifiedId) {
    console.log('\nPO by unifiedOrderId (AmazonVendor:58AIYHEC):');
    console.log('  sellingParty:', JSON.stringify(poByUnifiedId.sellingParty));
    console.log('  amazonVendor.sellingParty:', JSON.stringify(poByUnifiedId.amazonVendor?.sellingParty));
  } else {
    console.log('\nNo PO found by unifiedOrderId: AmazonVendor:58AIYHEC');
  }

  // Check what the importer returns
  console.log('\n--- Checking VendorPOImporter.getPurchaseOrder result ---');
  const { getVendorPOImporter } = require('../services/amazon/vendor/VendorPOImporter');
  const importer = await getVendorPOImporter();
  const importerPO = await importer.getPurchaseOrder('58AIYHEC');

  if (importerPO) {
    console.log('Importer returned PO:');
    console.log('  sellingParty:', JSON.stringify(importerPO.sellingParty));
    console.log('  amazonVendor.sellingParty:', JSON.stringify(importerPO.amazonVendor?.sellingParty));
    console.log('  shipToParty:', JSON.stringify(importerPO.amazonVendor?.shipToParty));
    console.log('  importDetails:', JSON.stringify(importerPO.amazonVendor?.importDetails));
    console.log('  purchaseOrderType:', importerPO.amazonVendor?.purchaseOrderType);
    console.log('  shipmentType in PO:', importerPO.amazonVendor?.shipmentType);
    console.log('  Full raw PO keys:', Object.keys(importerPO.amazonVendor || {}));
    // Check for any routing/shipment method info
    if (importerPO.amazonVendor?.raw) {
      console.log('  Raw PO data keys:', Object.keys(importerPO.amazonVendor.raw));
    }
  } else {
    console.log('Importer returned null for PO 58AIYHEC');
  }

  // Check packing shipment for carton tracking numbers
  console.log('\n--- Checking packing shipment cartons ---');
  const packingShipment = await db.collection('packing_shipments').findOne({
    poNumbers: '58AIYHEC'
  }, { sort: { createdAt: -1 } });

  if (packingShipment) {
    console.log('Packing shipment found:');
    console.log('  ID:', packingShipment.packingShipmentId);
    console.log('  parcels count:', packingShipment.parcels?.length);
    if (packingShipment.parcels?.length > 0) {
      packingShipment.parcels.forEach((p, i) => {
        console.log(`  Parcel ${i + 1}:`);
        console.log(`    SSCC: ${p.sscc}`);
        console.log(`    glsTrackingNumber: ${p.glsTrackingNumber}`);
        console.log(`    trackingNumber: ${p.trackingNumber}`);
      });
    }
  } else {
    console.log('No packing shipment found');
  }

  // Check the vendor_shipments for carton tracking info
  console.log('\n--- Checking vendor_shipments cartons ---');
  if (shipment && shipment.cartons) {
    console.log('Cartons in vendor_shipment:');
    shipment.cartons.forEach((c, i) => {
      console.log(`  Carton ${i + 1}:`);
      console.log(`    SSCC: ${c.sscc}`);
      console.log(`    trackingNumber: ${c.trackingNumber}`);
      console.log(`    items: ${c.items?.length || 0}`);
    });
  }

  // Also check packing_shipments with different query
  console.log('\n--- Alternative packing shipment search ---');
  const packingShipment2 = await db.collection('packing_shipments').findOne({
    poNumbers: { $in: ['58AIYHEC', '5XQHQ68M'] }
  }, { sort: { createdAt: -1 } });

  if (packingShipment2) {
    console.log('Found packing shipment:', packingShipment2.packingShipmentId);
    console.log('  parcels:', packingShipment2.parcels?.length);
    if (packingShipment2.parcels?.length > 0) {
      packingShipment2.parcels.forEach((p, i) => {
        console.log(`  Parcel ${i + 1}: SSCC=${p.sscc}, tracking=${p.glsTrackingNumber || p.trackingNumber}`);
      });
    }
  } else {
    console.log('No packing shipment found with alternative query');

    // List all packing shipments
    const allPackingShipments = await db.collection('packing_shipments').find({}).sort({ createdAt: -1 }).limit(5).toArray();
    console.log('\nRecent packing shipments:');
    allPackingShipments.forEach(ps => {
      console.log(`  ${ps.packingShipmentId}: POs=${ps.poNumbers?.join(',')} parcels=${ps.parcels?.length}`);
    });
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
