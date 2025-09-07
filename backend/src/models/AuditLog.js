const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  user_email: { type: String, required: true },
  action: { type: String, required: true },
  resource: { type: String, required: true },
  resource_id: { type: String },
  details: { type: mongoose.Schema.Types.Mixed },
  ip_address: { type: String },
  user_agent: { type: String },
  timestamp: { type: Date, default: Date.now },
  success: { type: Boolean, default: true }
}, { 
  timestamps: true,
  collection: 'audit_logs'
});

// Index for efficient querying
auditLogSchema.index({ user_id: 1, timestamp: -1 });
auditLogSchema.index({ resource: 1, timestamp: -1 });
auditLogSchema.index({ timestamp: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);