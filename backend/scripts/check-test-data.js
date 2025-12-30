const { MongoClient } = require("mongodb");

async function check() {
  const client = new MongoClient("mongodb://localhost:27017");
  await client.connect();
  const db = client.db("agent5");

  // Check test POs
  const pos = await db.collection("vendor_purchase_orders").find({ _testData: true }).toArray();

  console.log("=== Test POs in MongoDB ===");
  console.log("Total:", pos.length);

  // Group by consolidation key
  const groups = {};
  for (const po of pos) {
    const fc = po.shipToParty?.partyId || "Unknown";
    const date = po.deliveryWindow?.endDate ? new Date(po.deliveryWindow.endDate).toISOString().split("T")[0] : "nodate";
    const key = fc + "|" + date;
    if (!groups[key]) groups[key] = [];
    groups[key].push(po.purchaseOrderNumber);
  }

  console.log("\nConsolidation Groups:");
  for (const [key, poNumbers] of Object.entries(groups)) {
    console.log("  " + key + " => " + poNumbers.length + " POs: " + poNumbers.join(", "));
  }

  // Check products with packaging
  const products = await db.collection("products").find({
    packaging: { $exists: true, $ne: [] }
  }).project({ sku: 1, name: 1, packaging: 1 }).toArray();

  console.log("\n=== Products with Packaging ===");
  for (const p of products) {
    const pkgStr = (p.packaging || []).map(pk => pk.name + ":" + pk.qty).join(", ");
    console.log("  " + p.sku + " => " + pkgStr);
  }

  await client.close();
}

check().catch(console.error);
