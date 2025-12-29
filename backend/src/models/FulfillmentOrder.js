/**
 * FulfillmentOrder - Unified order model for CW Fulfillment
 *
 * Syncs orders from Odoo and provides a unified view across all channels:
 * - Bol.com
 * - Amazon Vendor
 * - Amazon Seller
 * - Direct sales
 *
 * Supports snooze functionality to temporarily hide orders from the fulfillment queue.
 */

const mongoose = require('mongoose');

const fulfillmentItemSchema = new mongoose.Schema({
  productId: { type: Number }, // Odoo product ID
  sku: { type: String },
  ean: { type: String },
  name: { type: String, required: true },
  quantity: { type: Number, required: true, default: 1 },
  quantityDelivered: { type: Number, default: 0 },
  unitPrice: { type: Number },
  totalPrice: { type: Number },
  weight: { type: Number }, // in kg
  location: { type: String } // Warehouse location/bin
}, { _id: false });

const fulfillmentOrderSchema = new mongoose.Schema({
  // === Source Information ===
  channel: {
    type: String,
    required: true,
    enum: ['bol', 'amazon_vendor', 'amazon_seller', 'shopify', 'direct', 'other'],
    index: true
  },
  channelOrderId: { type: String, required: true }, // Original order ID from channel
  channelOrderRef: { type: String }, // Human-readable reference (e.g., PO number)
  marketplace: { type: String, index: true }, // DE, FR, NL, BE, etc.

  // === Odoo Link ===
  odoo: {
    saleOrderId: { type: Number, required: true, index: true },
    saleOrderName: { type: String, required: true }, // e.g., "S00123"
    pickingId: { type: Number }, // stock.picking ID
    pickingName: { type: String }, // e.g., "WH/OUT/00123"
    partnerId: { type: Number },
    partnerName: { type: String },
    warehouseId: { type: Number },
    warehouseName: { type: String },
    syncedAt: { type: Date, default: Date.now }
  },

  // === Order Details ===
  orderDate: { type: Date, required: true, index: true },
  promisedDeliveryDate: { type: Date, index: true },
  latestShipDate: { type: Date, index: true },

  // Customer/Shipping
  customer: {
    name: { type: String },
    email: { type: String },
    phone: { type: String },
    company: { type: String }
  },
  shippingAddress: {
    name: { type: String },
    street: { type: String },
    street2: { type: String },
    city: { type: String },
    zip: { type: String },
    state: { type: String },
    country: { type: String }, // Country code (BE, NL, DE, etc.)
    countryName: { type: String }
  },

  // Items
  items: [fulfillmentItemSchema],
  itemCount: { type: Number, default: 0 },

  // Totals
  totalAmount: { type: Number },
  currency: { type: String, default: 'EUR' },
  totalWeight: { type: Number }, // in kg

  // Carrier
  carrier: {
    code: { type: String }, // GLS, POSTNL, DPD, etc.
    name: { type: String },
    service: { type: String }
  },

  // === Status ===
  status: {
    type: String,
    enum: [
      'pending',      // Waiting in Odoo, not ready
      'ready',        // Ready to ship (stock confirmed)
      'processing',   // Being picked/packed
      'shipped',      // Shipped with tracking
      'delivered',    // Confirmed delivered
      'cancelled',    // Order cancelled
      'on_hold'       // On hold (issue with order)
    ],
    default: 'pending',
    index: true
  },

  // Stock availability
  stockStatus: {
    type: String,
    enum: ['available', 'partial', 'unavailable', 'unknown'],
    default: 'unknown'
  },

  // === Snooze Functionality ===
  snooze: {
    isSnoozed: { type: Boolean, default: false, index: true },
    snoozedAt: { type: Date },
    snoozedBy: { type: String }, // User who snoozed
    snoozedUntil: { type: Date, index: true }, // null = indefinite
    reason: { type: String },
    autoUnsnooze: { type: Boolean, default: true } // Auto-unsnooze when date reached
  },

  // === Shipping ===
  shipment: {
    trackingNumber: { type: String },
    trackingUrl: { type: String },
    carrier: { type: String },
    labelPrinted: { type: Boolean, default: false },
    labelPrintedAt: { type: Date },
    shippedAt: { type: Date },
    deliveredAt: { type: Date }
  },

  // === Priority & Flags ===
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal',
    index: true
  },
  flags: [{
    type: { type: String }, // 'late', 'vip', 'fragile', 'oversized', etc.
    message: { type: String },
    addedAt: { type: Date, default: Date.now }
  }],

  // === Notes ===
  notes: { type: String },
  internalNotes: { type: String },

  // === Metadata ===
  lastSyncedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  collection: 'fulfillment_orders'
});

