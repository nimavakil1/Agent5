require("dotenv").config();
const { MongoClient } = require("mongodb");

async function check() {
  const client = await MongoClient.connect(process.env.MONGO_URI);
  const db = client.db();

  // Check sellingParty by marketplace
  const pipeline = [
    { $match: { channel: "amazon-vendor" } },
    { $group: {
      _id: {
        marketplace: "$marketplace.code",
        sellingPartyId: "$amazonVendor.sellingParty.partyId"
      },
      count: { $sum: 1 },
      samplePO: { $first: "$sourceIds.amazonVendorPONumber" }
    }},
    { $sort: { "_id.marketplace": 1 } }
  ];

  const results = await db.collection("unified_orders").aggregate(pipeline).toArray();

  console.log("=== Selling Party by Marketplace ===\n");

  let currentMarketplace = null;
  for (const r of results) {
    if (r._id.marketplace !== currentMarketplace) {
      currentMarketplace = r._id.marketplace;
      console.log(`\n${currentMarketplace}:`);
    }
    console.log(`  sellingParty: ${r._id.sellingPartyId} - ${r.count} orders (sample: ${r.samplePO})`);
  }

  // Now let's look at CDG7 specifically with current not_shipped orders
  console.log("\n\n=== CDG7 Current Orders (not_shipped) ===\n");

  const cdg7Orders = await db.collection("unified_orders").find({
    channel: "amazon-vendor",
    "amazonVendor.shipToParty.partyId": "CDG7",
    "amazonVendor.shipmentStatus": "not_shipped",
    "amazonVendor.purchaseOrderState": { $in: ["New", "Acknowledged"] }
  }).toArray();

  const byMarketplace = {};
  for (const o of cdg7Orders) {
    const mp = o.marketplace?.code || "unknown";
    const sellingParty = o.amazonVendor?.sellingParty?.partyId || "unknown";
    const key = `${mp} (${sellingParty})`;
    if (!byMarketplace[key]) {
      byMarketplace[key] = [];
    }
    byMarketplace[key].push(o.sourceIds?.amazonVendorPONumber);
  }

  for (const [key, orders] of Object.entries(byMarketplace)) {
    console.log(`${key}: ${orders.length} orders`);
    console.log(`  POs: ${orders.join(", ")}`);
  }

  await client.close();
}
check().catch(console.error);
