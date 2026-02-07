/**
 * InvoiceSyncRecord - Individual invoice tracking through the sync pipeline
 *
 * Status flow: pending → parsed → submitted / failed / skipped
 */

const mongoose = require('mongoose');

const invoiceSyncRecordSchema = new mongoose.Schema({
  // Link to supplier config
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InvoiceSyncSupplier',
    required: true,
    index: true,
  },
  supplierName: {
    type: String, // Denormalized for quick display
    required: true,
  },

  // Gmail dedup key
  gmailMessageId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // Email metadata
  emailSubject: String,
  emailFrom: String,
  emailDate: Date,

  // PDF storage
  pdfFilepath: String, // Local path to saved PDF

  // Parsed invoice data
  invoiceNumber: {
    type: String,
    index: true,
  },
  invoiceDate: String,
  netAmount: Number,
  vatAmount: Number,
  grossAmount: Number,
  poNumbers: String, // Comma-separated PO numbers
  parsedDataJson: mongoose.Schema.Types.Mixed, // Full AI parse result

  // Processing status
  status: {
    type: String,
    enum: ['pending', 'parsed', 'submitted', 'failed', 'skipped'],
    default: 'pending',
    index: true,
  },

  // Destination used
  destination: {
    type: String,
    enum: ['portal', 'odoo'],
  },

  // Odoo-specific result
  odooBillId: {
    type: Number,
    default: null,
  },
  odooBillNumber: String,

  // Error tracking
  errorMessage: String,
  retryCount: {
    type: Number,
    default: 0,
  },

  // Processing history
  processingHistory: [{
    action: String,
    timestamp: { type: Date, default: Date.now },
    details: mongoose.Schema.Types.Mixed,
  }],
}, {
  timestamps: true,
  collection: 'invoice_sync_records',
});

// Compound indexes
invoiceSyncRecordSchema.index({ status: 1, supplier: 1 });
invoiceSyncRecordSchema.index({ createdAt: -1 });
invoiceSyncRecordSchema.index({ invoiceNumber: 1, supplierName: 1 });

// Methods
invoiceSyncRecordSchema.methods.addEvent = function(action, details) {
  this.processingHistory.push({ action, details, timestamp: new Date() });
};

// Statics
invoiceSyncRecordSchema.statics.getMetrics = async function() {
  return this.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalGross: { $sum: '$grossAmount' },
      },
    },
  ]);
};

module.exports = mongoose.model('InvoiceSyncRecord', invoiceSyncRecordSchema);
