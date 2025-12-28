/**
 * Category Model
 *
 * Caches product category data from Odoo for fast access.
 * Synced periodically from Odoo (nightly or on-demand).
 */

const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
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
  completeName: {
    type: String,
    default: null
  },

  // Parent category (for hierarchy)
  parentId: {
    type: Number,
    default: null
  },
  parentName: {
    type: String,
    default: null
  },

  // Product count
  productCount: {
    type: Number,
    default: 0
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
  collection: 'categories'
});

// Indexes
categorySchema.index({ isActive: 1, sortOrder: 1 });
categorySchema.index({ parentId: 1 });
categorySchema.index({ name: 1 });

// Static method to sync from Odoo
categorySchema.statics.syncFromOdoo = async function(odooClient) {
  const Category = this;

  // Fetch categories from Odoo
  const odooCategories = await odooClient.searchRead('product.category', [], [
    'id', 'name', 'complete_name', 'parent_id', 'product_count'
  ], { order: 'complete_name asc' });

  let created = 0;
  let updated = 0;

  for (const c of odooCategories) {
    const existing = await Category.findOne({ odooId: c.id });

    const categoryData = {
      odooId: c.id,
      name: c.name,
      completeName: c.complete_name || c.name,
      parentId: c.parent_id ? c.parent_id[0] : null,
      parentName: c.parent_id ? c.parent_id[1] : null,
      productCount: c.product_count || 0,
      lastSyncedAt: new Date()
    };

    if (existing) {
      await Category.updateOne({ odooId: c.id }, categoryData);
      updated++;
    } else {
      await Category.create({
        ...categoryData,
        sortOrder: c.id
      });
      created++;
    }
  }

  return { created, updated, total: odooCategories.length };
};

// Static method to get all active categories
categorySchema.statics.getActive = function() {
  return this.find({ isActive: true }).sort({ completeName: 1 }).lean();
};

// Static method to get all categories for API
categorySchema.statics.getAll = function() {
  return this.find().sort({ completeName: 1 }).lean();
};

// Static method to get category by Odoo ID
categorySchema.statics.findByOdooId = function(odooId) {
  return this.findOne({ odooId });
};

// Static method to get category tree (hierarchical)
categorySchema.statics.getTree = async function() {
  const categories = await this.find({ isActive: true }).sort({ completeName: 1 }).lean();

  // Build tree structure
  const map = {};
  const roots = [];

  categories.forEach(c => {
    map[c.odooId] = { ...c, children: [] };
  });

  categories.forEach(c => {
    if (c.parentId && map[c.parentId]) {
      map[c.parentId].children.push(map[c.odooId]);
    } else {
      roots.push(map[c.odooId]);
    }
  });

  return roots;
};

module.exports = mongoose.model('Category', categorySchema);
