/**
 * VendorInvoice - Tracks vendor invoices through the processing pipeline
 *
 * Status flow: received -> parsing -> parsed -> matching -> matched -> booked -> error/manual_review
 */

const mongoose = require('mongoose');

const lineItemSchema = new mongoose.Schema({
  description: String,
  sku: String,
  quantity: Number,
  unitPrice: Number,
  vatRate: Number,
  lineTotal: Number,
  matchedOdooPOLineId: Number, // Matched PO line in Odoo
}, { _id: false });

const matchedPOSchema = new mongoose.Schema({
  odooPoId: Number,
  poName: String,
  matchConfidence: Number, // 0-100
  matchedLines: [{
    invoiceLineIndex: Number,
    poLineId: Number,
    matchReason: String,
  }],
}, { _id: false });

const vendorInvoiceSchema = new mongoose.Schema({
  // Source tracking
  source: {
    type: { type: String, enum: ['email', 'manual', 'api'], default: 'email' },
    emailId: String,
    emailSubject: String,
    emailFrom: String,
    receivedAt: Date,
    attachmentName: String,
    attachmentSize: Number,
    attachmentContentType: String,
  },

  // Vendor information
  vendor: {
    name: { type: String, required: true },
    vatNumber: String,
    address: String,
    email: String,
    odooPartnerId: Number, // Matched Odoo partner
  },

  // Invoice details
  invoice: {
    number: { type: String, required: true, index: true },
    date: { type: Date, required: true },
    dueDate: Date,
    currency: { type: String, default: 'EUR' },
    poReference: String, // PO number if mentioned on invoice
    paymentTerms: String,
    bankAccount: String, // IBAN
  },

  // Line items
  lines: [lineItemSchema],

  // Totals
  totals: {
    subtotal: { type: Number, required: true },
    vatAmount: Number,
    vatRate: Number, // Single rate if uniform
    totalAmount: { type: Number, required: true },
  },

  // PO Matching results
  matching: {
    status: {
      type: String,
      enum: ['pending', 'matched', 'partial_match', 'unmatched', 'manual_review'],
      default: 'pending',
      index: true,
    },
    matchedPurchaseOrders: [matchedPOSchema],
    matchAttemptedAt: Date,
    matchNotes: String,
    autoMatchAllowed: { type: Boolean, default: true },
  },

  // Odoo booking status
  odoo: {
    billId: Number,
    billNumber: String,
    journalId: Number,
    createdAt: Date,
    postedAt: Date,
    syncError: String,
    lastSyncAttempt: Date,
  },

  // Overall processing status
  status: {
    type: String,
    enum: ['received', 'parsing', 'parsed', 'matching', 'matched', 'booking', 'booked', 'error', 'manual_review', 'rejected'],
    default: 'received',
    index: true,
  },

  // Processing history for audit trail
  processingHistory: [{
    action: String,
    timestamp: { type: Date, default: Date.now },
    details: mongoose.Schema.Types.Mixed,
    userId: String,
  }],

  // Errors encountered
  errors: [{
    stage: String, // 'parsing', 'matching', 'booking'
    message: String,
    code: String,
    timestamp: { type: Date, default: Date.now },
    retryCount: { type: Number, default: 0 },
  }],

  // Raw extraction data (for debugging)
  rawExtraction: mongoose.Schema.Types.Mixed,
  extractionConfidence: Number, // 0-1 confidence score

  // File storage
  attachmentStorageKey: String, // S3/blob storage key

  // Approval tracking
  approval: {
    required: { type: Boolean, default: false },
    reason: String,
    requestedAt: Date,
    approvedAt: Date,
    approvedBy: String,
    rejectedAt: Date,
    rejectedBy: String,
    rejectionReason: String,
  },

  // Metadata
  createdBy: String,
  updatedBy: String,
  tags: [String],
  notes: String,
}, {
  timestamps: true,
  collection: 'vendor_invoices',
});

// Compound indexes
vendorInvoiceSchema.index({ 'invoice.number': 1, 'vendor.vatNumber': 1 }, { unique: true, sparse: true });
vendorInvoiceSchema.index({ status: 1, 'matching.status': 1 });
vendorInvoiceSchema.index({ 'vendor.odooPartnerId': 1, 'invoice.date': -1 });
vendorInvoiceSchema.index({ 'odoo.billId': 1 }, { sparse: true });
vendorInvoiceSchema.index({ createdAt: -1 });
vendorInvoiceSchema.index({ 'source.emailId': 1 }, { sparse: true });

// Virtual for days until due
vendorInvoiceSchema.virtual('daysUntilDue').get(function() {
  if (!this.invoice.dueDate) return null;
  const now = new Date();
  const due = new Date(this.invoice.dueDate);
  return Math.ceil((due - now) / (1000 * 60 * 60 * 24));
});

// Virtual for aging bucket
vendorInvoiceSchema.virtual('agingBucket').get(function() {
  const days = this.daysUntilDue;
  if (days === null) return 'unknown';
  if (days >= 0) return 'current';
  if (days >= -30) return '1-30';
  if (days >= -60) return '31-60';
  if (days >= -90) return '61-90';
  return '90+';
});

// Methods
vendorInvoiceSchema.methods.addProcessingEvent = function(action, details, userId) {
  this.processingHistory.push({
    action,
    details,
    userId,
    timestamp: new Date(),
  });
};

vendorInvoiceSchema.methods.addError = function(stage, message, code) {
  const existingError = this.errors.find(e => e.stage === stage && e.message === message);
  if (existingError) {
    existingError.retryCount += 1;
    existingError.timestamp = new Date();
  } else {
    this.errors.push({ stage, message, code });
  }
};

// Static methods
vendorInvoiceSchema.statics.findPending = function(limit = 50) {
  return this.find({ status: { $in: ['received', 'parsed'] } })
    .sort({ createdAt: 1 })
    .limit(limit);
};

vendorInvoiceSchema.statics.findForManualReview = function(limit = 50) {
  return this.find({ status: 'manual_review' })
    .sort({ createdAt: -1 })
    .limit(limit);
};

vendorInvoiceSchema.statics.getMetrics = async function() {
  const pipeline = [
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$totals.totalAmount' },
      }
    }
  ];
  return this.aggregate(pipeline);
};

module.exports = mongoose.model('VendorInvoice', vendorInvoiceSchema);
