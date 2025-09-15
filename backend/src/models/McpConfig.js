const mongoose = require('mongoose');

const mcpConfigSchema = new mongoose.Schema(
  {
    name: { type: String, default: 'default', unique: true },
    enabled_tools: [String],
  },
  { timestamps: true }
);

module.exports = mongoose.model('McpConfig', mcpConfigSchema);

