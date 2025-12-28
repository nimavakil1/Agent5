/**
 * Settings API Routes
 *
 * Manage application settings including sync intervals.
 */

const express = require('express');
const router = express.Router();
const Setting = require('../../models/Setting');

// ============================================
// SYNC INTERVAL SETTINGS
// ============================================

/**
 * Get sync interval settings
 * GET /api/settings/sync-intervals
 */
router.get('/sync-intervals', async (req, res) => {
  try {
    const intervals = await Setting.getMany([
      'sync.warehouses.interval',
      'sync.categories.interval',
      'sync.products.interval'
    ]);

    res.json({
      success: true,
      warehouses: intervals['sync.warehouses.interval'] || 24,
      categories: intervals['sync.categories.interval'] || 24,
      products: intervals['sync.products.interval'] || 24
    });
  } catch (error) {
    console.error('[Settings API] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update sync interval settings
 * POST /api/settings/sync-intervals
 */
router.post('/sync-intervals', async (req, res) => {
  try {
    const { warehouses, categories, products } = req.body;

    if (warehouses !== undefined) {
      await Setting.set('sync.warehouses.interval', parseInt(warehouses), 'Warehouse sync interval in hours');
    }
    if (categories !== undefined) {
      await Setting.set('sync.categories.interval', parseInt(categories), 'Category sync interval in hours');
    }
    if (products !== undefined) {
      await Setting.set('sync.products.interval', parseInt(products), 'Product sync interval in hours');
    }

    res.json({
      success: true,
      message: 'Sync intervals updated'
    });
  } catch (error) {
    console.error('[Settings API] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// GENERAL SETTINGS
// ============================================

/**
 * Get a setting by key
 * GET /api/settings/:key
 */
router.get('/:key', async (req, res) => {
  try {
    const value = await Setting.get(req.params.key);
    res.json({
      success: true,
      key: req.params.key,
      value
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Set a setting
 * POST /api/settings/:key
 */
router.post('/:key', async (req, res) => {
  try {
    const { value, description } = req.body;
    await Setting.set(req.params.key, value, description);
    res.json({
      success: true,
      message: 'Setting updated'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
