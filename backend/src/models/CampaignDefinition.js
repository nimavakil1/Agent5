
const mongoose = require('mongoose');

const campaignDefinitionSchema = new mongoose.Schema({
  campaign_id: { type: String, required: true },
  title: { type: String, required: true },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  products: [String],
  custom_prompt: { type: String },
  promotional_logic: { type: mongoose.Schema.Types.Mixed },
  assigned_languages: [String],
  behavioral_traits: [String],
  pricing: {
    currency: { type: String },
    amount: { type: Number },
  },
  tone: { type: String },
  target_groups: [String],
  // Orchestrator additions (optional)
  status: { type: String, enum: ['scheduled', 'active', 'paused', 'completed'], default: 'scheduled' },
  channel: { type: String, enum: ['pstn', 'whatsapp'], default: 'pstn' },
  targeting: { type: mongoose.Schema.Types.Mixed },
  pacing: { type: mongoose.Schema.Types.Mixed },
  goal: { type: mongoose.Schema.Types.Mixed },
});

module.exports = mongoose.model('CampaignDefinition', campaignDefinitionSchema);
