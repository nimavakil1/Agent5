require("dotenv").config();
const { MongoClient } = require("mongodb");

async function check() {
  const client = await MongoClient.connect(process.env.MONGO_URI);
  const db = client.db();

  // Check what vendor-related fields exist in unified_orders
  const sample = await db.collection("unified_orders").findOne({
    channel: "amazon-vendor",
    "amazonVendor.shipToParty.partyId": "CDG7"
  });

  console.log("Sample CDG7 order:");
  console.log("  PO:", sample.sourceIds?.amazonVendorPONumber);
  console.log("  marketplace:", JSON.stringify(sample.marketplace));
  console.log("  amazonVendor.partyId:", sample.amazonVendor?.partyId);
  console.log("  amazonVendor.vendorCode:", sample.amazonVendor?.vendorCode);
  console.log("  amazonVendor.sellingParty:", JSON.stringify(sample.amazonVendor?.sellingParty));
  console.log("  amazonVendor.orderingParty:", JSON.stringify(sample.amazonVendor?.orderingParty));

  // Get distinct marketplaces for CDG7 orders
  const marketplaces = await db.collection("unified_orders").distinct("marketplace.code", {
    channel: "amazon-vendor",
    "amazonVendor.shipToParty.partyId": "CDG7"
  });
  console.log("\nDistinct marketplaces for CDG7:", marketplaces);

  // Check if there are orders from different marketplaces going to same FC
  const pipeline = [
    { $match: { channel: "amazon-vendor", "amazonVendor.shipToParty.partyId": "CDG7" } },
    { $group: { _id: "$marketplace.code", count: { $sum: 1 } } }
  ];
  const byMarketplace = await db.collection("unified_orders").aggregate(pipeline).toArray();
  console.log("CDG7 orders by marketplace:", byMarketplace);

  // Check all FCs and their marketplace distribution
  console.log("\n=== All FCs with orders from multiple marketplaces ===");
  const fcPipeline = [
    { $match: { channel: "amazon-vendor" } },
    { $group: {
      _id: {
        fc: "$amazonVendor.shipToParty.partyId",
        marketplace: "$marketplace.code"
      },
      count: { $sum: 1 }
    }},
    { $group: {
      _id: "$_id.fc",
      marketplaces: { $push: { code: "$_id.marketplace", count: "$count" } },
      totalMarketplaces: { $sum: 1 }
    }},
    { $match: { totalMarketplaces: { $gt: 1 } } },
    { $sort: { totalMarketplaces: -1 } }
  ];
  const multiMarketplaceFCs = await db.collection("unified_orders").aggregate(fcPipeline).toArray();

  for (const fc of multiMarketplaceFCs.slice(0, 10)) {
    console.log(`\n${fc._id}: ${fc.totalMarketplaces} marketplaces`);
    for (const mp of fc.marketplaces) {
      console.log(`  ${mp.code}: ${mp.count} orders`);
    }
  }

  await client.close();
}
check().catch(console.error);
