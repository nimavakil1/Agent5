const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    variant_id: { type: Number, required: true, unique: true, index: true },
    product_id: { type: Number, required: true, index: true },
    sku: { type: String, index: true },
    title: { type: String },
    variant_title: { type: String },
    price: { type: String },
    currency: { type: String, default: 'EUR' },
    image: { type: String },
    inventory_quantity: { type: Number },
    available: { type: Boolean, default: true },
    allowed: { type: Boolean, default: true },
    synced_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Product', productSchema);

