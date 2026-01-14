require("dotenv").config();
const { MongoClient } = require("mongodb");

async function check() {
  const client = await MongoClient.connect(process.env.MONGO_URI);
  const db = client.db();

  // Find ALL CDG7 orders regardless of status
  const allCdg7 = await db.collection("unified_orders").find({
    channel: "amazon-vendor",
    "amazonVendor.shipToParty.partyId": "CDG7",
    _testData: { $ne: true },
    "sourceIds.amazonVendorPONumber": { $not: /^TST/ }
  }).toArray();

  console.log("=== ALL CDG7 ORDERS ===");
  console.log("Total:", allCdg7.length);

  for (const o of allCdg7) {
    const po = o.sourceIds && o.sourceIds.amazonVendorPONumber;
    const state = o.amazonVendor && o.amazonVendor.purchaseOrderState;
    const shipmentStatus = o.amazonVendor && o.amazonVendor.shipmentStatus;
    const odooStatus = o.odoo && o.odoo.deliveryStatus;
    const consolidationOverride = o.consolidationOverride;
    const deliveryDate = o.amazonVendor && o.amazonVendor.deliveryWindow && o.amazonVendor.deliveryWindow.endDate;
    const items = (o.items && o.items.length) || 0;
    let units = 0;
    for (const i of (o.items || [])) {
      units += (i.orderedQuantity && i.orderedQuantity.amount) || i.quantity || 0;
    }

    console.log("");
    console.log(po + ":");
    console.log("  deliveryDate: " + (deliveryDate ? new Date(deliveryDate).toISOString().split("T")[0] : "none"));
    console.log("  state: " + state);
    console.log("  shipmentStatus: " + shipmentStatus);
    console.log("  odoo.deliveryStatus: " + (odooStatus || "none"));
    console.log("  consolidationOverride: " + (consolidationOverride || "none"));
    console.log("  items: " + items + ", units: " + units);

    // Check if this would be included in main consolidation list
    const inMainList =
      state && ["New", "Acknowledged"].includes(state) &&
      shipmentStatus === "not_shipped" &&
      odooStatus !== "full" &&
      consolidationOverride !== true;
    console.log("  INCLUDED IN MAIN LIST: " + inMainList);
  }

  await client.close();
}
check().catch(console.error);
