require("dotenv").config();
const { MongoClient } = require("mongodb");

async function check() {
  const client = await MongoClient.connect(process.env.MONGO_URI);
  const db = client.db();

  // Find the 5 CDG7 orders that should be in main list
  const orders = await db.collection("unified_orders").find({
    channel: "amazon-vendor",
    "amazonVendor.shipToParty.partyId": "CDG7",
    "amazonVendor.purchaseOrderState": { $in: ["New", "Acknowledged"] },
    "amazonVendor.shipmentStatus": "not_shipped",
    _testData: { $ne: true },
    "sourceIds.amazonVendorPONumber": { $not: /^TST/ }
  }).toArray();

  console.log("Orders that should be in CDG7 consolidation:");

  for (const o of orders) {
    const po = o.sourceIds && o.sourceIds.amazonVendorPONumber;
    const deliveryEnd = o.amazonVendor && o.amazonVendor.deliveryWindow && o.amazonVendor.deliveryWindow.endDate;

    // This mimics the createConsolidationGroupId function
    const dateStr = deliveryEnd ? new Date(deliveryEnd).toISOString().split("T")[0] : "nodate";
    const groupId = "CDG7_" + dateStr;

    console.log("");
    console.log(po + ":");
    console.log("  Raw deliveryEnd:", deliveryEnd);
    console.log("  typeof:", typeof deliveryEnd);
    console.log("  As Date:", deliveryEnd ? new Date(deliveryEnd).toISOString() : "null");
    console.log("  Extracted date:", dateStr);
    console.log("  GroupId would be:", groupId);
  }

  await client.close();
}
check().catch(console.error);
