const express = require('express');
const { requireSession, allowBearerOrSession } = require('../../middleware/sessionAuth');
const {
  createPrefilledCartLink,
  getVariantIdBySku,
  adminFetch,
  createCheckoutWebUrl,
} = require('../services/shopifyService');

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
    const url = await createCheckoutWebUrl(items, discount_code || '');
    res.json({ checkout_url: url });
  } catch (e) {
    res.status(500).json({ message: 'Failed to create checkout', error: e.message });
  }
});

module.exports = router;
