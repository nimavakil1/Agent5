#!/usr/bin/env node
/**
 * Get all CW stock for FBM sync preview
 */
require('dotenv').config();
const { connectDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function run() {
  try {
    console.error('Connecting...');
    await connectDb();

    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    // Find Central Warehouse location
    const warehouses = await odoo.searchRead('stock.warehouse',
      [['name', 'ilike', 'Central%']],
      ['id', 'name', 'lot_stock_id']
    );

    if (warehouses.length === 0) {
      throw new Error('Central Warehouse not found');
    }

    const centralLocationId = warehouses[0].lot_stock_id[0];
    console.error('Central Warehouse location:', centralLocationId);

    // Get ALL stock quants with high limit
    const quants = await odoo.searchRead('stock.quant',
      [
        ['location_id', '=', centralLocationId],
        ['quantity', '>', 0]
      ],
      ['product_id', 'quantity', 'reserved_quantity'],
      { limit: 10000 }
    );

    console.error('Total quants found:', quants.length);

    // Get ALL products
    const productIds = [...new Set(quants.map(q => q.product_id[0]))];
    console.error('Unique product IDs:', productIds.length);

    const products = await odoo.searchRead('product.product',
      [['id', 'in', productIds]],
      ['id', 'default_code', 'name', 'active'],
      { limit: 10000 }
    );

    const productMap = {};
    for (const p of products) {
      if (p.default_code && p.active) {
        productMap[p.id] = { sku: p.default_code, name: p.name };
      }
    }

    // Build inventory list
    const skuTotals = {};
    for (const quant of quants) {
      const product = productMap[quant.product_id[0]];
      if (!product) continue;

      const available = Math.max(0, Math.floor(quant.quantity - (quant.reserved_quantity || 0)));

      if (!skuTotals[product.sku]) {
        skuTotals[product.sku] = { sku: product.sku, name: product.name, quantity: 0 };
      }
      skuTotals[product.sku].quantity += available;
    }

    const inventory = Object.values(skuTotals).filter(i => i.quantity > 0);

    // Output JSON to stdout
    console.log(JSON.stringify(inventory));

    console.error('Total SKUs with stock:', inventory.length);
    console.error('Total quantity:', inventory.reduce((sum, i) => sum + i.quantity, 0));

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

run().then(() => process.exit(0));
