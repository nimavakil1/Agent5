const mongoose = require('mongoose');

const agentSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    voice: { type: String, default: '' },
    instructions: { type: String, default: '' },
    updatedBy: { type: String, default: 'system' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AgentSettings', agentSettingsSchema);

