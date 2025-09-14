const mongoose = require('mongoose');

const agentProfileSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['call','chat','worker'], default: 'call' },
    voice: { type: String, default: '' },
    instructions: { type: String, default: '' },
    language: { type: String, default: '' },
    mcp_service: { type: String, default: '' }, // optional MCP service id/URL to use for this agent
    updatedBy: { type: String, default: 'system' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AgentProfile', agentProfileSchema);
