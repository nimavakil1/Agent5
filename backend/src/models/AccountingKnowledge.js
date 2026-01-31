/**
 * AccountingKnowledge - Persistent memory for the Accounting Assistant
 *
 * This model stores learned facts, rules, preferences, and corrections
 * that the agent should remember across sessions. The agent can be "trained"
 * by users telling it things like "Remember that supplier X always gets 30-day terms".
 *
 * Knowledge is retrieved via semantic search (embeddings) during conversations.
 */

const mongoose = require('mongoose');

const accountingKnowledgeSchema = new mongoose.Schema({
  // Category of knowledge
  category: {
    type: String,
    enum: [
      'supplier_fact',      // Facts about specific suppliers (payment terms, discounts, contacts)
      'customer_fact',      // Facts about specific customers
      'accounting_rule',    // Accounting rules and procedures
      'tax_rule',           // Tax rules (VAT, OSS, cross-border)
      'account_mapping',    // Default account codes for expense types
      'preference',         // User preferences for how to handle things
      'correction',         // Corrections ("when I say X, I mean Y")
      'procedure',          // Business procedures
      'peppol',             // PEPPOL-specific knowledge
      'warehouse',          // Warehouse and inventory locations (for tax purposes)
      'country_vat',        // Country-specific VAT rules
      'general',            // General knowledge
    ],
    required: true,
    index: true,
  },

  // What this knowledge is about (e.g., supplier name, account type)
  subject: {
    type: String,
    required: true,
    index: true,
  },

  // The actual knowledge/fact
  fact: {
    type: String,
    required: true,
  },

  // Structured data for programmatic access (optional)
  // e.g., { discountPercent: 2, discountDays: 10 } for early payment discounts
  structuredData: {
    type: mongoose.Schema.Types.Mixed,
  },

  // Related Odoo IDs for quick lookup
  relatedOdooIds: {
    partnerId: Number,      // res.partner ID
    accountId: Number,      // account.account ID
    productId: Number,      // product.product ID
    taxId: Number,          // account.tax ID
    warehouseId: Number,    // stock.warehouse ID
  },

  // Tags for additional categorization
  tags: [{
    type: String,
    index: true,
  }],

  // Priority for conflicting rules (higher = more important)
  priority: {
    type: Number,
    default: 0,
  },

  // How this knowledge was acquired
  source: {
    type: {
      type: String,
      enum: ['user_training', 'system_default', 'imported', 'learned', 'peppol_spec'],
      default: 'user_training',
    },
    userId: String,
    timestamp: { type: Date, default: Date.now },
    context: String,  // Original conversation context if applicable
  },

  // Vector embedding for semantic search
  embedding: {
    type: [Number],
    index: false,  // We'll use a separate vector index
  },

  // Combined text used for embedding generation
  embeddingText: {
    type: String,
  },

  // Validity period (some rules may be time-bound)
  validFrom: {
    type: Date,
  },
  validUntil: {
    type: Date,
  },

  // Whether this knowledge is currently active
  active: {
    type: Boolean,
    default: true,
    index: true,
  },

  // Audit trail
  createdBy: {
    type: String,
    required: true,
  },
  updatedBy: String,

  // Usage tracking
  usageCount: {
    type: Number,
    default: 0,
  },
  lastUsedAt: Date,

}, {
  timestamps: true,
  collection: 'accounting_knowledge',
});

// Compound indexes
accountingKnowledgeSchema.index({ category: 1, subject: 1 });
accountingKnowledgeSchema.index({ active: 1, category: 1 });
accountingKnowledgeSchema.index({ tags: 1, active: 1 });
accountingKnowledgeSchema.index({ 'relatedOdooIds.partnerId': 1 }, { sparse: true });

// Text index for basic text search (fallback when embeddings not available)
accountingKnowledgeSchema.index({
  subject: 'text',
  fact: 'text',
  tags: 'text'
}, {
  weights: {
    subject: 10,
    fact: 5,
    tags: 3,
  },
  name: 'knowledge_text_search',
});

// Virtual for combined searchable text
accountingKnowledgeSchema.virtual('searchText').get(function() {
  return `${this.category}: ${this.subject} - ${this.fact}`;
});

// Method to increment usage
accountingKnowledgeSchema.methods.recordUsage = async function() {
  this.usageCount += 1;
  this.lastUsedAt = new Date();
  await this.save();
};

// Method to check if knowledge is currently valid
accountingKnowledgeSchema.methods.isValid = function() {
  if (!this.active) return false;
  const now = new Date();
  if (this.validFrom && now < this.validFrom) return false;
  if (this.validUntil && now > this.validUntil) return false;
  return true;
};

// Static: Find knowledge by category
accountingKnowledgeSchema.statics.findByCategory = function(category, limit = 50) {
  return this.find({ category, active: true })
    .sort({ priority: -1, usageCount: -1 })
    .limit(limit);
};

// Static: Find knowledge about a subject
accountingKnowledgeSchema.statics.findBySubject = function(subject, category = null) {
  const query = {
    subject: { $regex: subject, $options: 'i' },
    active: true,
  };
  if (category) query.category = category;
  return this.find(query).sort({ priority: -1 });
};

// Static: Find by Odoo partner ID
accountingKnowledgeSchema.statics.findByPartnerId = function(partnerId) {
  return this.find({
    'relatedOdooIds.partnerId': partnerId,
    active: true,
  }).sort({ priority: -1 });
};

// Static: Text search (fallback)
accountingKnowledgeSchema.statics.textSearch = function(query, limit = 20) {
  return this.find(
    { $text: { $search: query }, active: true },
    { score: { $meta: 'textScore' } }
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit);
};

// Static: Get all tax rules
accountingKnowledgeSchema.statics.getTaxRules = function() {
  return this.find({
    category: { $in: ['tax_rule', 'country_vat'] },
    active: true,
  }).sort({ priority: -1 });
};

// Static: Get supplier knowledge
accountingKnowledgeSchema.statics.getSupplierKnowledge = function(supplierName) {
  return this.find({
    category: 'supplier_fact',
    subject: { $regex: supplierName, $options: 'i' },
    active: true,
  });
};

// Pre-save: Generate embedding text
accountingKnowledgeSchema.pre('save', function(next) {
  if (this.isModified('subject') || this.isModified('fact') || this.isModified('category')) {
    this.embeddingText = `${this.category}: ${this.subject}. ${this.fact}`;
  }
  next();
});

module.exports = mongoose.model('AccountingKnowledge', accountingKnowledgeSchema);
