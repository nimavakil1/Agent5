/**
 * Manually submit ASN for PO 1I1EH29Q with new SSCCs
 */

require('dotenv').config();
const { connectDb } = require('../src/db');
const { getVendorASNCreator } = require('../src/services/amazon/vendor/VendorASNCreator');

const PO_NUMBER = '1I1EH29Q';

// New SSCCs (replacing the burned ones)
const PACKING_DATA = {
  cartons: [
    {
      sscc: '054008820000000191',
      trackingNumber: 'ZMYP18S7',
      items: [
        { sku: '18023', ean: '5400882001884', quantity: 24 }
      ]
    },
    {
      sscc: '054008820000000207',
      trackingNumber: 'ZMYP18S8',
      items: [
        { sku: '18023', ean: '5400882001884', quantity: 24 }
      ]
    },
    {
      sscc: '054008820000000214',
      trackingNumber: 'ZMYP18S9',
      items: [
        { sku: '18023', ean: '5400882001884', quantity: 24 }
      ]
    }
  ],
  pallets: []
};

async function main() {
  console.log('Connecting to database...');
  await connectDb();

  console.log('Initializing ASN Creator...');
  const asnCreator = await getVendorASNCreator();

  // First do a dry run to see the payload
  console.log('\n=== DRY RUN ===');
  const dryRunResult = await asnCreator.submitASNWithSSCC(PO_NUMBER, PACKING_DATA, { dryRun: true });

  if (!dryRunResult.success) {
    console.error('Dry run failed:', dryRunResult.errors);
    process.exit(1);
  }

  console.log('\nPayload that will be sent:');
  console.log(JSON.stringify(dryRunResult.payload, null, 2));

  // Actually submit
  console.log('\n=== SUBMITTING TO AMAZON ===');
  const result = await asnCreator.submitASNWithSSCC(PO_NUMBER, PACKING_DATA, { dryRun: false });

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  if (result.success) {
    console.log(`\n✓ ASN submitted successfully!`);
    console.log(`  Shipment ID: ${result.shipmentId}`);
    console.log(`  Transaction ID: ${result.transactionId}`);

    // Check transaction status
    console.log('\nChecking transaction status...');
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds

    const status = await asnCreator.checkTransactionStatus(result.shipmentId);
    console.log('Transaction status:', JSON.stringify(status, null, 2));
  } else {
    console.error(`\n✗ ASN submission failed!`);
    console.error('Errors:', result.errors);
  }

  process.exit(result.success ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
