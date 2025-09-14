
const mongoose = require('mongoose');

const campaignDefinitionSchema = new mongoose.Schema(
  {
    // New schema (preferred)
    name: { type: String },
    description: { type: String },
    status: { type: String, enum: ['draft','scheduled','running','paused','ended'], default: 'draft', index: true },
    audience: {
      include_tags: [{ type: String }],
      exclude_tags: [{ type: String }],
      field_filters: [{ key: String, op: String, value: mongoose.Schema.Types.Mixed }],
      target: { type: String, enum: ['invoice','delivery'], default: 'invoice' },
    },
    schedule: {
      tz: { type: String },
      windows: [{ day: String, start: String, end: String }],
      start_at: { type: Date },
      end_at: { type: Date },
    },
    dialer: {
      max_attempts: { type: Number, default: 1 },
      cooldown_hours: { type: Number, default: 24 },
      daily_cap: { type: Number, default: 0 },
      hourly_cap: { type: Number, default: 0 },
    },
    script_profile: { type: String },
    notes: { type: String },
    orchestrator: {
      mcp_service: { type: String },
      default_agent_profile: { type: String },
      language_routes: [{ lang: String, agent_profile: String }],
    },

    // Backward-compatible legacy fields (optional)
    campaign_id: { type: String },
    title: { type: String },
    start_date: { type: Date },
    end_date: { type: Date },
    products: [String],
    custom_prompt: { type: String },
    promotional_logic: { type: mongoose.Schema.Types.Mixed },
    assigned_languages: [String],
    behavioral_traits: [String],
    pricing: { currency: String, amount: Number },
    tone: { type: String },
    target_groups: [String],
    channel: { type: String, enum: ['pstn','whatsapp'], default: 'pstn' },
    targeting: { type: mongoose.Schema.Types.Mixed },
    pacing: { type: mongoose.Schema.Types.Mixed },
    goal: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CampaignDefinition', campaignDefinitionSchema);
