/**
 * AccountingApproval - Tracks pending actions that require human approval
 *
 * When the Accounting Assistant wants to perform a write action (book invoice,
 * create payment, etc.), it creates an approval request. The user reviews
 * and approves/rejects via the UI.
 */

const mongoose = require('mongoose');

const accountingApprovalSchema = new mongoose.Schema({
  // Type of action requiring approval
  type: {
    type: String,
    enum: [
      'book_invoice',       // Book an invoice to Odoo
      'create_payment',     // Create a payment
      'reconcile',          // Reconcile payment with invoices
      'create_partner',     // Create new supplier/customer
      'update_partner',     // Update partner information
      'send_reminder',      // Send payment reminder
      'create_credit_note', // Create credit note
      'fx_payment',         // Foreign exchange payment (Ebury)
      'mollie_refund',      // Mollie refund
      'other',
    ],
    required: true,
    index: true,
  },

  // The proposed action with all details
  action: {
    // Human-readable description of what will happen
    description: {
      type: String,
      required: true,
    },

    // The actual operation to execute
    operation: {
      type: String,  // e.g., 'odoo.create', 'odoo.write', 'ebury.transfer'
      required: true,
    },

    // Parameters for the operation
    params: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },

    // Preview data (what the result would look like)
    preview: mongoose.Schema.Types.Mixed,

    // Related entities
    relatedInvoiceId: String,
    relatedPartnerId: Number,
    relatedOdooId: Number,
  },

  // Financial impact
  amount: {
    value: Number,
    currency: { type: String, default: 'EUR' },
  },

  // Why the agent is proposing this action
  reason: {
    type: String,
    required: true,
  },

  // Context from the conversation
  conversationContext: {
    userMessage: String,
    assistantReasoning: String,
    conversationId: String,
  },

  // Risk assessment
  risk: {
    level: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    factors: [String],  // e.g., ["high_amount", "new_supplier", "unusual_account"]
  },

  // Approval status
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'expired', 'executed', 'failed'],
    default: 'pending',
    index: true,
  },

  // Request metadata
  requestedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  requestedBy: {
    type: String,
    default: 'accounting_assistant',
  },

  // Approval/Rejection
  reviewedAt: Date,
  reviewedBy: String,
  reviewerNote: String,

  // Execution results
  executedAt: Date,
  executionResult: {
    success: Boolean,
    odooId: Number,        // Created/modified Odoo record ID
    odooReference: String, // e.g., invoice number
    error: String,
    details: mongoose.Schema.Types.Mixed,
  },

  // Expiration (approvals expire after X hours)
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    index: true,
  },

  // Tags for filtering
  tags: [String],

}, {
  timestamps: true,
  collection: 'accounting_approvals',
});

// Compound indexes
accountingApprovalSchema.index({ status: 1, requestedAt: -1 });
accountingApprovalSchema.index({ type: 1, status: 1 });
accountingApprovalSchema.index({ 'action.relatedPartnerId': 1 }, { sparse: true });

// Virtual for whether the approval is still actionable
accountingApprovalSchema.virtual('isActionable').get(function() {
  if (this.status !== 'pending') return false;
  if (this.expiresAt && new Date() > this.expiresAt) return false;
  return true;
});

// Method to approve
accountingApprovalSchema.methods.approve = async function(reviewedBy, note = '') {
  if (!this.isActionable) {
    throw new Error('Approval is no longer actionable');
  }

  this.status = 'approved';
  this.reviewedAt = new Date();
  this.reviewedBy = reviewedBy;
  this.reviewerNote = note;

  await this.save();
  return this;
};

// Method to reject
accountingApprovalSchema.methods.reject = async function(reviewedBy, note = '') {
  if (!this.isActionable) {
    throw new Error('Approval is no longer actionable');
  }

  this.status = 'rejected';
  this.reviewedAt = new Date();
  this.reviewedBy = reviewedBy;
  this.reviewerNote = note;

  await this.save();
  return this;
};

// Method to mark as executed
accountingApprovalSchema.methods.markExecuted = async function(result) {
  this.status = result.success ? 'executed' : 'failed';
  this.executedAt = new Date();
  this.executionResult = result;

  await this.save();
  return this;
};

// Static: Get pending approvals
accountingApprovalSchema.statics.getPending = function(type = null, limit = 50) {
  const query = {
    status: 'pending',
    expiresAt: { $gt: new Date() },
  };
  if (type) query.type = type;

  return this.find(query)
    .sort({ requestedAt: -1 })
    .limit(limit);
};

// Static: Get by status
accountingApprovalSchema.statics.getByStatus = function(status, limit = 50) {
  return this.find({ status })
    .sort({ requestedAt: -1 })
    .limit(limit);
};

// Static: Expire old approvals
accountingApprovalSchema.statics.expireOld = async function() {
  const result = await this.updateMany(
    {
      status: 'pending',
      expiresAt: { $lt: new Date() },
    },
    {
      $set: { status: 'expired' },
    }
  );
  return result.modifiedCount;
};

// Static: Get approval statistics
accountingApprovalSchema.statics.getStats = async function(daysBack = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  const pipeline = [
    { $match: { requestedAt: { $gte: cutoffDate } } },
    {
      $group: {
        _id: { type: '$type', status: '$status' },
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount.value' },
      }
    },
    {
      $group: {
        _id: '$_id.type',
        statuses: {
          $push: {
            status: '$_id.status',
            count: '$count',
            totalAmount: '$totalAmount',
          }
        },
        totalCount: { $sum: '$count' },
      }
    },
  ];

  return this.aggregate(pipeline);
};

// Pre-save: Auto-set risk level based on amount
accountingApprovalSchema.pre('save', function(next) {
  if (this.isNew && this.amount?.value) {
    const amount = this.amount.value;
    if (amount > 10000) {
      this.risk.level = 'high';
      this.risk.factors = this.risk.factors || [];
      if (!this.risk.factors.includes('high_amount')) {
        this.risk.factors.push('high_amount');
      }
    } else if (amount > 5000) {
      this.risk.level = 'medium';
    }
  }
  next();
});

module.exports = mongoose.model('AccountingApproval', accountingApprovalSchema);
