/**
 * Migration script: Copy Amazon product mappings from Emipro EPT to our own MongoDB collection
 *
 * This script fetches all mappings from Odoo's amazon.product.ept table
 * and inserts them into our amazon_product_mappings MongoDB collection.
 *
 * Run: node scripts/migrate-ept-mappings.js
 */

const { MongoClient } = require("mongodb");
const { OdooDirectClient } = require("../src/core/agents/integrations/OdooMCP");

const COLLECTION_NAME = 'amazon_product_mappings';

// Marketplace ID to code mapping (Amazon EU marketplace IDs)
const MARKETPLACE_MAP = {
  'A1PA6795UKMFR9': 'DE',  // Germany
  'A13V1IB3VIYZZH': 'FR',  // France
  'A1F83G8C2ARO7P': 'UK',  // United Kingdom
  'APJ6JRA9NG5V4': 'IT',   // Italy
  'A1RKKUPIHCS9HS': 'ES',  // Spain
  'A1805IZSGTT6HS': 'NL',  // Netherlands
  'AMEN7PMS3EDWL': 'BE',   // Belgium
  'A1C3SOZRARQ6R3': 'PL',  // Poland
  'A2NODRKZP88ZB9': 'SE',  // Sweden
};

async function migrate() {
  console.log("=== EPT to MongoDB Migration ===\n");

  // Connect to MongoDB
  const mongoClient = new MongoClient("mongodb://localhost:27017");
  await mongoClient.connect();
  const db = mongoClient.db("agent5");
  const collection = db.collection(COLLECTION_NAME);

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log("Connected to Odoo\n");

  // First, get the count
  const eptCount = await odoo.searchRead('amazon.product.ept',
    [],
    ['id'],
    { limit: 1 }
  );

  // Get all EPT mappings in batches
  const batchSize = 200;
  let offset = 0;
  let totalProcessed = 0;
  let inserted = 0;
  let updated = 0;
  let errors = [];

  console.log("Fetching EPT mappings from Odoo...\n");

  while (true) {
    const eptMappings = await odoo.searchRead('amazon.product.ept',
      [],
      [
        'id',
        'product_asin',
        'seller_sku',
        'product_id',
        'instance_id',
        'fulfillment_by',
        'exported_to_amazon',
        'active',
        'barcode'
      ],
      { limit: batchSize, offset }
    );

    if (eptMappings.length === 0) break;

    console.log(`Processing batch: offset ${offset}, count ${eptMappings.length}`);

    for (const ept of eptMappings) {
      try {
        const asin = ept.product_asin;
        if (!asin) {
          errors.push({ id: ept.id, error: 'No ASIN' });
          continue;
        }

        // Get product details
        let productData = null;
        if (ept.product_id) {
          const productId = Array.isArray(ept.product_id) ? ept.product_id[0] : ept.product_id;
          const products = await odoo.searchRead('product.product',
            [['id', '=', productId]],
            ['id', 'name', 'default_code', 'barcode'],
            { limit: 1 }
          );
          if (products.length > 0) {
            productData = products[0];
          }
        }

        if (!productData) {
          errors.push({ id: ept.id, asin, error: 'Product not found' });
          continue;
        }

        // Determine marketplace code from instance
        let marketplace = 'ALL';
        if (ept.instance_id) {
          const instanceName = Array.isArray(ept.instance_id) ? ept.instance_id[1] : null;
          // Try to extract marketplace code from instance name (e.g., "Amazon DE", "Amazon.fr")
          if (instanceName) {
            for (const code of Object.values(MARKETPLACE_MAP)) {
              if (instanceName.toUpperCase().includes(code) ||
                  instanceName.toLowerCase().includes(code.toLowerCase())) {
                marketplace = code;
                break;
              }
            }
          }
        }

        // Determine fulfillment type
        const fulfillmentBy = ept.fulfillment_by === 'AFN' ? 'FBA' : 'FBM';

        // Upsert into MongoDB
        const now = new Date();
        const barcode = productData.barcode || ept.barcode || null;
        const result = await collection.updateOne(
          { asin, marketplace },
          {
            $set: {
              asin,
              marketplace,
              odooProductId: productData.id,
              odooSku: productData.default_code,
              odooProductName: productData.name,
              sellerSku: ept.seller_sku,
              barcode,
              fulfillmentBy,
              active: ept.active !== false,
              eptId: ept.id, // Keep reference to original EPT record
              updatedAt: now
            },
            $setOnInsert: { createdAt: now }
          },
          { upsert: true }
        );

        if (result.upsertedCount > 0) {
          inserted++;
        } else if (result.modifiedCount > 0) {
          updated++;
        }

        totalProcessed++;
      } catch (err) {
        errors.push({ id: ept.id, error: err.message });
      }
    }

    offset += batchSize;
  }

  // Create indexes
  console.log("\nCreating indexes...");
  await collection.createIndexes([
    { key: { asin: 1, marketplace: 1 }, unique: true },
    { key: { asin: 1 } },
    { key: { odooProductId: 1 } },
    { key: { odooSku: 1 } },
    { key: { sellerSku: 1 } },
    { key: { barcode: 1 } }
  ]);

  // Summary
  console.log("\n=== Migration Complete ===");
  console.log(`Total processed: ${totalProcessed}`);
  console.log(`Inserted: ${inserted}`);
  console.log(`Updated: ${updated}`);
  console.log(`Errors: ${errors.length}`);

  if (errors.length > 0 && errors.length <= 20) {
    console.log("\nErrors:");
    errors.forEach(e => console.log(`  EPT ID ${e.id}: ${e.error}`));
  } else if (errors.length > 20) {
    console.log("\nFirst 20 errors:");
    errors.slice(0, 20).forEach(e => console.log(`  EPT ID ${e.id}: ${e.error}`));
  }

  // Final stats
  const finalCount = await collection.countDocuments({});
  console.log(`\nTotal mappings in MongoDB: ${finalCount}`);

  await mongoClient.close();
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
