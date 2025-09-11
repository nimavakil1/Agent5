
const mongoose = require('mongoose');

const deliveryAddressSchema = new mongoose.Schema(
  {
    code: { type: String }, // optional identifier
    name: { type: String },
    address: { type: String },
    city: { type: String },
    postal_code: { type: String },
    country: { type: String },
    email: { type: String },
    phone: { type: String },
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
      phone: { type: String },
      language: { type: String },
      language_confirmed: { type: Boolean, default: false },
      custom: { type: mongoose.Schema.Types.Mixed }, // dynamic fields (invoice scope)
    },
    delivery_addresses: [deliveryAddressSchema],
    tags: [{ type: String }],
    custom: { type: mongoose.Schema.Types.Mixed }, // dynamic fields (customer scope)
  },
  { timestamps: true }
);

module.exports = mongoose.model('CustomerRecord', customerRecordSchema);
