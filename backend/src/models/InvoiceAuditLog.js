/**
 * InvoiceAuditLog - Audit trail for invoice processing actions
 *
 * Provides compliance-ready logging for all invoice operations
 */

const mongoose = require('mongoose');

const invoiceAuditLogSchema = new mongoose.Schema({
  // Reference to the invoice
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VendorInvoice',
    required: true,
    index: true
  },

  // Invoice number for quick reference (denormalized)
  invoiceNumber: String,
  vendorName: String,

  // Action performed
  action: {
    type: String,
    enum: [
      // Email/Reception
      'email_received',
      'email_attachment_downloaded',

      // Parsing
      'parsing_started',
      'parsing_completed',
      'parsing_failed',
      'data_extracted',

      // Matching
      'matching_started',
      'matching_completed',
      'matching_failed',
      'po_matched',
      'po_match_rejected',
      'vendor_matched',
      'vendor_created',

      // Approval
      'approval_requested',
      'approval_granted',
      'approval_denied',

      // Booking
      'booking_started',
      'booking_completed',
      'booking_failed',
      'odoo_bill_created',
      'odoo_bill_posted',

      // Reconciliation
      'payment_reconciled',
      'payment_unreconciled',

      // Manual actions
      'manual_review_assigned',
      'manual_edit',
      'manual_override',
      'rejected',
      'reprocessed',

      // Status changes
      'status_changed',
    ],
    required: true,
    index: true,
  },

  // When the action occurred
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },

  // Who performed the action
  actor: {
    type: { type: String, enum: ['user', 'system', 'agent', 'scheduler'] },
    id: String,      // User ID or agent ID
    name: String,    // Display name
    email: String,   // For users
  },

  // State transition
  previousState: String,
  newState: String,

  // Action details
  details: {
    // For parsing
    confidence: Number,
    fieldsExtracted: [String],

    // For matching
    matchConfidence: Number,
    matchedPoId: Number,
    matchedPoName: String,
    matchedVendorId: Number,

    // For booking
    odooInvoiceId: Number,
    odooInvoiceNumber: String,

    // For approval
    approvalReason: String,
    approvalNotes: String,

    // For errors
    errorMessage: String,
    errorCode: String,

    // For manual edits
    changedFields: [{
      field: String,
      oldValue: mongoose.Schema.Types.Mixed,
      newValue: mongoose.Schema.Types.Mixed,
    }],

    // Additional context
    metadata: mongoose.Schema.Types.Mixed,
  },

  // Request context (for API calls)
  request: {
    ip: String,
    userAgent: String,
    endpoint: String,
  },

  // Task reference
  taskId: String,

}, {
  timestamps: false, // We use our own timestamp
  collection: 'invoice_audit_logs',
});

// Indexes for querying
invoiceAuditLogSchema.index({ invoiceId: 1, timestamp: -1 });
invoiceAuditLogSchema.index({ action: 1, timestamp: -1 });
invoiceAuditLogSchema.index({ 'actor.id': 1, timestamp: -1 });
invoiceAuditLogSchema.index({ timestamp: -1 });

// Static method to log an action
invoiceAuditLogSchema.statics.log = async function(invoiceId, action, options = {}) {
  const log = new this({
    invoiceId,
    invoiceNumber: options.invoiceNumber,
    vendorName: options.vendorName,
    action,
    actor: options.actor || { type: 'system', name: 'System' },
    previousState: options.previousState,
    newState: options.newState,
    details: options.details || {},
    request: options.request,
    taskId: options.taskId,
  });

  return log.save();
};

// Get audit trail for an invoice
invoiceAuditLogSchema.statics.getAuditTrail = function(invoiceId, options = {}) {
  const query = { invoiceId };

  if (options.action) {
    query.action = options.action;
  }

  if (options.since) {
    query.timestamp = { $gte: options.since };
  }

  return this.find(query)
    .sort({ timestamp: -1 })
    .limit(options.limit || 100);
};

// Get activity summary for a time period
invoiceAuditLogSchema.statics.getActivitySummary = async function(since, until) {
  return this.aggregate([
    {
      $match: {
        timestamp: {
          $gte: since,
          $lte: until || new Date(),
        }
      }
    },
    {
      $group: {
        _id: {
          action: '$action',
          date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }
        },
        count: { $sum: 1 },
      }
    },
    {
      $group: {
        _id: '$_id.date',
        actions: {
          $push: {
            action: '$_id.action',
            count: '$count',
          }
        },
        total: { $sum: '$count' },
      }
    },
    { $sort: { _id: -1 } }
  ]);
};

// Get user activity
invoiceAuditLogSchema.statics.getUserActivity = async function(userId, since, limit = 50) {
  const query = { 'actor.id': userId };

  if (since) {
    query.timestamp = { $gte: since };
  }

  return this.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .populate('invoiceId', 'invoice.number vendor.name totals.totalAmount');
};

module.exports = mongoose.model('InvoiceAuditLog', invoiceAuditLogSchema);
