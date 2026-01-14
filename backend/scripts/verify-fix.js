require("dotenv").config();
const { MongoClient } = require("mongodb");

async function verify() {
  const client = await MongoClient.connect(process.env.MONGO_URI);
  const db = client.db();

  // Main list query (from consolidation endpoint)
  const listQuery = {
    channel: "amazon-vendor",
    "amazonVendor.shipmentStatus": "not_shipped",
    "odoo.deliveryStatus": { $ne: "full" },
    "amazonVendor.purchaseOrderState": { $in: ["New", "Acknowledged"] },
    _testData: { $ne: true },
    "sourceIds.amazonVendorPONumber": { $not: /^TST/ }
  };

  // Detail query for CDG7_2026-01-19 (now matching list query)
  const startOfDay = new Date("2026-01-19T00:00:00.000Z");
  const endOfDay = new Date("2026-01-20T00:00:00.000Z");

  const detailQuery = {
    channel: "amazon-vendor",
    "amazonVendor.shipToParty.partyId": "CDG7",
    consolidationOverride: { $ne: true },
    "amazonVendor.purchaseOrderState": { $in: ["New", "Acknowledged"] },
    "amazonVendor.shipmentStatus": "not_shipped",
    "odoo.deliveryStatus": { $ne: "full" }, // NOW INCLUDED
    "amazonVendor.deliveryWindow.endDate": { $gte: startOfDay, $lt: endOfDay },
    _testData: { $ne: true },
    "sourceIds.amazonVendorPONumber": { $not: /^TST/ }
  };

  // Get orders from list (filtered for CDG7)
  const listOrders = await db.collection("unified_orders").find(listQuery).toArray();
  const cdg7ListOrders = listOrders.filter(o =>
    o.amazonVendor && o.amazonVendor.shipToParty && o.amazonVendor.shipToParty.partyId === "CDG7" &&
    o.amazonVendor.deliveryWindow && o.amazonVendor.deliveryWindow.endDate &&
    new Date(o.amazonVendor.deliveryWindow.endDate).toISOString().split("T")[0] === "2026-01-19"
  );

  // Get orders from detail
  const detailOrders = await db.collection("unified_orders").find(detailQuery).toArray();

  console.log("=== VERIFICATION RESULTS ===");
  console.log("");
  console.log("List query (CDG7_2026-01-19):");
  console.log("  Orders:", cdg7ListOrders.length);
  console.log("  POs:", cdg7ListOrders.map(o => o.sourceIds && o.sourceIds.amazonVendorPONumber).join(", "));

  let listItems = 0, listUnits = 0;
  for (const o of cdg7ListOrders) {
    listItems += (o.items && o.items.length) || 0;
    for (const i of (o.items || [])) {
      listUnits += (i.orderedQuantity && i.orderedQuantity.amount) || i.quantity || 0;
    }
  }
  console.log("  Items:", listItems);
  console.log("  Units:", listUnits);

  console.log("");
  console.log("Detail query (CDG7_2026-01-19):");
  console.log("  Orders:", detailOrders.length);
  console.log("  POs:", detailOrders.map(o => o.sourceIds && o.sourceIds.amazonVendorPONumber).join(", "));

  let detailItems = 0, detailUnits = 0;
  for (const o of detailOrders) {
    detailItems += (o.items && o.items.length) || 0;
    for (const i of (o.items || [])) {
      detailUnits += (i.orderedQuantity && i.orderedQuantity.amount) || i.quantity || 0;
    }
  }
  console.log("  Items:", detailItems);
  console.log("  Units:", detailUnits);

  console.log("");
  if (cdg7ListOrders.length === detailOrders.length && listItems === detailItems && listUnits === detailUnits) {
    console.log("✓ SUCCESS: List and detail queries return IDENTICAL results!");
  } else {
    console.log("✗ MISMATCH: List and detail queries return DIFFERENT results!");
    console.log("  List:", cdg7ListOrders.length, "orders,", listItems, "items,", listUnits, "units");
    console.log("  Detail:", detailOrders.length, "orders,", detailItems, "items,", detailUnits, "units");
  }

  await client.close();
}
verify().catch(console.error);
