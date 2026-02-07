/**
 * InvoiceSyncSupplier - Per-supplier configuration for invoice sync
 *
 * Defines how to detect and process invoices from each supplier:
 * - Email matching patterns (sender/subject)
 * - Destination: 'portal' (s.distri-smart.com) or 'odoo' (SDT Odoo 14)
 * - Portal/Odoo-specific settings
 */

const mongoose = require('mongoose');

const invoiceSyncSupplierSchema = new mongoose.Schema({
  // Display name (e.g., "Maul", "Leitz-Acco")
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },

  // Enable/disable scanning for this supplier
  isActive: {
    type: Boolean,
    default: true,
  },

  // Email matching
  senderPattern: {
    type: String, // Regex for email From field
    default: '',
  },
  subjectPattern: {
    type: String, // Regex for email Subject field
    default: '',
  },
  matchMode: {
    type: String,
    enum: ['sender', 'subject', 'both', 'any'],
    default: 'sender',
  },

  // Where to submit the invoice
  destination: {
    type: String,
    enum: ['portal', 'odoo'],
    required: true,
    default: 'portal',
  },

  // Portal-specific settings (s.distri-smart.com)
  portalSupplierName: {
    type: String, // Name to search in supplier portal dropdown
    default: '',
  },

  // Odoo-specific settings (SDT Odoo 14)
  odooPartnerId: {
    type: Number, // Odoo vendor partner ID
    default: null,
  },
  odooExpenseAccountCode: {
    type: String,
    default: '6770',
  },

  // Auto-process or queue for review
  autoProcess: {
    type: Boolean,
    default: false,
  },

  // Stats
  lastScanAt: Date,
  totalInvoicesProcessed: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
  collection: 'invoice_sync_suppliers',
});

// Indexes
invoiceSyncSupplierSchema.index({ isActive: 1 });
invoiceSyncSupplierSchema.index({ destination: 1 });

module.exports = mongoose.model('InvoiceSyncSupplier', invoiceSyncSupplierSchema);
