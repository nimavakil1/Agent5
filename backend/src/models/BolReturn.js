const mongoose = require('mongoose');

const bolReturnItemSchema = new mongoose.Schema({
  rmaId: { type: String, required: true },
  orderId: { type: String, index: true },
  orderItemId: { type: String },
  ean: { type: String, index: true },
  quantity: { type: Number, default: 1 },
  returnReason: { type: String },
  returnReasonDetail: { type: String },
  returnReasonComments: { type: String },
  handled: { type: Boolean, default: false },
  handlingResult: { type: String }
}, { _id: false });

const bolReturnSchema = new mongoose.Schema({
  returnId: { type: String, required: true, unique: true, index: true },
  registrationDateTime: { type: Date, required: true, index: true },
  fulfilmentMethod: { type: String, index: true },

  // Return status
  handled: { type: Boolean, default: false, index: true },

  // Return items
  returnItems: [bolReturnItemSchema],

  // Sync metadata
  syncedAt: { type: Date, default: Date.now, index: true },
  rawResponse: { type: mongoose.Schema.Types.Mixed }
}, {
  timestamps: true,
  collection: 'bol_returns'
});

// Index for common queries
bolReturnSchema.index({ registrationDateTime: -1, handled: 1 });

module.exports = mongoose.model('BolReturn', bolReturnSchema);
