/**
 * Product Model - Synced from Odoo
 *
 * Stores product data with stock levels per warehouse.
 * Synced incrementally based on Odoo's write_date.
 */

const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  // Odoo ID (primary key for sync)
  odooId: { type: Number, required: true, unique: true, index: true },

  // Product identity
  name: { type: String, required: true },
  sku: { type: String, index: true },  // default_code in Odoo
  barcode: { type: String, index: true },
  active: { type: Boolean, default: true },

  // Classification
  type: { type: String },  // 'product', 'consu', 'service'
  category: { type: String },
  categoryId: { type: Number },

  // Pricing
  salePrice: { type: Number },  // list_price
  cost: { type: Number },       // standard_price

  // Units
  uom: { type: String },
  uomId: { type: Number },

  // Physical
  weight: { type: Number },
  volume: { type: Number },

  // Flags
  canSell: { type: Boolean, default: true },
  canPurchase: { type: Boolean, default: false },

  // Image (base64 thumbnail)
  image: { type: String },

  // Stock levels per warehouse: { "1": 50, "5": 20, ... }
  stockByWarehouse: {
    type: Map,
    of: Number,
    default: new Map()
  },

  // Computed totals (for quick access)
  totalStock: { type: Number, default: 0 },
  cwStock: { type: Number, default: 0 },  // Central Warehouse (ID 1)

  // Sync tracking
  odooWriteDate: { type: Date },  // Odoo's write_date for change detection
  syncedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  collection: 'products'
});

// Indexes for common queries
productSchema.index({ name: 'text', sku: 'text' });
productSchema.index({ totalStock: 1 });
productSchema.index({ syncedAt: 1 });
productSchema.index({ odooWriteDate: 1 });
productSchema.index({ active: 1, canSell: 1 });

// Virtual for stock status
productSchema.virtual('stockStatus').get(function() {
  if (this.totalStock <= 0) return 'out';
  if (this.totalStock <= 10) return 'low';
  return 'in';
});

// Static method for bulk upsert
productSchema.statics.bulkUpsertFromOdoo = async function(products) {
  const ops = products.map(p => ({
    updateOne: {
      filter: { odooId: p.odooId },
      update: { $set: p },
      upsert: true
    }
  }));

  if (ops.length > 0) {
    return this.bulkWrite(ops, { ordered: false });
  }
  return { modifiedCount: 0, upsertedCount: 0 };
};

module.exports = mongoose.model('Product', productSchema);
