
const mongoose = require('mongoose');

const errorObjectSchema = new mongoose.Schema({
  timestamp: { type: Date, required: true },
  error_code: { type: String, required: true },
  error_type: { type: String, enum: ['API', 'integration', 'language_detection', 'call', 'unknown'], required: true },
  description: { type: String, required: true },
  call_id: { type: String },
  campaign_id: { type: String },
});

module.exports = mongoose.model('ErrorObject', errorObjectSchema);
