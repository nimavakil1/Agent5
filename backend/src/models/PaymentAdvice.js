/**
 * PaymentAdvice Model
 *
 * Represents payment advice/remittance notifications received from vendors or banks.
 * Used to reconcile payments with open vendor invoices.
 */

const mongoose = require('mongoose');

const paymentLineSchema = new mongoose.Schema({
  // Invoice reference from the payment advice
  invoiceReference: { type: String },
  invoiceDate: { type: Date },

  // Amounts
  invoiceAmount: { type: Number },
  paidAmount: { type: Number },
  discountAmount: { type: Number, default: 0 },
  withholdingAmount: { type: Number, default: 0 },

  // Matching
  matchedInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorInvoice' },
  matchedOdooBillId: { type: Number },
  matchConfidence: { type: Number }, // 0-100
  matchStatus: {
    type: String,
    enum: ['pending', 'matched', 'partial', 'unmatched', 'manual'],
    default: 'pending',
  },
  matchNotes: { type: String },
});

const paymentAdviceSchema = new mongoose.Schema({
  // Source information
  source: {
    type: { type: String, enum: ['email', 'upload', 'api', 'bank'], default: 'email' },
    emailId: { type: String, index: true },
    emailSubject: { type: String },
    emailFrom: { type: String },
    receivedAt: { type: Date },
    attachmentName: { type: String },
    bankStatementId: { type: String },
  },

  // Payer/Vendor information
  payer: {
    name: { type: String },
    vatNumber: { type: String },
    bankAccount: { type: String },
    odooPartnerId: { type: Number },
  },

  // Payment details
  payment: {
    reference: { type: String, index: true },
    date: { type: Date },
    valueDate: { type: Date },
    currency: { type: String, default: 'EUR' },
    totalAmount: { type: Number, required: true },
    bankReference: { type: String },
    paymentMethod: { type: String }, // wire, sepa, check, etc.
  },

  // Line items (individual invoice payments)
  lines: [paymentLineSchema],

  // Reconciliation summary
  reconciliation: {
    status: {
      type: String,
      enum: ['pending', 'partial', 'reconciled', 'over_payment', 'under_payment', 'error'],
      default: 'pending',
    },
    matchedAmount: { type: Number, default: 0 },
    unmatchedAmount: { type: Number, default: 0 },
    discrepancyAmount: { type: Number, default: 0 },
    reconciledAt: { type: Date },
    reconciledBy: { type: String },
    notes: { type: String },
  },

  // Odoo reference
  odoo: {
    paymentId: { type: Number },
    paymentName: { type: String },
    journalId: { type: Number },
    createdAt: { type: Date },
    reconciledInvoices: [{ type: Number }], // Odoo invoice IDs
    syncError: { type: String },
  },

  // Processing
  status: {
    type: String,
    enum: ['received', 'parsing', 'parsed', 'matching', 'matched', 'reconciling', 'reconciled', 'error'],
    default: 'received',
  },
  extractionConfidence: { type: Number },

  // Processing history
  processingHistory: [{
    event: { type: String },
    timestamp: { type: Date, default: Date.now },
    data: { type: mongoose.Schema.Types.Mixed },
  }],

  // Errors
  errors: [{
    stage: { type: String },
    message: { type: String },
    timestamp: { type: Date, default: Date.now },
    retryCount: { type: Number, default: 0 },
  }],
}, {
  timestamps: true,
});

// Indexes
paymentAdviceSchema.index({ 'payment.reference': 1 });
paymentAdviceSchema.index({ 'payment.date': -1 });
paymentAdviceSchema.index({ 'payer.odooPartnerId': 1 });
paymentAdviceSchema.index({ status: 1 });
paymentAdviceSchema.index({ 'reconciliation.status': 1 });

// Methods
paymentAdviceSchema.methods.addProcessingEvent = function(event, data = {}) {
  this.processingHistory.push({ event, data, timestamp: new Date() });
};

paymentAdviceSchema.methods.addError = function(stage, message) {
  const existing = this.errors.find(e => e.stage === stage);
  if (existing) {
    existing.message = message;
    existing.timestamp = new Date();
    existing.retryCount += 1;
  } else {
    this.errors.push({ stage, message, timestamp: new Date(), retryCount: 0 });
  }
};

paymentAdviceSchema.methods.calculateReconciliationSummary = function() {
  let matchedAmount = 0;
  let unmatchedAmount = 0;

  for (const line of this.lines) {
    if (line.matchStatus === 'matched') {
      matchedAmount += line.paidAmount || 0;
    } else {
      unmatchedAmount += line.paidAmount || 0;
    }
  }

  const discrepancy = this.payment.totalAmount - matchedAmount - unmatchedAmount;

  this.reconciliation.matchedAmount = matchedAmount;
  this.reconciliation.unmatchedAmount = unmatchedAmount;
  this.reconciliation.discrepancyAmount = Math.abs(discrepancy) < 0.01 ? 0 : discrepancy;

  // Determine status
  if (unmatchedAmount === 0 && Math.abs(discrepancy) < 0.01) {
    this.reconciliation.status = 'reconciled';
  } else if (matchedAmount > 0 && unmatchedAmount > 0) {
    this.reconciliation.status = 'partial';
  } else if (discrepancy > 0.01) {
    this.reconciliation.status = 'under_payment';
  } else if (discrepancy < -0.01) {
    this.reconciliation.status = 'over_payment';
  }
};

// Statics
paymentAdviceSchema.statics.findPendingReconciliation = function() {
  return this.find({
    status: { $in: ['parsed', 'matching', 'matched'] },
    'reconciliation.status': { $in: ['pending', 'partial'] },
  }).sort({ 'payment.date': -1 });
};

paymentAdviceSchema.statics.findByVendor = function(odooPartnerId) {
  return this.find({ 'payer.odooPartnerId': odooPartnerId })
    .sort({ 'payment.date': -1 });
};

module.exports = mongoose.model('PaymentAdvice', paymentAdviceSchema);
