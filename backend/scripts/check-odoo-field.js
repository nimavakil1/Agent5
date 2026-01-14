require("dotenv").config();
const { MongoClient } = require("mongodb");

async function check() {
  const client = await MongoClient.connect(process.env.MONGO_URI);
  const db = client.db();

  // Find the 5 CDG7 orders
  const orders = await db.collection("unified_orders").find({
    "sourceIds.amazonVendorPONumber": { $in: ["65TANLTM", "5JRHM3RX", "8TR9ZQNH", "1SUVMUXZ", "6RU46LWI"] }
  }).toArray();

  console.log("Checking odoo.deliveryStatus field:");

  for (const o of orders) {
    const po = o.sourceIds && o.sourceIds.amazonVendorPONumber;
    console.log("");
    console.log(po + ":");
    console.log("  odoo object exists:", !!o.odoo);
    console.log("  odoo.deliveryStatus exists:", o.odoo && o.odoo.hasOwnProperty && o.odoo.hasOwnProperty("deliveryStatus"));
    console.log("  odoo.deliveryStatus value:", o.odoo && o.odoo.deliveryStatus);
    console.log("  Full odoo object:", JSON.stringify(o.odoo, null, 2));
  }

  // Now test the exact query from the list endpoint
  console.log("\n=== Testing List Query ===");
  const listQuery = {
    channel: "amazon-vendor",
    "amazonVendor.shipmentStatus": "not_shipped",
    "odoo.deliveryStatus": { $ne: "full" },
    "amazonVendor.purchaseOrderState": { $in: ["New", "Acknowledged"] },
    _testData: { $ne: true },
    "sourceIds.amazonVendorPONumber": { $not: /^TST/ }
  };
  const listOrders = await db.collection("unified_orders").find(listQuery).toArray();
  const cdg7ListOrders = listOrders.filter(o =>
    o.amazonVendor && o.amazonVendor.shipToParty && o.amazonVendor.shipToParty.partyId === "CDG7"
  );
  console.log("Total orders from list query:", listOrders.length);
  console.log("CDG7 orders from list query:", cdg7ListOrders.length);
  console.log("CDG7 PO numbers:", cdg7ListOrders.map(o => o.sourceIds && o.sourceIds.amazonVendorPONumber).join(", "));

  await client.close();
}
check().catch(console.error);
