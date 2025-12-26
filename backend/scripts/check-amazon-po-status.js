require('dotenv').config();
const { VendorClient } = require('../src/services/amazon/vendor');

async function main() {
  // Test with DE marketplace
  console.log('=== Checking PO Status from Amazon (DE) ===');

  try {
    const client = new VendorClient('DE');
    await client.init();

    // Get PO status for recent orders
    const result = await client.getPurchaseOrdersStatus({
      createdAfter: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      limit: 20
    });

    console.log('Result:', JSON.stringify(result, null, 2));

    if (result.ordersStatus) {
      console.log(`\nFound ${result.ordersStatus.length} PO statuses`);
      result.ordersStatus.forEach(po => {
        console.log(`\nPO: ${po.purchaseOrderNumber}`);
        console.log(`  Status: ${po.purchaseOrderStatus}`);
        if (po.itemStatus) {
          po.itemStatus.forEach(item => {
            console.log(`  Item ${item.itemSequenceNumber}:`);
            console.log(`    Ordered: ${item.orderedQuantity?.amount}`);
            console.log(`    Received: ${item.receivedQuantity?.amount || 0}`);
            console.log(`    Invoiced: ${item.invoicedQuantity?.amount || 'N/A'}`);
          });
        }
      });
    }
  } catch (error) {
    console.error('Error:', error.message);
    if (error.details) console.error('Details:', JSON.stringify(error.details, null, 2));
  }
}

main();
