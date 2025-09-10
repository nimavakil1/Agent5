const express = require('express');
const { allowBearerOrSession } = require('../../middleware/sessionAuth');
const Product = require('../../models/Product');

const router = express.Router();
router.use(allowBearerOrSession);

router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const inStock = req.query.in_stock === '1' || req.query.in_stock === 'true';
    const cond = { allowed: true };
    if (q) {
      cond.$or = [
        { sku: new RegExp(q, 'i') },
        { title: new RegExp(q, 'i') },
        { variant_title: new RegExp(q, 'i') },
      ];
    }
    if (inStock) cond.inventory_quantity = { $gt: 0 };
    const list = await Product.find(cond).sort({ title: 1 }).limit(500).lean();
    res.json(list);
  } catch (e) {
    res.status(500).json({ message: 'Failed to list products', error: e.message });
  }
});

router.get('/:variant_id', async (req, res) => {
  try {
    const vid = Number(req.params.variant_id);
    const doc = await Product.findOne({ variant_id: vid }).lean();
    if (!doc) return res.status(404).json({ message: 'not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: 'Failed to fetch product', error: e.message });
  }
});

module.exports = router;

