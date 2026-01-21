/**
 * Diagnose FBM stock issue for P0063-FBM
 */

require('dotenv').config();
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { skuResolver } = require('../src/services/amazon/SkuResolver');

async function diagnose() {
  console.log('=== FBM Stock Diagnostic ===\n');

  await connectDb();
  const db = getDb();
  await skuResolver.load();

  const amazonSku = 'P0063-FBM';

  // Step 1: Check SKU resolution
  console.log('1. SKU Resolution:');
  const resolution = skuResolver.resolve(amazonSku);
  console.log(`   Amazon SKU: ${amazonSku}`);
  console.log(`   Resolved to: ${resolution.odooSku}`);
  console.log(`   Match type: ${resolution.matchType}`);
  console.log(`   Fulfillment: ${resolution.fulfillmentType}`);

  const odooSku = resolution.odooSku;

  // Step 2: Check if SKU is in FBM listings
  console.log('\n2. FBM Listings Cache:');
  const listing = await db.collection('amazon_fbm_listings').findOne({ sellerSku: amazonSku });
  if (listing) {
    console.log(`   Found: ${listing.sellerSku} (${listing.asin}) on ${listing.marketplace}`);
  } else {
    console.log('   NOT FOUND in FBM listings cache');
  }

  // Step 3: Check Odoo product
  console.log('\n3. Odoo Product:');
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const products = await odoo.searchRead('product.product',
    [['default_code', '=', odooSku]],
    ['id', 'name', 'default_code', 'qty_available', 'free_qty', 'virtual_available']
  );

  if (products.length > 0) {
    const p = products[0];
    console.log(`   Found: ${p.default_code} - ${p.name}`);
    console.log(`   qty_available: ${p.qty_available}`);
    console.log(`   free_qty: ${p.free_qty}`);
    console.log(`   virtual_available: ${p.virtual_available}`);
  } else {
    console.log(`   NOT FOUND in Odoo with default_code = "${odooSku}"`);

    // Try partial match
    const partialProducts = await odoo.searchRead('product.product',
      [['default_code', 'ilike', odooSku]],
      ['id', 'name', 'default_code']
    );
    if (partialProducts.length > 0) {
      console.log('\n   Partial matches:');
      partialProducts.forEach(p => console.log(`   - ${p.default_code}: ${p.name}`));
    }
  }

  // Step 4: Check Central Warehouse stock (like the sync does)
  console.log('\n4. Central Warehouse Stock:');
  const warehouses = await odoo.searchRead('stock.warehouse',
    [['code', '=', 'CW']],
    ['id', 'name', 'lot_stock_id']
  );

  if (warehouses.length > 0) {
    const cwLocationId = warehouses[0].lot_stock_id[0];
    console.log(`   CW Location ID: ${cwLocationId}`);

    if (products.length > 0) {
      const productId = products[0].id;

      const quants = await odoo.searchRead('stock.quant',
        [
          ['product_id', '=', productId],
          ['location_id', '=', cwLocationId]
        ],
        ['product_id', 'quantity', 'reserved_quantity', 'location_id']
      );

      if (quants.length > 0) {
        let totalQty = 0;
        let totalReserved = 0;
        for (const q of quants) {
          console.log(`   Quant: qty=${q.quantity}, reserved=${q.reserved_quantity || 0}`);
          totalQty += q.quantity;
          totalReserved += (q.reserved_quantity || 0);
        }
        const freeQty = Math.max(0, Math.floor(totalQty - totalReserved));
        console.log(`\n   Total: ${totalQty} - ${totalReserved} reserved = ${freeQty} free`);

        const safetyStock = 10;
        const amazonQty = Math.max(0, freeQty - safetyStock);
        console.log(`   After safety stock (${safetyStock}): ${amazonQty} to Amazon`);
      } else {
        console.log('   No quants found in CW location');
      }
    }
  } else {
    console.log('   CW warehouse not found');
  }

  // Step 5: Check last stock update record
  console.log('\n5. Last Stock Update:');
  const lastUpdate = await db.collection('amazon_stock_updates').findOne(
    {},
    { sort: { submittedAt: -1 } }
  );
  if (lastUpdate) {
    console.log(`   Last sync: ${lastUpdate.submittedAt}`);
    console.log(`   Items: ${lastUpdate.itemCount}`);
    console.log(`   Updated: ${lastUpdate.updated}, Failed: ${lastUpdate.failed}`);
  }

  // Step 6: Check if SKU is in unresolved
  console.log('\n6. Unresolved SKUs:');
  const unresolved = await db.collection('amazon_unresolved_skus').findOne({ sellerSku: amazonSku });
  if (unresolved) {
    console.log(`   ${amazonSku} IS in unresolved list!`);
    console.log(`   Reason: ${unresolved.reason}`);
    console.log(`   Seen count: ${unresolved.seenCount}`);
  } else {
    console.log(`   ${amazonSku} is NOT in unresolved list`);
  }

  process.exit(0);
}

diagnose().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
