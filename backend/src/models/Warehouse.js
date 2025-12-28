/**
 * Warehouse Model
 *
 * Caches warehouse data from Odoo for fast access.
 * Synced periodically from Odoo (nightly or on-demand).
 */

const mongoose = require('mongoose');

const warehouseSchema = new mongoose.Schema({
  // Odoo ID
  odooId: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },

  // Basic info from Odoo
  name: {
    type: String,
    required: true
  },
  code: {
    type: String,
    required: true
  },

  // Stock location ID (for querying stock.quant)
  stockLocationId: {
    type: Number,
    default: null
  },

  // Display settings
  isActive: {
    type: Boolean,
    default: true
  },
  sortOrder: {
    type: Number,
    default: 0
  },

  // Sync tracking
  lastSyncedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  collection: 'warehouses'
});

// Indexes
warehouseSchema.index({ isActive: 1, sortOrder: 1 });
warehouseSchema.index({ code: 1 });

// Static method to sync from Odoo
warehouseSchema.statics.syncFromOdoo = async function(odooClient) {
  const Warehouse = this;

  // Fetch warehouses from Odoo
  const odooWarehouses = await odooClient.searchRead('stock.warehouse', [], [
    'id', 'name', 'code', 'lot_stock_id'
  ], { order: 'id asc' });

  let created = 0;
  let updated = 0;

  for (const w of odooWarehouses) {
    const existing = await Warehouse.findOne({ odooId: w.id });

    const warehouseData = {
      odooId: w.id,
      name: w.name,
      code: w.code,
      stockLocationId: w.lot_stock_id ? w.lot_stock_id[0] : null,
      lastSyncedAt: new Date()
    };

    if (existing) {
      await Warehouse.updateOne({ odooId: w.id }, warehouseData);
      updated++;
    } else {
      await Warehouse.create({
        ...warehouseData,
        sortOrder: w.id // Default sort by Odoo ID
      });
      created++;
    }
  }

  return { created, updated, total: odooWarehouses.length };
};

// Static method to get all active warehouses
warehouseSchema.statics.getActive = function() {
  return this.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
};

// Static method to get all warehouses for API
warehouseSchema.statics.getAll = function() {
  return this.find().sort({ sortOrder: 1, name: 1 }).lean();
};

// Static method to get warehouse by Odoo ID
warehouseSchema.statics.findByOdooId = function(odooId) {
  return this.findOne({ odooId });
};

module.exports = mongoose.model('Warehouse', warehouseSchema);
