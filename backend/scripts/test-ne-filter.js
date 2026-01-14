require("dotenv").config();
const { MongoClient } = require("mongodb");

async function check() {
  const client = await MongoClient.connect(process.env.MONGO_URI);
  const db = client.db();

  // Test 1: Query with $ne: 'full' on a field that doesn't exist
  const withNeFilter = await db.collection("unified_orders").countDocuments({
    "sourceIds.amazonVendorPONumber": { $in: ["65TANLTM", "5JRHM3RX", "8TR9ZQNH", "1SUVMUXZ", "6RU46LWI"] },
    "odoo.deliveryStatus": { $ne: "full" }
  });

  // Test 2: Same query without the filter
  const withoutFilter = await db.collection("unified_orders").countDocuments({
    "sourceIds.amazonVendorPONumber": { $in: ["65TANLTM", "5JRHM3RX", "8TR9ZQNH", "1SUVMUXZ", "6RU46LWI"] }
  });

  console.log("With $ne:'full' filter:", withNeFilter);
  console.log("Without filter:", withoutFilter);

  // Test 3: Check what values odoo.deliveryStatus has
  const distinctValues = await db.collection("unified_orders").distinct("odoo.deliveryStatus", {
    channel: "amazon-vendor"
  });
  console.log("Distinct odoo.deliveryStatus values:", distinctValues);

  // Test 4: Count by deliveryStatus
  const pipeline = [
    { $match: { channel: "amazon-vendor" } },
    { $group: { _id: "$odoo.deliveryStatus", count: { $sum: 1 } } }
  ];
  const byStatus = await db.collection("unified_orders").aggregate(pipeline).toArray();
  console.log("Orders by odoo.deliveryStatus:", byStatus);

  await client.close();
}
check().catch(console.error);
