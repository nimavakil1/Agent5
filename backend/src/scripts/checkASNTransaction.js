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
  console.log('\nChecking transaction status with Amazon...');
  const client = new VendorClient(shipment.marketplaceId || 'FR');
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
    console.log('PO 58AIYHEC:');
    console.log('  sellingParty:', JSON.stringify(po.sellingParty));
    console.log('  amazonVendor.sellingParty:', JSON.stringify(po.amazonVendor?.sellingParty));
    console.log('  shipToParty:', JSON.stringify(po.shipToParty));
    console.log('  amazonVendor.shipToParty:', JSON.stringify(po.amazonVendor?.shipToParty));
  }

  // Check vendor_purchase_orders too
  const vpo = await db.collection('vendor_purchase_orders').findOne({
    purchaseOrderNumber: '58AIYHEC'
  });

  if (vpo) {
    console.log('\nVendor PO 58AIYHEC:');
    console.log('  sellingParty:', JSON.stringify(vpo.sellingParty));
    console.log('  shipToParty:', JSON.stringify(vpo.shipToParty));
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
