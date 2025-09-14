
const mongoose = require('mongoose');

const callLogEntrySchema = new mongoose.Schema({
  call_id: { type: String, required: true },
  telnyx_call_id: { type: String },
  customer_id: { type: String, required: true },
  campaign_id: { type: String, required: true },
  start_time: { type: Date, required: true },
  end_time: { type: Date, required: true },
  language_detected: { type: String, required: true },
  fallback_language: { type: String },
  sentiment_scores: [{ timestamp: Date, sentiment: String, score: Number }],
  call_status: { type: String, enum: ['success', 'failed', 'dropped', 'no_answer'], required: true },
  transcription: { type: String },
  audio_recording_url: { type: String },
  offers_recommended: [String],
  shopify_cart_link: { type: String },
  cost_tracking_id: { type: String }, // Reference to CallCostTracking
  onedrive_recording_url: { type: String }, // Direct OneDrive shareable link
  transcription_summary: { type: String }, // Key conversation points
  intents: [String],
});

module.exports = mongoose.model('CallLogEntry', callLogEntrySchema);
