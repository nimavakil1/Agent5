const express = require('express');
const { requireSession: _requireSession, allowBearerOrSession } = require('../../middleware/sessionAuth');
const {
  createPrefilledCartLink,
  getVariantIdBySku,
  adminFetch,
  createCheckoutWebUrl,
} = require('../services/shopifyService');
const { syncEntries, syncAllowed } = require('../services/shopifySyncService');
const AllowedProduct = require('../../models/AllowedProduct');
const Product = require('../../models/Product');

const router = express.Router();

// Ensure authenticated via session or bearer
router.use(allowBearerOrSession);

// POST /api/shopify/customers
router.post('/customers', async (req, res) => {
  try {
    const body = req.body || {};
    const payload = { customer: body };
    const data = await adminFetch('/customers.json', { method: 'POST', body: payload });
    res.status(201).json(data.customer || data);
  } catch (e) {
    res.status(500).json({ message: 'Failed to create customer', error: e.message });
  }
});

// POST /api/shopify/customers/:id/addresses
router.post('/customers/:id/addresses', async (req, res) => {
  try {
    const id = req.params.id;
    const payload = { address: req.body || {} };
    const data = await adminFetch(`/customers/${id}/addresses.json`, { method: 'POST', body: payload });
    res.status(201).json(data.customer_address || data);
  } catch (e) {
    res.status(500).json({ message: 'Failed to add address', error: e.message });
  }
});

// POST /api/shopify/discount
// body: { code, value, value_type: 'percentage'|'fixed_amount', starts_at, ends_at, usage_limit }
router.post('/discount', async (req, res) => {
  try {
    const { code, value = 10, value_type = 'percentage', starts_at, ends_at, usage_limit } = req.body || {};
    if (!code) return res.status(400).json({ message: 'code required' });

    // Create price rule
    const rule = {
      price_rule: {
        title: code,
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type,
        value: -Math.abs(Number(value) || 0),
        customer_selection: 'all',
        once_per_customer: false,
        starts_at: starts_at || new Date().toISOString(),
      },
    };
    if (ends_at) rule.price_rule.ends_at = new Date(ends_at).toISOString();
    if (usage_limit) rule.price_rule.usage_limit = Number(usage_limit);

    const pr = await adminFetch('/price_rules.json', { method: 'POST', body: rule });
    const priceRuleId = pr.price_rule?.id;
    if (!priceRuleId) throw new Error('Failed to create price rule');

    // Attach discount code
    const dc = await adminFetch(`/price_rules/${priceRuleId}/discount_codes.json`, {
      method: 'POST',
      body: { discount_code: { code } },
    });
    res.status(201).json({ price_rule: pr.price_rule, discount_code: dc.discount_code || dc });
  } catch (e) {
    res.status(500).json({ message: 'Failed to create discount', error: e.message });
  }
});

// POST /api/shopify/cart-link
// body: { items: [{ sku or variant_id, quantity }], discount_code? }
router.post('/cart-link', async (req, res) => {
  try {
    const { items, discount_code } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'items required' });
    const link = await createPrefilledCartLink(items);
    const final = discount_code ? `${link}?discount=${encodeURIComponent(discount_code)}` : link;
    res.json({ cart_link: final });
  } catch (e) {
    res.status(500).json({ message: 'Failed to build cart link', error: e.message });
  }
});

// POST /api/shopify/checkout
// body: { items: [{ sku or variant_id, quantity }], discount_code? }
router.post('/checkout', async (req, res) => {
  try {
    const { items, discount_code } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'items required' });
    // Enforce allowed products
    const variantIds = [];
    for (const it of items) {
      if (it.variant_id) variantIds.push(Number(it.variant_id));
      else if (it.sku) {
        const id = await getVariantIdBySku(it.sku);
        variantIds.push(Number(id));
      }
    }
    if (!variantIds.length) return res.status(400).json({ message: 'items must include variant_id or sku' });
    const allowedCount = await Product.countDocuments({ variant_id: { $in: variantIds }, allowed: true });
    if (allowedCount !== variantIds.length) return res.status(403).json({ message: 'one or more items not allowed' });
    const url = await createCheckoutWebUrl(items, discount_code || '');
    res.json({ checkout_url: url });
  } catch (e) {
    res.status(500).json({ message: 'Failed to create checkout', error: e.message });
  }
});

