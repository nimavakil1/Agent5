
const mongoose = require('mongoose');

const deliveryAddressSchema = new mongoose.Schema(
  {
    code: { type: String }, // optional identifier
    name: { type: String },
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
    custom: { type: mongoose.Schema.Types.Mixed }, // dynamic fields (per-delivery)
  },
  { _id: false }
);

const customerRecordSchema = new mongoose.Schema(
  {
    // Back-compat fields (will be deprecated):
    customer_id: { type: String },
    name: { type: String },
    phone_number: { type: String },
    preferred_language: { type: String },
    historical_offers: [String],
    previous_interactions: [
      {
        call_id: { type: String },
        date_time: { type: Date },
        outcome: { type: String },
      },
    ],

    // New flexible structure
    invoice: {
      name: { type: String },
      company: { type: String },
      vat: { type: String },
      address: { type: String },
      city: { type: String },
      postal_code: { type: String },
      country: { type: String },
      email: { type: String },
      website: { type: String },
      phone: { type: String }, // landline
      mobile: { type: String },
      language: { type: String },
      language_confirmed: { type: Boolean, default: false },
      custom: { type: mongoose.Schema.Types.Mixed }, // dynamic fields (invoice scope)
    },
    delivery_addresses: [deliveryAddressSchema],
    tags: [{ type: String }],
    custom: { type: mongoose.Schema.Types.Mixed }, // dynamic fields (customer scope)
    archived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Indexes per design
// Make phone index non-unique to allow duplicate invoice phones when desired
customerRecordSchema.index({ 'invoice.phone': 1 }, { sparse: true });
customerRecordSchema.index({ 'delivery_addresses.phone': 1 });
customerRecordSchema.index({ tags: 1 });
customerRecordSchema.index({ archived: 1, updatedAt: -1 });

module.exports = mongoose.model('CustomerRecord', customerRecordSchema);
