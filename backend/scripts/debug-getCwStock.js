/**
 * Debug getCwStock for P0063
 */
require('dotenv').config();
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { skuResolver } = require('../src/services/amazon/SkuResolver');

async function debug() {
  await connectDb();
  const db = getDb();
  await skuResolver.load();

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get all unique Odoo SKUs
  const listings = await db.collection('amazon_fbm_listings')
    .find({ fulfillmentChannel: 'DEFAULT' })
    .toArray();

  const odooSkus = new Set();
  for (const l of listings) {
    const res = skuResolver.resolve(l.sellerSku);
    if (res.odooSku) odooSkus.add(res.odooSku);
  }

  const skuArray = [...odooSkus];
  console.log('Total unique Odoo SKUs:', skuArray.length);
  console.log('P0063 index in array:', skuArray.indexOf('P0063'));

  // Find products
  const products = await odoo.searchRead('product.product',
    [['default_code', 'in', skuArray], ['active', '=', true]],
    ['id', 'default_code']
  );

  console.log('\nProducts found:', products.length);

  // Check P0063
  const p0063 = products.find(p => p.default_code === 'P0063');
  console.log('P0063 found:', !!p0063, p0063 ? 'id=' + p0063.id : '');

  // Get CW location
  const warehouses = await odoo.searchRead('stock.warehouse',
    [['code', '=', 'CW']], ['lot_stock_id']);
  const cwLocationId = warehouses[0].lot_stock_id[0];

  // Get quants
  const productIds = products.map(p => p.id);
  console.log('\nSearching quants for', productIds.length, 'product IDs');
  console.log('P0063 product ID:', p0063 ? p0063.id : null, 'in list:', productIds.includes(p0063 ? p0063.id : -1));

  const quants = await odoo.searchRead('stock.quant',
    [['product_id', 'in', productIds], ['location_id', '=', cwLocationId]],
    ['product_id', 'quantity', 'reserved_quantity']
  );

  console.log('Quants found:', quants.length);

  // Check P0063 quant
  if (p0063) {
    const p0063Quant = quants.find(q => q.product_id[0] === p0063.id);
    console.log('P0063 quant:', p0063Quant);
  }

  // Build the stock map like getCwStock does
  const productIdToSku = {};
  for (const p of products) {
    if (p.default_code) productIdToSku[p.id] = p.default_code;
  }

  const stockMap = new Map();
  for (const sku of skuArray) stockMap.set(sku, 0);

  for (const quant of quants) {
    const productId = quant.product_id[0];
    const sku = productIdToSku[productId];
    if (sku) {
      const available = Math.max(0, Math.floor(quant.quantity - (quant.reserved_quantity || 0)));
      stockMap.set(sku, (stockMap.get(sku) || 0) + available);
    }
  }

  console.log('\nFinal P0063 in stockMap:', stockMap.get('P0063'));

  // Count how many SKUs have stock
  let withStock = 0;
  for (const [sku, qty] of stockMap) {
    if (qty > 0) withStock++;
  }
  console.log('SKUs with stock:', withStock);

  process.exit(0);
}

debug().catch(e => { console.error(e); process.exit(1); });
