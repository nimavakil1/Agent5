const mongoose = require('mongoose');

const bolShipmentItemSchema = new mongoose.Schema({
  orderItemId: { type: String },
  orderId: { type: String, index: true },
  ean: { type: String },
  title: { type: String },
  sku: { type: String },
  quantity: { type: Number, default: 1 }
}, { _id: false });

const bolShipmentSchema = new mongoose.Schema({
  shipmentId: { type: String, required: true, unique: true, index: true },
  shipmentDateTime: { type: Date, required: true, index: true },
  shipmentReference: { type: String },

  // Order reference
  orderId: { type: String, index: true },

  // Transport details
  transport: {
    transportId: { type: String },
    transporterCode: { type: String, index: true },
    trackAndTrace: { type: String }
  },

  // Shipment items
  shipmentItems: [bolShipmentItemSchema],

  // Sync metadata
  syncedAt: { type: Date, default: Date.now, index: true },
  rawResponse: { type: mongoose.Schema.Types.Mixed }
}, {
  timestamps: true,
  collection: 'bol_shipments'
});

// Index for common queries
bolShipmentSchema.index({ shipmentDateTime: -1 });
bolShipmentSchema.index({ orderId: 1, shipmentDateTime: -1 });

module.exports = mongoose.model('BolShipment', bolShipmentSchema);
