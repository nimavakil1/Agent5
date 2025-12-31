const { MongoClient } = require("mongodb");

async function check() {
  const client = new MongoClient("mongodb://localhost:27017");
  await client.connect();
  const db = client.db("agent5");

  // Check the PO
  const po = await db.collection("vendor_purchase_orders").findOne({ purchaseOrderNumber: "4WZ7I1UZ" });

  if (!po) {
    console.log("PO not found");
    await client.close();
    return;
  }

  console.log("=== PO Items ===");
  po.items.forEach((item) => {
    console.log("Line", item.itemSequenceNumber, "|", item.amazonProductIdentifier, "|",
      item.odooSku ? "Mapped: " + item.odooSku : "NOT MAPPED",
      "| odooProductId:", item.odooProductId || "none");
  });

  // Check if mapping exists for line 3's ASIN
  const line3 = po.items.find(i => i.itemSequenceNumber === "003" || i.itemSequenceNumber === 3);
  if (line3) {
    const asin = line3.amazonProductIdentifier;
    console.log("\n=== Line 3 ASIN:", asin, "===");

    const mapping = await db.collection("amazon_product_mappings").findOne({ asin });
    if (mapping) {
      console.log("Mapping EXISTS:");
      console.log("  odooProductId:", mapping.odooProductId);
      console.log("  odooSku:", mapping.odooSku);
      console.log("  marketplace:", mapping.marketplace);
    } else {
      console.log("NO MAPPING FOUND for this ASIN");
    }
  }

  await client.close();
}

check().catch(console.error);
