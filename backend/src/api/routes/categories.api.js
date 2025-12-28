/**
 * Categories API Routes
 *
 * Manage product category cache:
 * - List cached categories
 * - Sync from Odoo
 * - Toggle active status
 */

const express = require('express');
const router = express.Router();
const Category = require('../../models/Category');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// ============================================
// CATEGORY LIST ENDPOINTS
// ============================================

/**
 * Get all categories from cache
 * GET /api/categories
 */
router.get('/', async (req, res) => {
  try {
    const { active, tree } = req.query;

    let categories;
    if (tree === 'true') {
      categories = await Category.getTree();
      return res.json({
        success: true,
        count: categories.length,
        categories
      });
    } else if (active === 'true') {
      categories = await Category.getActive();
    } else {
      categories = await Category.getAll();
    }

    // Get last sync time
    const lastSync = categories.length > 0
      ? categories.reduce((latest, c) => {
          if (!c.lastSyncedAt) return latest;
          return !latest || c.lastSyncedAt > latest ? c.lastSyncedAt : latest;
        }, null)
      : null;

    res.json({
      success: true,
      count: categories.length,
      lastSyncedAt: lastSync,
      categories: categories.map(c => ({
        id: c.odooId,
        _id: c._id,
        name: c.name,
        completeName: c.completeName,
        parentId: c.parentId,
        parentName: c.parentName,
        productCount: c.productCount,
        isActive: c.isActive,
        sortOrder: c.sortOrder,
        lastSyncedAt: c.lastSyncedAt
      }))
    });
  } catch (error) {
    console.error('[Categories API] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single category
 * GET /api/categories/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const category = await Category.findById(req.params.id).lean();
    if (!category) {
      return res.status(404).json({ success: false, error: 'Category not found' });
    }

    res.json({
      success: true,
      category: {
        id: category.odooId,
        _id: category._id,
        name: category.name,
        completeName: category.completeName,
        parentId: category.parentId,
        parentName: category.parentName,
        productCount: category.productCount,
        isActive: category.isActive,
        sortOrder: category.sortOrder,
        lastSyncedAt: category.lastSyncedAt
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// SYNC ENDPOINTS
// ============================================

/**
 * Sync categories from Odoo
 * POST /api/categories/sync
 */
router.post('/sync', async (req, res) => {
  try {
    console.log('[Categories API] Starting sync from Odoo...');

    const odooClient = new OdooDirectClient();
    await odooClient.authenticate();

    const result = await Category.syncFromOdoo(odooClient);

    console.log(`[Categories API] Sync complete: ${result.created} created, ${result.updated} updated`);

    res.json({
      success: true,
      message: `Synced ${result.total} categories (${result.created} new, ${result.updated} updated)`,
      ...result
    });
  } catch (error) {
    console.error('[Categories API] Sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get sync status
 * GET /api/categories/sync/status
 */
router.get('/sync/status', async (req, res) => {
  try {
    const count = await Category.countDocuments();
    const categories = await Category.find().select('lastSyncedAt').lean();

    const lastSync = categories.reduce((latest, c) => {
      if (!c.lastSyncedAt) return latest;
      return !latest || c.lastSyncedAt > latest ? c.lastSyncedAt : latest;
    }, null);

    res.json({
      success: true,
      count,
      lastSyncedAt: lastSync,
      needsSync: count === 0
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// MANAGEMENT ENDPOINTS
// ============================================

/**
 * Toggle category active status
 * POST /api/categories/:id/toggle-active
 */
router.post('/:id/toggle-active', async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({ success: false, error: 'Category not found' });
    }

    category.isActive = !category.isActive;
    await category.save();

    res.json({
      success: true,
      message: `Category "${category.name}" is now ${category.isActive ? 'active' : 'inactive'}`,
      isActive: category.isActive
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
