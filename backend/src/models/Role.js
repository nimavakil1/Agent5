const mongoose = require('mongoose');

// Available modules in the platform
const AVAILABLE_MODULES = [
  'ai-agents',
  'call-center',
  'amazon-seller',
  'amazon-vendor',
  'bol',
  'inventory',
  'accounting',
  'analytics',
  'settings'
];

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true },
    description: { type: String, default: '' },
    privileges: [{ type: String }],
    // Module access - array of module IDs this role can access
    // Empty array = no access (new users must be explicitly granted access)
    moduleAccess: [{ type: String, enum: AVAILABLE_MODULES }],
    protected: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Role', roleSchema);
module.exports.AVAILABLE_MODULES = AVAILABLE_MODULES;

