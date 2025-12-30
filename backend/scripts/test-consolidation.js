const { MongoClient } = require("mongodb");

async function test() {
  const client = new MongoClient("mongodb://localhost:27017");
  await client.connect();
  const db = client.db("agent5");

  // Simulate what the consolidation LIST endpoint does
  const orders = await db.collection("vendor_purchase_orders").find({
    purchaseOrderState: { $in: ["New", "Acknowledged"] },
    shipmentStatus: "not_shipped",
    _testData: true
  }).toArray();

  console.log("Total test orders:", orders.length);

  const groups = {};
  for (const order of orders) {
    const partyId = order.shipToParty?.partyId || "UNKNOWN";
    const deliveryEnd = order.deliveryWindow?.endDate;
    const dateStr = deliveryEnd ? new Date(deliveryEnd).toISOString().split("T")[0] : "nodate";
    const baseGroupId = partyId + "_" + dateStr;

    // If order has consolidationOverride, it gets separate group
    const groupId = order.consolidationOverride
      ? baseGroupId + "_SEP_" + order.purchaseOrderNumber
      : baseGroupId;

    if (!groups[groupId]) {
      groups[groupId] = { groupId, orders: [] };
    }
    groups[groupId].orders.push(order.purchaseOrderNumber);
  }

  console.log("\nGroups:");
  Object.values(groups).sort((a, b) => a.groupId.localeCompare(b.groupId)).forEach(g => {
    const isSep = g.groupId.includes("_SEP_");
    console.log("  " + (isSep ? "[SEP] " : "") + g.groupId);
    console.log("        POs: " + g.orders.join(", "));
  });

  await client.close();
}

test().catch(console.error);
