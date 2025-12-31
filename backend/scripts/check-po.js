const { MongoClient } = require("mongodb");

async function check() {
  const client = new MongoClient("mongodb://localhost:27017");
  await client.connect();
  const db = client.db("agent5");

  const po = await db.collection("vendor_purchase_orders").findOne({
    purchaseOrderNumber: "4WZ7I1UZ"
  });

  if (!po) {
    console.log("PO not found in MongoDB");
    await client.close();
    return;
  }

  console.log("=== Full PO Document ===");
  console.log(JSON.stringify(po, null, 2));

  await client.close();
}

check().catch(console.error);
