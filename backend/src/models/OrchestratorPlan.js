const mongoose = require('mongoose');

const orchestratorPlanSchema = new mongoose.Schema(
  {
    instruction: { type: String, required: true },
    plan: { type: mongoose.Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['draft', 'scheduled', 'active', 'completed', 'cancelled', 'failed'], default: 'scheduled' },
    campaign_id: { type: String },
    notes: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('OrchestratorPlan', orchestratorPlanSchema);

