/**
 * Warehouses API Routes
 *
 * Manage warehouse cache:
 * - List cached warehouses
 * - Sync from Odoo
 * - Toggle active status
 * - Reorder warehouses
 */

const express = require('express');
const router = express.Router();
const Warehouse = require('../../models/Warehouse');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');

// ============================================
// WAREHOUSE LIST ENDPOINTS
// ============================================

/**
 * Get all warehouses from cache
 * GET /api/warehouses
 */
router.get('/', async (req, res) => {
  try {
    const { active } = req.query;

    let warehouses;
    if (active === 'true') {
      warehouses = await Warehouse.getActive();
    } else {
      warehouses = await Warehouse.getAll();
    }

    // Get last sync time
    const lastSync = warehouses.length > 0
      ? warehouses.reduce((latest, w) => {
          if (!w.lastSyncedAt) return latest;
          return !latest || w.lastSyncedAt > latest ? w.lastSyncedAt : latest;
        }, null)
      : null;

    res.json({
      success: true,
      count: warehouses.length,
      lastSyncedAt: lastSync,
      warehouses: warehouses.map(w => ({
        id: w.odooId,
        _id: w._id,
        name: w.name,
        code: w.code,
        stockLocationId: w.stockLocationId,
        isActive: w.isActive,
        sortOrder: w.sortOrder,
        lastSyncedAt: w.lastSyncedAt
      }))
    });
  } catch (error) {
    console.error('[Warehouses API] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single warehouse
 * GET /api/warehouses/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const warehouse = await Warehouse.findById(req.params.id).lean();
    if (!warehouse) {
      return res.status(404).json({ success: false, error: 'Warehouse not found' });
    }

    res.json({
      success: true,
      warehouse: {
        id: warehouse.odooId,
        _id: warehouse._id,
        name: warehouse.name,
        code: warehouse.code,
        stockLocationId: warehouse.stockLocationId,
        isActive: warehouse.isActive,
        sortOrder: warehouse.sortOrder,
        lastSyncedAt: warehouse.lastSyncedAt
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
 * Sync warehouses from Odoo
 * POST /api/warehouses/sync
 */
router.post('/sync', async (req, res) => {
  try {
    console.log('[Warehouses API] Starting sync from Odoo...');

    const odooClient = new OdooDirectClient();
    await odooClient.authenticate();

    const result = await Warehouse.syncFromOdoo(odooClient);

    console.log(`[Warehouses API] Sync complete: ${result.created} created, ${result.updated} updated`);

    res.json({
      success: true,
      message: `Synced ${result.total} warehouses (${result.created} new, ${result.updated} updated)`,
      ...result
    });
  } catch (error) {
    console.error('[Warehouses API] Sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get sync status
 * GET /api/warehouses/sync/status
 */
router.get('/sync/status', async (req, res) => {
  try {
    const count = await Warehouse.countDocuments();
    const warehouses = await Warehouse.find().select('lastSyncedAt').lean();

    const lastSync = warehouses.reduce((latest, w) => {
      if (!w.lastSyncedAt) return latest;
      return !latest || w.lastSyncedAt > latest ? w.lastSyncedAt : latest;
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
 * Toggle warehouse active status
 * POST /api/warehouses/:id/toggle-active
 */
router.post('/:id/toggle-active', async (req, res) => {
  try {
    const warehouse = await Warehouse.findById(req.params.id);

    if (!warehouse) {
      return res.status(404).json({ success: false, error: 'Warehouse not found' });
    }

    warehouse.isActive = !warehouse.isActive;
    await warehouse.save();

    res.json({
      success: true,
      message: `Warehouse "${warehouse.name}" is now ${warehouse.isActive ? 'active' : 'inactive'}`,
      isActive: warehouse.isActive
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update warehouse sort order
 * POST /api/warehouses/reorder
 */
router.post('/reorder', async (req, res) => {
  try {
    const { order } = req.body; // Array of { id, sortOrder }

    if (!order || !Array.isArray(order)) {
      return res.status(400).json({
        success: false,
        error: 'Expected array of { id, sortOrder }'
      });
    }

    const updates = order.map(item =>
      Warehouse.updateOne({ _id: item.id }, { sortOrder: item.sortOrder })
    );

    await Promise.all(updates);

    res.json({
      success: true,
      message: `Updated sort order for ${order.length} warehouses`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
