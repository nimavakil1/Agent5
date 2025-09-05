
const mongoose = require('mongoose');

const customerRecordSchema = new mongoose.Schema({
  customer_id: { type: String, required: true },
  name: { type: String, required: true },
  phone_number: { type: String, required: true },
  preferred_language: { type: String },
  historical_offers: [String],
  previous_interactions: [
    {
      call_id: { type: String },
      date_time: { type: Date },
      outcome: { type: String },
    },
  ],
});

module.exports = mongoose.model('CustomerRecord', customerRecordSchema);
