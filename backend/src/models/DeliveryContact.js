const mongoose = require('mongoose');

const deliveryContactSchema = new mongoose.Schema(
  {
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerRecord', required: true, index: true },
    code: { type: String, default: '' }, // unique per parent
    contact_name: { type: String },
    company: { type: String },
    address: { type: String },
    city: { type: String },
    postal_code: { type: String },
    country: { type: String },
    email: { type: String },
    phone: { type: String }, // landline
    mobile: { type: String },
    wa_preferred: { type: Boolean, default: false },
    language: { type: String },
    language_confirmed: { type: Boolean, default: false },
    tags: [{ type: String }],
    notes: { type: String },
    custom: { type: mongoose.Schema.Types.Mixed },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

deliveryContactSchema.index({ parentId: 1, code: 1 }, { unique: true, sparse: true });
deliveryContactSchema.index({ parentId: 1, phone: 1 });
deliveryContactSchema.index({ parentId: 1, mobile: 1 });
deliveryContactSchema.index({ parentId: 1, archived: 1, updatedAt: -1 });

module.exports = mongoose.model('DeliveryContact', deliveryContactSchema);

