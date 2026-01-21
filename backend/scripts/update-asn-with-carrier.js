/**
 * Update ASN for PO 1I1EH29Q with carrier info
 * Submits a REPLACE shipment confirmation to fix the missing carrier/weight data
 */

require('dotenv').config();
const { connectDb, getDb } = require('../src/db');
const { VendorClient } = require('../src/services/amazon/vendor/VendorClient');

const PO_NUMBER = '1I1EH29Q';

// The existing shipment ID from the original submission
const EXISTING_SHIPMENT_ID = 'ASN-1I1EH29Q-MKNWGL27';

// Packing data with carrier info
const PACKING_DATA = {
  cartons: [
    {
      sscc: '054008820000000191',
      trackingNumber: 'ZMYP18S7',
      weight: 8, // kg
      items: [{ sku: '18023', ean: '5400882001884', quantity: 24 }]
    },
    {
      sscc: '054008820000000207',
      trackingNumber: 'ZMYP18S8',
      weight: 8,
      items: [{ sku: '18023', ean: '5400882001884', quantity: 24 }]
    },
    {
      sscc: '054008820000000214',
      trackingNumber: 'ZMYP18S9',
      weight: 8,
      items: [{ sku: '18023', ean: '5400882001884', quantity: 24 }]
    }
  ],
  carrier: {
    scac: 'GLSO',  // GLS carrier code
    name: 'GLS',
    trackingNumber: 'ZMYP18S7,ZMYP18S8,ZMYP18S9'  // Comma-separated tracking numbers
  },
  measurements: {
    totalWeight: 24,  // 3 cartons x 8 kg
    weightUnit: 'Kg',
    totalVolume: 0.15, // cubic meters (estimate)
    volumeUnit: 'CuFt'
  }
};

async function main() {
  console.log('Connecting to database...');
  await connectDb();
  const db = getDb();

  // Get PO from MongoDB
  console.log(`\nFetching PO ${PO_NUMBER}...`);
  const po = await db.collection('vendor_purchase_orders').findOne({ purchaseOrderNumber: PO_NUMBER });

  if (!po) {
    console.error('PO not found!');
    process.exit(1);
  }

  console.log('PO found:', {
    purchaseOrderNumber: po.purchaseOrderNumber,
    marketplaceId: po.marketplaceId,
    sellingPartyId: po.amazonVendor?.sellingParty?.partyId || po.sellingParty?.partyId
  });

  // Build the replacement ASN payload
  const { cartons, carrier, measurements } = PACKING_DATA;

  // Build carton data
  const cartonData = cartons.map((carton, idx) => ({
    cartonIdentifiers: [{
      containerIdentificationType: 'SSCC',
      containerIdentificationNumber: carton.sscc
    }],
    cartonSequenceNumber: String(idx + 1),
    items: carton.items.map(() => ({
      itemReference: '1', // PO item sequence number
      shippedQuantity: {
        amount: carton.items[0].quantity,
        unitOfMeasure: 'Eaches'
      }
    }))
  }));

  // Build shipped items (total per SKU)
  const shippedItems = [{
    itemSequenceNumber: '1',
    amazonProductIdentifier: po.items[0]?.amazonProductIdentifier,
    vendorProductIdentifier: po.items[0]?.vendorProductIdentifier,
    shippedQuantity: {
      amount: 72, // 24 x 3 cartons
      unitOfMeasure: 'Eaches'
    },
    itemDetails: {
      purchaseOrderNumber: PO_NUMBER
    }
  }];

  const asnPayload = {
    shipmentConfirmations: [{
      shipmentIdentifier: EXISTING_SHIPMENT_ID,
      shipmentConfirmationType: 'Replace',  // Update existing shipment
      shipmentType: 'SmallParcel',
      shipmentConfirmationDate: new Date().toISOString(),
      shippedDate: new Date().toISOString(),
      estimatedDeliveryDate: po.amazonVendor?.deliveryWindow?.endDate || new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      sellingParty: {
        partyId: po.amazonVendor?.sellingParty?.partyId || po.sellingParty?.partyId,
        address: {
          name: 'ACROPAQ BV - Central Warehouse',
          addressLine1: 'Patronaatstraat 79',
          city: 'Dendermonde',
          postalCode: '9200',
          countryCode: 'BE'
        }
      },
      shipFromParty: {
        partyId: po.amazonVendor?.sellingParty?.partyId || po.sellingParty?.partyId,
        address: {
          name: 'ACROPAQ BV - Central Warehouse',
          addressLine1: 'Patronaatstraat 79',
          city: 'Dendermonde',
          postalCode: '9200',
          countryCode: 'BE'
        }
      },
      shipToParty: po.amazonVendor?.shipToParty || po.shipToParty,
      shipmentMeasurements: {
        grossShipmentWeight: {
          unitOfMeasure: measurements.weightUnit,
          value: String(measurements.totalWeight)
        },
        cartonCount: cartons.length,
        palletCount: 0
      },
      transportationDetails: {
        carrierScac: carrier.scac,
        carrierShipmentReferenceNumber: carrier.trackingNumber,
        transportationMode: 'Road'
      },
      shippedItems,
      cartons: cartonData
    }]
  };

  console.log('\n=== PAYLOAD TO BE SENT ===');
  console.log(JSON.stringify(asnPayload, null, 2));

  // Prompt for confirmation
  console.log('\n>>> Press Ctrl+C to cancel, or wait 5 seconds to submit...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Submit to Amazon
  console.log('\n=== SUBMITTING REPLACEMENT ASN ===');
  const marketplace = po.amazonVendor?.marketplaceId || po.marketplaceId || 'FR';
  const client = new VendorClient(marketplace);
  await client.init();

  const response = await client.submitShipmentConfirmations(asnPayload);
  console.log('\n=== AMAZON RESPONSE ===');
  console.log(JSON.stringify(response, null, 2));

  if (response.transactionId) {
    console.log(`\n✓ Replacement ASN submitted!`);
    console.log(`  Transaction ID: ${response.transactionId}`);

    // Wait and check status
    console.log('\nWaiting 5 seconds to check status...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    const status = await client.getTransactionStatus(response.transactionId);
    console.log('Transaction status:', JSON.stringify(status, null, 2));
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
