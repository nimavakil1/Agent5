const AllowedProduct = require('../../models/AllowedProduct');
const Product = require('../../models/Product');
const { adminFetch, getVariantIdBySku } = require('./shopifyService');

async function resolveVariantId(entry) {
  if (entry.variant_id) return Number(entry.variant_id);
  if (entry.sku) {
    const id = await getVariantIdBySku(entry.sku);
    return Number(id);
  }
  throw new Error('Entry requires variant_id or sku');
}

async function fetchVariant(variantId) {
  const data = await adminFetch(`/variants/${variantId}.json`);
  if (!data || !data.variant) throw new Error('Variant not found');
  return data.variant;
}

async function fetchProduct(productId) {
  const data = await adminFetch(`/products/${productId}.json`);
  if (!data || !data.product) throw new Error('Product not found');
  return data.product;
}

async function syncEntries(entries) {
  const now = new Date();
  const allowedVariantIds = [];
  for (const e of entries) {
    const vid = await resolveVariantId(e);
    allowedVariantIds.push(vid);
    const v = await fetchVariant(vid);
    const p = await fetchProduct(v.product_id);
    const image = (v.image_id && Array.isArray(p.images)) ? (p.images.find(i => i.id === v.image_id)?.src || '') : (p.image?.src || (Array.isArray(p.images) && p.images[0]?.src) || '');
    const gross = Number(v.price || 0);
    const vatRate = 0.21;
    const net = gross ? Number((gross / (1 + vatRate)).toFixed(2)) : 0;
    const doc = {
      variant_id: v.id,
      product_id: v.product_id,
      sku: v.sku || '',
      title: p.title || v.title || '',
      variant_title: v.title || '',
      price: String(v.price || ''),
      price_ex_vat: net,
      vat_rate: vatRate,
      currency: 'EUR',
      image,
      inventory_quantity: typeof v.inventory_quantity === 'number' ? v.inventory_quantity : undefined,
      available: v.available != null ? !!v.available : true,
      allowed: true,
      synced_at: now,
    };
    await Product.findOneAndUpdate({ variant_id: v.id }, { $set: doc }, { upsert: true, new: true });
  }
  // Mark products not in allowed list as not allowed (but keep in cache)
  await Product.updateMany({ variant_id: { $nin: allowedVariantIds } }, { $set: { allowed: false } });
  return { synced: entries.length };
}

async function syncAllowed() {
  const entries = await AllowedProduct.find({ active: true }).lean();
  if (!entries.length) return { synced: 0 };
  return syncEntries(entries);
}

module.exports = { syncEntries, syncAllowed };
