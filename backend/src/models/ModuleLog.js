/**
 * ModuleLog - Centralized logging for all modules
 *
 * Stores logs for: Bol, Amazon Seller, Amazon Vendor, Odoo, Purchasing
 * Retention: 60 days (cleaned by scheduled job)
 */

const mongoose = require('mongoose');

const moduleLogSchema = new mongoose.Schema({
  // Module identification
  module: {
    type: String,
    required: true,
    enum: ['bol', 'amazon_seller', 'amazon_vendor', 'odoo', 'purchasing'],
    index: true
  },

  // Action details
  action: {
    type: String,
    required: true,
    index: true
  },

  // Status
  status: {
    type: String,
    required: true,
    enum: ['success', 'warning', 'error', 'info'],
    default: 'info'
  },

  // Human-readable summary
  summary: {
    type: String,
    required: true
  },

  // Detailed data (JSON)
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  // Duration in milliseconds
  duration: {
    type: Number,
    default: null
  },

  // Who/what triggered this action
  triggeredBy: {
    type: String,
    default: 'system',
    index: true
  },

  // Related entity IDs (for linking)
  relatedIds: {
    orderId: String,
    invoiceId: String,
    productId: String,
    ean: String,
    odooId: Number,
    custom: mongoose.Schema.Types.Mixed
  },

  // Error details (if status is error)
  error: {
    message: String,
    stack: String,
    code: String
  },

  // Timestamp (indexed for cleanup)
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: false, // We use our own timestamp field
  collection: 'module_logs'
});

// Compound indexes for common queries
moduleLogSchema.index({ module: 1, timestamp: -1 });
moduleLogSchema.index({ module: 1, status: 1, timestamp: -1 });
moduleLogSchema.index({ module: 1, action: 1, timestamp: -1 });

// TTL index for automatic cleanup after 60 days
moduleLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

// Static method to get logs with pagination
moduleLogSchema.statics.getLogs = async function(options = {}) {
  const {
    module,
    status,
    action,
    triggeredBy,
    startDate,
    endDate,
    limit = 50,
    offset = 0,
    sortOrder = -1 // -1 = newest first
  } = options;

  const query = {};

  if (module) query.module = module;
  if (status) query.status = status;
  if (action) query.action = action;
  if (triggeredBy) query.triggeredBy = triggeredBy;

  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }

  const [logs, total] = await Promise.all([
    this.find(query)
      .sort({ timestamp: sortOrder })
      .skip(offset)
      .limit(limit)
      .lean(),
    this.countDocuments(query)
  ]);

  return { logs, total, limit, offset };
};

// Static method to get summary statistics
moduleLogSchema.statics.getStats = async function(module, hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const stats = await this.aggregate([
    {
      $match: {
        module,
        timestamp: { $gte: since }
      }
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);

  const result = { success: 0, warning: 0, error: 0, info: 0, total: 0 };
  for (const s of stats) {
    result[s._id] = s.count;
    result.total += s.count;
  }

  return result;
};

// Create model
let ModuleLog;
try {
  ModuleLog = mongoose.model('ModuleLog');
} catch {
  ModuleLog = mongoose.model('ModuleLog', moduleLogSchema);
}

module.exports = ModuleLog;
