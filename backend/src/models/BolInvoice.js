const mongoose = require('mongoose');

const bolInvoiceSchema = new mongoose.Schema({
  invoiceId: { type: String, required: true, unique: true, index: true },
  issueDate: { type: Date, index: true },
  periodStartDate: { type: Date },
  periodEndDate: { type: Date },
  invoiceType: { type: String },

  // Amounts
  totalAmountExclVat: { type: Number },
  totalAmountInclVat: { type: Number },
  currency: { type: String, default: 'EUR' },
  openAmount: { type: Number },

  // Available download formats
  availableFormats: {
    invoice: [{ type: String }],
    specification: [{ type: String }]
  },

  // Odoo integration
  odoo: {
    billId: { type: Number },
    billNumber: { type: String },
    createdAt: { type: Date },
    syncError: { type: String }
  },

  // Sync metadata
  syncedAt: { type: Date, default: Date.now, index: true },
  rawResponse: { type: mongoose.Schema.Types.Mixed }
}, {
  timestamps: true,
  collection: 'bol_invoices'
});

// Index for common queries
bolInvoiceSchema.index({ issueDate: -1 });

module.exports = mongoose.model('BolInvoice', bolInvoiceSchema);
