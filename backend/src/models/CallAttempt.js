const mongoose = require('mongoose');

const callAttemptSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignDefinition', index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerRecord', index: true },
    target: { type: String, enum: ['invoice', 'delivery'], default: 'invoice' },
    deliveryCode: { type: String },
    phone_e164: { type: String, index: true },
    attemptNo: { type: Number, default: 1 },
    startedAt: { type: Date },
    endedAt: { type: Date },
    disposition: { type: String },
    recording_url: { type: String },
    transcript: { type: String },
    cost_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CallCostTracking' },
    error: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CallAttempt', callAttemptSchema);

