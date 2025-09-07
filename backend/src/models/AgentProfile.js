const mongoose = require('mongoose');

const agentProfileSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    voice: { type: String, default: '' },
    instructions: { type: String, default: '' },
    language: { type: String, default: '' },
    updatedBy: { type: String, default: 'system' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AgentProfile', agentProfileSchema);
