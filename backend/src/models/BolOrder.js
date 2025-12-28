const mongoose = require('mongoose');

const bolOrderItemSchema = new mongoose.Schema({
  orderItemId: { type: String, required: true },
  ean: { type: String, index: true },
  sku: { type: String },
  title: { type: String },
  quantity: { type: Number, default: 1 },
  quantityShipped: { type: Number, default: 0 },
  quantityCancelled: { type: Number, default: 0 },
  unitPrice: { type: Number },
  totalPrice: { type: Number },
  commission: { type: Number },
  fulfilmentMethod: { type: String }, // FBR or FBB
  fulfilmentStatus: { type: String },
  latestDeliveryDate: { type: Date },
  cancellationRequest: { type: Boolean, default: false }
}, { _id: false });

const bolOrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true, index: true },
  orderPlacedDateTime: { type: Date, required: true, index: true },

  // Shipping details
  shipmentMethod: { type: String },
  pickupPoint: { type: String },
  shipmentDetails: {
    salutation: String,
    firstName: String,
    surname: String,
    streetName: String,
    houseNumber: String,
    houseNumberExtension: String,
    zipCode: String,
    city: String,
    countryCode: String,
    email: String,
    deliveryPhoneNumber: String
  },

  // Billing details
  billingDetails: {
    salutation: String,
    firstName: String,
    surname: String,
    streetName: String,
    houseNumber: String,
    houseNumberExtension: String,
    zipCode: String,
    city: String,
    countryCode: String,
    email: String
  },

  // Order items
  orderItems: [bolOrderItemSchema],

  // Computed fields
  totalAmount: { type: Number },
  itemCount: { type: Number },
  fulfilmentMethod: { type: String, index: true }, // FBR or FBB (from first item)

  // Status tracking
  status: {
    type: String,
    enum: ['OPEN', 'SHIPPED', 'PARTIAL', 'CANCELLED'],
    default: 'OPEN',
    index: true
  },

  // Odoo integration
  odoo: {
    saleOrderId: { type: Number },
    saleOrderName: { type: String },
    invoiceId: { type: Number },
    invoiceName: { type: String },
    linkedAt: { type: Date },
    syncError: { type: String }
  },

  // Shipment confirmation to Bol.com
  shipmentConfirmedAt: { type: Date },
  shipmentReference: { type: String },
  trackingCode: { type: String },

  // Cancellation tracking
  cancelledAt: { type: Date },
  cancellationReason: { type: String },

  // Sync metadata
  syncedAt: { type: Date, default: Date.now, index: true },
  rawResponse: { type: mongoose.Schema.Types.Mixed } // Store raw API response
}, {
  timestamps: true,
  collection: 'bol_orders'
});

// Index for common queries
bolOrderSchema.index({ orderPlacedDateTime: -1, status: 1 });
bolOrderSchema.index({ fulfilmentMethod: 1, orderPlacedDateTime: -1 });
bolOrderSchema.index({ 'odoo.saleOrderId': 1 });

module.exports = mongoose.model('BolOrder', bolOrderSchema);