// POST /api/shopify/draft-order
// body: {
//   line_items: [{ variant_id: number, quantity: number }],
//   email?: string,
//   customer_id?: number,
//   shipping_address?: object,
//   discount?: { type: 'percentage'|'fixed_amount', value: number, title?: string, description?: string }
// }
router.post('/draft-order', async (req, res) => {
  try {
    const { line_items, email, customer_id, shipping_address, discount } = req.body || {};
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ message: 'line_items required' });
    }
    // Enforce allowed products
    const variantIds = line_items.map(li => Number(li.variant_id)).filter(Boolean);
    if (!variantIds.length) return res.status(400).json({ message: 'line_items require variant_id' });
    const allowedCount = await Product.countDocuments({ variant_id: { $in: variantIds }, allowed: true });
    if (allowedCount !== variantIds.length) return res.status(403).json({ message: 'one or more items not allowed' });

    const draft = { line_items };
    if (email) draft.email = String(email);
    if (customer_id) draft.customer = { id: customer_id };
    if (shipping_address && typeof shipping_address === 'object') draft.shipping_address = shipping_address;

    if (discount && discount.value) {
      const vt = discount.type === 'fixed_amount' ? 'fixed_amount' : 'percentage';
      draft.applied_discount = {
        value_type: vt,
        value: String(Math.abs(Number(discount.value) || 0)),
        title: discount.title || 'manual_discount',
        description: discount.description || '',
      };
    }

    const payload = { draft_order: draft };
    const data = await adminFetch('/draft_orders.json', { method: 'POST', body: payload });
    const out = data.draft_order || data;
    return res.status(201).json({
      id: out.id,
      name: out.name,
      invoice_url: out.invoice_url || null,
      status: out.status,
      draft_order: out,
    });
  } catch (e) {
    res.status(500).json({ message: 'Failed to create draft order', error: e.message });
  }
});

// Manage allowed list
router.get('/allowed', async (req, res) => {
  const list = await AllowedProduct.find({}).sort({ createdAt: 1 }).lean();
  res.json(list);
});

router.post('/allowed', async (req, res) => {
  try {
    const items = req.body?.items;
    const replace = (req.body?.replace === true || req.query.mode === 'replace') && process.env.PROTECT_DATA !== '1';
    if (!Array.isArray(items)) return res.status(400).json({ message: 'items array required' });

    // Upsert each provided item; default merge behavior (non-provided remain unchanged)
    const ops = [];
    const seenVariantIds = new Set();
    const seenSkus = new Set();
    for (const it of items) {
      const filter = it.variant_id ? { variant_id: Number(it.variant_id) } : (it.sku ? { sku: String(it.sku) } : null);
      if (!filter) continue;
      if (filter.variant_id) seenVariantIds.add(Number(it.variant_id));
      if (filter.sku) seenSkus.add(String(it.sku));
      const update = { $set: { active: it.active !== false } };
      if (filter.variant_id && it.sku) update.$set.sku = String(it.sku);
      if (filter.sku && it.variant_id) update.$set.variant_id = Number(it.variant_id);
      ops.push({ updateOne: { filter, update, upsert: true } });
    }
    if (ops.length) await AllowedProduct.bulkWrite(ops, { ordered: false });

    // If replace mode explicitly requested (and not protected), deactivate anything not provided
    if (replace) {
      const cond = { $or: [] };
      if (seenVariantIds.size) cond.$or.push({ variant_id: { $nin: Array.from(seenVariantIds) } });
      if (seenSkus.size) cond.$or.push({ sku: { $nin: Array.from(seenSkus) } });
      if (cond.$or.length) {
        await AllowedProduct.updateMany(cond, { $set: { active: false } });
      }
    }

    res.status(201).json({ saved: ops.length, mode: replace ? 'replace' : 'merge' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to save allowed list', error: e.message });
  }
});

// Trigger sync
router.post('/sync', async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.items) ? req.body.items : null;
    const result = entries ? await syncEntries(entries) : await syncAllowed();
    res.json(result);
  } catch (e) {
    res.status(500).json({ message: 'Failed to sync products', error: e.message });
  }
});

module.exports = router;
