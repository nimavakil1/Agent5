const { MongoClient } = require("mongodb");
const { OdooDirectClient } = require("../src/core/agents/integrations/OdooMCP");

async function reenrich() {
  const poNumber = process.argv[2] || "4WZ7I1UZ";

  const client = new MongoClient("mongodb://localhost:27017");
  await client.connect();
  const db = client.db("agent5");

  const collection = db.collection("vendor_purchase_orders");
  const po = await collection.findOne({ purchaseOrderNumber: poNumber });

  if (!po) {
    console.log("PO not found:", poNumber);
    await client.close();
    return;
  }

  console.log("Re-enriching PO:", poNumber);
  console.log("Items:", po.items.length);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get Central Warehouse ID
  const warehouses = await odoo.search('stock.warehouse', [['code', '=', 'CW']], { limit: 1 });
  const warehouseId = warehouses.length > 0 ? warehouses[0] : null;

  if (!warehouseId) {
    console.error("Central Warehouse (CW) not found");
    await client.close();
    return;
  }

  const updatedItems = [];

  for (const item of po.items) {
    const ean = item.vendorProductIdentifier;
    const asin = item.amazonProductIdentifier;

    console.log("\n--- Line", item.itemSequenceNumber, "---");
    console.log("EAN:", ean);
    console.log("ASIN:", asin);

    let productData = null;

    // Search by EAN (barcode)
    if (ean) {
      const products = await odoo.searchRead('product.product',
        [['barcode', '=', ean]],
        ['id', 'name', 'default_code', 'barcode'],
        { limit: 1 }
      );
      if (products.length > 0) {
        productData = products[0];
        console.log("Found by EAN:", productData.default_code);
      }
    }

    // Fallback: search by ASIN in barcode
    if (!productData && asin) {
      const products = await odoo.searchRead('product.product',
        [['barcode', '=', asin]],
        ['id', 'name', 'default_code', 'barcode'],
        { limit: 1 }
      );
      if (products.length > 0) {
        productData = products[0];
        console.log("Found by ASIN in barcode:", productData.default_code);
      }
    }

    // Fallback 2: search by ASIN in amazon.product.ept
    if (!productData && asin) {
      try {
        const eptMappings = await odoo.searchRead('amazon.product.ept',
          [['product_asin', '=', asin]],
          ['id', 'product_id'],
          { limit: 1 }
        );
        if (eptMappings.length > 0 && eptMappings[0].product_id) {
          const productId = eptMappings[0].product_id[0];
          const products = await odoo.searchRead('product.product',
            [['id', '=', productId]],
            ['id', 'name', 'default_code', 'barcode'],
            { limit: 1 }
          );
          if (products.length > 0) {
            productData = products[0];
            console.log("Found via EPT mapping:", productData.default_code);
          }
        }
      } catch (eptErr) {
        console.log("EPT search error:", eptErr.message);
      }
    }

    if (productData) {
      // Get stock from Central Warehouse
      const quants = await odoo.searchRead('stock.quant',
        [
          ['product_id', '=', productData.id],
          ['location_id.usage', '=', 'internal'],
          ['location_id.warehouse_id', '=', warehouseId]
        ],
        ['quantity', 'reserved_quantity'],
        { limit: 100 }
      );

      const qtyAvailable = quants.length > 0
        ? Math.max(0, quants.reduce((sum, q) => sum + (q.quantity - q.reserved_quantity), 0))
        : 0;

      updatedItems.push({
        ...item,
        odooProductId: productData.id,
        odooProductName: productData.name,
        odooSku: productData.default_code,
        odooBarcode: productData.barcode,
        qtyAvailable
      });

      console.log("Mapped to:", productData.default_code, "- Stock:", qtyAvailable);
    } else {
      updatedItems.push(item);
      console.log("NOT FOUND");
    }
  }

  // Update PO
  await collection.updateOne(
    { purchaseOrderNumber: poNumber },
    { $set: { items: updatedItems, updatedAt: new Date() } }
  );

  console.log("\n=== Summary ===");
  console.log("Enriched:", updatedItems.filter(i => i.odooProductId).length, "/", updatedItems.length, "items");

  await client.close();
}

reenrich().catch(console.error);
