const mongoose = require('mongoose');

const allowedProductSchema = new mongoose.Schema(
  {
    sku: { type: String, index: true },
    variant_id: { type: Number, index: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AllowedProduct', allowedProductSchema);

