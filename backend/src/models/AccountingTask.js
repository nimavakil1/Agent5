/**
 * AccountingTask - Tracks accounting tasks and operations
 *
 * Used for tracking invoice processing, reconciliation, and reporting tasks
 */

const mongoose = require('mongoose');

const accountingTaskSchema = new mongoose.Schema({
  taskId: { type: String, required: true, unique: true, index: true },

  // Task type and status
  type: {
    type: String,
    enum: [
      'invoice_processing',
      'invoice_parsing',
      'invoice_matching',
      'invoice_booking',
      'payment_processing',
      'reconciliation',
      'report_generation',
      'email_scan',
      'sync_odoo',
    ],
    required: true,
    index: true,
  },

  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'awaiting_approval'],
    default: 'pending',
    index: true,
  },

  // Priority (1 = highest, 5 = lowest)
  priority: { type: Number, default: 3, min: 1, max: 5 },

  // Source information
  source: {
    type: { type: String, enum: ['email', 'manual', 'scheduled', 'api', 'agent'] },
    triggeredBy: String, // User ID or 'system'
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorInvoice' },
    emailId: String,
  },

  // Task input data
  input: mongoose.Schema.Types.Mixed,

  // Task output/result
  output: mongoose.Schema.Types.Mixed,

  // Error information
  error: {
    message: String,
    code: String,
    stack: String,
    occurredAt: Date,
    retryable: { type: Boolean, default: true },
  },

  // Retry tracking
  retries: {
    count: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 3 },
    lastRetryAt: Date,
    nextRetryAt: Date,
  },

  // Timing
  scheduledFor: Date,
  startedAt: Date,
  completedAt: Date,
  durationMs: Number,

  // Approval workflow
  approval: {
    required: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'approved', 'rejected'] },
    requestedAt: Date,
    respondedAt: Date,
    respondedBy: String,
    notes: String,
  },

  // Related entities
  relatedInvoices: [{ type: mongoose.Schema.Types.ObjectId, ref: 'VendorInvoice' }],
  relatedOdooIds: {
    invoiceIds: [Number],
    paymentIds: [Number],
    partnerIds: [Number],
    poIds: [Number],
  },

  // Agent tracking
  agent: {
    id: String,
    name: String,
    executionId: String,
  },

  // Progress tracking (for long-running tasks)
  progress: {
    current: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    message: String,
  },

  // Metadata
  metadata: mongoose.Schema.Types.Mixed,
  tags: [String],
}, {
  timestamps: true,
  collection: 'accounting_tasks',
});

// Indexes
accountingTaskSchema.index({ type: 1, status: 1 });
accountingTaskSchema.index({ 'source.invoiceId': 1 });
accountingTaskSchema.index({ scheduledFor: 1, status: 1 });
accountingTaskSchema.index({ createdAt: -1 });
accountingTaskSchema.index({ 'approval.status': 1, status: 1 });

// Methods
accountingTaskSchema.methods.start = function() {
  this.status = 'in_progress';
  this.startedAt = new Date();
  return this.save();
};

accountingTaskSchema.methods.complete = function(output) {
  this.status = 'completed';
  this.completedAt = new Date();
  this.output = output;
  if (this.startedAt) {
    this.durationMs = this.completedAt - this.startedAt;
  }
  return this.save();
};

accountingTaskSchema.methods.fail = function(error) {
  this.status = 'failed';
  this.completedAt = new Date();
  this.error = {
    message: error.message || String(error),
    code: error.code,
    stack: error.stack,
    occurredAt: new Date(),
    retryable: this.retries.count < this.retries.maxRetries,
  };
  if (this.startedAt) {
    this.durationMs = this.completedAt - this.startedAt;
  }
  return this.save();
};

accountingTaskSchema.methods.retry = function() {
  if (this.retries.count >= this.retries.maxRetries) {
    return Promise.reject(new Error('Max retries exceeded'));
  }

  this.retries.count += 1;
  this.retries.lastRetryAt = new Date();
  this.status = 'pending';
  this.error = null;
  this.startedAt = null;
  this.completedAt = null;

  return this.save();
};

accountingTaskSchema.methods.updateProgress = function(current, total, message) {
  this.progress = { current, total, message };
  return this.save();
};

// Statics
accountingTaskSchema.statics.createTask = async function(type, input, options = {}) {
  const { v4: uuidv4 } = require('uuid');

  const task = new this({
    taskId: options.taskId || uuidv4(),
    type,
    input,
    priority: options.priority || 3,
    source: options.source || { type: 'manual' },
    scheduledFor: options.scheduledFor,
    agent: options.agent,
    metadata: options.metadata,
    tags: options.tags,
  });

  return task.save();
};

accountingTaskSchema.statics.findPendingTasks = function(type, limit = 10) {
  const query = { status: 'pending' };
  if (type) query.type = type;

  return this.find(query)
    .sort({ priority: 1, createdAt: 1 })
    .limit(limit);
};

accountingTaskSchema.statics.findRetryableTasks = function(limit = 10) {
  return this.find({
    status: 'failed',
    'error.retryable': true,
    'retries.count': { $lt: { $ifNull: ['$retries.maxRetries', 3] } },
  })
    .sort({ createdAt: 1 })
    .limit(limit);
};

accountingTaskSchema.statics.getTaskStats = async function(since) {
  const match = {};
  if (since) {
    match.createdAt = { $gte: since };
  }

  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: { type: '$type', status: '$status' },
        count: { $sum: 1 },
        avgDuration: { $avg: '$durationMs' },
      }
    },
    {
      $group: {
        _id: '$_id.type',
        statuses: {
          $push: {
            status: '$_id.status',
            count: '$count',
            avgDuration: '$avgDuration',
          }
        },
        total: { $sum: '$count' },
      }
    }
  ]);
};

module.exports = mongoose.model('AccountingTask', accountingTaskSchema);