// Compound indexes for common queries
fulfillmentOrderSchema.index({ status: 1, 'snooze.isSnoozed': 1, orderDate: -1 });
fulfillmentOrderSchema.index({ channel: 1, status: 1, orderDate: -1 });
fulfillmentOrderSchema.index({ 'snooze.isSnoozed': 1, 'snooze.snoozedUntil': 1 });
fulfillmentOrderSchema.index({ 'odoo.saleOrderId': 1 }, { unique: true });
fulfillmentOrderSchema.index({ channelOrderId: 1, channel: 1 }, { unique: true });

// Virtual for checking if order is late
fulfillmentOrderSchema.virtual('isLate').get(function() {
  if (!this.latestShipDate) return false;
  return new Date() > this.latestShipDate && this.status !== 'shipped' && this.status !== 'delivered';
});

// Virtual for checking if snooze has expired
fulfillmentOrderSchema.virtual('snoozeExpired').get(function() {
  if (!this.snooze?.isSnoozed) return false;
  if (!this.snooze.snoozedUntil) return false; // Indefinite snooze
  return new Date() > this.snooze.snoozedUntil;
});

// Static: Find orders ready to fulfill (not snoozed, ready status)
fulfillmentOrderSchema.statics.findReadyToFulfill = function(options = {}) {
  const query = {
    status: { $in: ['ready', 'processing'] },
    $or: [
      { 'snooze.isSnoozed': false },
      { 'snooze.isSnoozed': { $exists: false } },
      // Include orders whose snooze has expired
      { 'snooze.isSnoozed': true, 'snooze.snoozedUntil': { $lt: new Date() }, 'snooze.autoUnsnooze': true }
    ]
  };

  if (options.channel) {
    query.channel = options.channel;
  }
  if (options.marketplace) {
    query.marketplace = options.marketplace;
  }

  return this.find(query)
    .sort({ priority: -1, latestShipDate: 1, orderDate: 1 })
    .limit(options.limit || 100);
};

// Static: Find snoozed orders
fulfillmentOrderSchema.statics.findSnoozed = function(options = {}) {
  const query = {
    'snooze.isSnoozed': true,
    $or: [
      { 'snooze.snoozedUntil': null }, // Indefinite
      { 'snooze.snoozedUntil': { $gte: new Date() } }, // Not yet expired
      { 'snooze.autoUnsnooze': false } // Manual unsnooze only
    ]
  };

  return this.find(query)
    .sort({ 'snooze.snoozedUntil': 1, orderDate: 1 })
    .limit(options.limit || 100);
};

// Static: Auto-unsnooze expired orders
fulfillmentOrderSchema.statics.unsnoozeExpired = async function() {
  const result = await this.updateMany(
    {
      'snooze.isSnoozed': true,
      'snooze.autoUnsnooze': true,
      'snooze.snoozedUntil': { $lt: new Date(), $ne: null }
    },
    {
      $set: {
        'snooze.isSnoozed': false,
        updatedAt: new Date()
      }
    }
  );
  return result.modifiedCount;
};

// Instance method: Snooze order
fulfillmentOrderSchema.methods.snoozeOrder = function(options = {}) {
  this.snooze = {
    isSnoozed: true,
    snoozedAt: new Date(),
    snoozedBy: options.userId || 'system',
    snoozedUntil: options.until || null, // null = indefinite
    reason: options.reason || '',
    autoUnsnooze: options.autoUnsnooze !== false
  };
  this.updatedAt = new Date();
  return this.save();
};

// Instance method: Unsnooze order
fulfillmentOrderSchema.methods.unsnoozeOrder = function() {
  this.snooze.isSnoozed = false;
  this.updatedAt = new Date();
  return this.save();
};

module.exports = mongoose.model('FulfillmentOrder', fulfillmentOrderSchema);
