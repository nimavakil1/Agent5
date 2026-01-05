/**
 * BolOrderTransformer - Transform Bol.com orders to unified format
 *
 * @module BolOrderTransformer
 */

const {
  CHANNELS,
  SUB_CHANNELS,
  UNIFIED_STATUS,
  STATUS_MAP
} = require('../UnifiedOrderService');

/**
 * Transform a bol_orders document to unified format
 * @param {Object} bolOrder - Document from bol_orders collection
 * @returns {Object} Unified order document
 */
function transformBolOrder(bolOrder) {
  const bolOrderId = bolOrder.orderId;
  const isFBB = bolOrder.fulfilmentMethod === 'FBB';
  const subChannel = isFBB ? SUB_CHANNELS.FBB : SUB_CHANNELS.FBR;

  // Generate unified order ID
  const unifiedOrderId = `${CHANNELS.BOL}:${bolOrderId}`;

  // Map status
  const sourceStatus = bolOrder.status;
  const unifiedStatus = STATUS_MAP[sourceStatus] || UNIFIED_STATUS.PENDING;

  // Calculate totals from items
  let subtotal = 0;
  const items = (bolOrder.orderItems || []).map(item => {
    const lineTotal = item.totalPrice || (item.unitPrice * item.quantity) || 0;
    subtotal += lineTotal;

    return {
      sku: item.sku || null,
      asin: null, // Not applicable for Bol.com
      ean: item.ean || null,
      name: item.title || '',
      quantity: item.quantity || 1,
      quantityShipped: item.quantityShipped || 0,
      quantityCancelled: item.quantityCancelled || 0,
      unitPrice: item.unitPrice || 0,
      lineTotal,
      tax: 0, // Tax not separated in Bol.com API
      orderItemId: item.orderItemId,
      fulfilmentMethod: item.fulfilmentMethod,
      latestDeliveryDate: item.latestDeliveryDate
    };
  });

  // Build shipping address from shipmentDetails
  const ship = bolOrder.shipmentDetails || {};
  const fullName = [ship.salutation, ship.firstName, ship.surname].filter(Boolean).join(' ');
  const street = [ship.streetName, ship.houseNumber, ship.houseNumberExtension].filter(Boolean).join(' ');

  const shippingAddress = {
    name: fullName || null,
    street: street || null,
    street2: null,
    city: ship.city || null,
    state: null,
    postalCode: ship.zipCode || null,
    countryCode: ship.countryCode || 'NL',
    phone: ship.deliveryPhoneNumber || null,
    pickupPoint: bolOrder.pickupPoint || null
  };

  // Build customer info
  const bill = bolOrder.billingDetails || {};
  const customerName = [bill.salutation, bill.firstName, bill.surname].filter(Boolean).join(' ');

  const customer = {
    name: customerName || fullName || null,
    email: bill.email || ship.email || null,
    odooPartnerId: bolOrder.odoo?.saleOrderId ? null : null, // Will be populated from Odoo sync
    odooPartnerName: null
  };

  // Marketplace is always NL/BE for Bol.com
  const marketplace = {
    code: 'NL',
    id: 'bol.com',
    name: 'Bol.com'
  };

  // Embedded Odoo data (always an object, never null, to allow dot-notation updates)
  const odoo = bolOrder.odoo ? {
    saleOrderId: bolOrder.odoo.saleOrderId || null,
    saleOrderName: bolOrder.odoo.saleOrderName || null,
    state: null,
    partnerId: null,
    partnerName: null,
    warehouseId: null,
    invoiceStatus: null,
    invoices: bolOrder.odoo.invoiceId ? [{
      id: bolOrder.odoo.invoiceId,
      name: bolOrder.odoo.invoiceName || null,
      date: null,
      amount: bolOrder.totalAmount || 0,
      state: null
    }] : [],
    pickings: [],
    syncedAt: bolOrder.odoo.linkedAt || null,
    syncError: bolOrder.odoo.syncError || null
  } : {};

  // Unified shipping deadline (for cross-channel queries)
  // FBR: Use earliest latestDeliveryDate from items
  // FBB: null (Bol handles fulfillment)
  let shippingDeadline = null;
  if (!isFBB) {
    const deadlines = items
      .map(item => item.latestDeliveryDate)
      .filter(Boolean)
      .map(d => new Date(d));
    if (deadlines.length > 0) {
      shippingDeadline = new Date(Math.min(...deadlines));
    }
  }

  // Bol.com specific fields
  const bol = {
    fulfilmentMethod: bolOrder.fulfilmentMethod,
    shipmentMethod: bolOrder.shipmentMethod,
    pickupPoint: bolOrder.pickupPoint,
    trackingCode: bolOrder.trackingCode || null,
    shipmentReference: bolOrder.shipmentReference || null,
    shipmentConfirmedAt: bolOrder.shipmentConfirmedAt || null,
    cancelledAt: bolOrder.cancelledAt || null,
    cancellationReason: bolOrder.cancellationReason || null,
    itemCount: bolOrder.itemCount || items.length
  };

  return {
    unifiedOrderId,

    // Source identifiers
    sourceIds: {
      amazonOrderId: null,
      amazonVendorPONumber: null,
      bolOrderId,
      odooSaleOrderId: bolOrder.odoo?.saleOrderId || null,
      odooSaleOrderName: bolOrder.odoo?.saleOrderName || null
    },

    // Channel discriminator
    channel: CHANNELS.BOL,
    subChannel,
    marketplace,

    // Unified fields
    orderDate: bolOrder.orderPlacedDateTime,
    lastUpdateDate: bolOrder.syncedAt || bolOrder.updatedAt,
    shippingDeadline, // Unified ship-by date (earliest item latestDeliveryDate)

    status: {
      unified: unifiedStatus,
      source: sourceStatus,
      odoo: null
    },

    customer,
    shippingAddress,

    totals: {
      subtotal,
      tax: 0,
      total: bolOrder.totalAmount || subtotal,
      currency: 'EUR'
    },

    items,

    // Embedded Odoo data
    odoo,

    // Channel-specific extensions
    amazonSeller: null,
    amazonVendor: null,
    bol,

    // Metadata
    importedAt: bolOrder.syncedAt,
    createdAt: bolOrder.createdAt || new Date(),
    updatedAt: bolOrder.updatedAt || new Date()
  };
}

/**
 * Transform a Bol.com API order response to unified format
 * @param {Object} bolApiOrder - Order from Bol.com API
 * @returns {Object} Unified order document
 */
function transformBolApiOrder(bolApiOrder) {
  const bolOrderId = bolApiOrder.orderId;

  // Determine fulfilment method
  const items = bolApiOrder.orderItems || [];
  const fulfilmentMethod = items.find(i => i.fulfilment?.method)?.fulfilment?.method ||
    items.find(i => i.fulfilmentMethod)?.fulfilmentMethod ||
    (bolApiOrder.shipmentDetails?.shipmentMethod === 'LVB' ? 'FBB' : 'FBR');

  const isFBB = fulfilmentMethod === 'FBB';
  const subChannel = isFBB ? SUB_CHANNELS.FBB : SUB_CHANNELS.FBR;

  const unifiedOrderId = `${CHANNELS.BOL}:${bolOrderId}`;

  // Calculate status
  const totalQty = items.reduce((sum, i) => sum + (i.quantity || 1), 0);
  const shippedQty = items.reduce((sum, i) => sum + (i.quantityShipped || 0), 0);
  const cancelledQty = items.reduce((sum, i) => sum + (i.quantityCancelled || 0), 0);

  let sourceStatus = 'OPEN';
  if (shippedQty >= totalQty) sourceStatus = 'SHIPPED';
  else if (shippedQty > 0) sourceStatus = 'PARTIAL';
  else if (cancelledQty >= totalQty) sourceStatus = 'CANCELLED';

  const unifiedStatus = STATUS_MAP[sourceStatus] || UNIFIED_STATUS.PENDING;

  // Transform items
  let subtotal = 0;
  const transformedItems = items.map(item => {
    const unitPrice = typeof item.unitPrice === 'object'
      ? parseFloat(item.unitPrice?.amount || 0)
      : parseFloat(item.unitPrice || 0);
    const totalPrice = typeof item.totalPrice === 'object'
      ? parseFloat(item.totalPrice?.amount || 0)
      : parseFloat(item.totalPrice || 0);

    const lineTotal = totalPrice || (unitPrice * (item.quantity || 1));
    subtotal += lineTotal;

    return {
      sku: item.offer?.reference || item.offerReference || null,
      asin: null,
      ean: item.product?.ean || item.ean || null,
      name: item.product?.title || '',
      quantity: item.quantity || 1,
      quantityShipped: item.quantityShipped || 0,
      quantityCancelled: item.quantityCancelled || 0,
      unitPrice,
      lineTotal,
      tax: 0,
      orderItemId: item.orderItemId,
      fulfilmentMethod: item.fulfilment?.method || item.fulfilmentMethod,
      latestDeliveryDate: item.fulfilment?.latestDeliveryDate || item.latestDeliveryDate
    };
  });

  // Shipping address
  const ship = bolApiOrder.shipmentDetails || {};
  const fullName = [ship.salutation, ship.firstName, ship.surname].filter(Boolean).join(' ');
  const street = [ship.streetName, ship.houseNumber, ship.houseNumberExtension].filter(Boolean).join(' ');

  const shippingAddress = {
    name: fullName || null,
    street: street || null,
    street2: null,
    city: ship.city || null,
    state: null,
    postalCode: ship.zipCode || null,
    countryCode: ship.countryCode || 'NL',
    phone: ship.deliveryPhoneNumber || null,
    pickupPoint: ship.pickupPointName || null
  };

  // Customer info from billing
  const bill = bolApiOrder.billingDetails || {};
  const customerName = [bill.salutation, bill.firstName, bill.surname].filter(Boolean).join(' ');

  // Unified shipping deadline (for cross-channel queries)
  // FBR: Use earliest latestDeliveryDate from items
  // FBB: null (Bol handles fulfillment)
  let shippingDeadline = null;
  if (!isFBB) {
    const deadlines = transformedItems
      .map(item => item.latestDeliveryDate)
      .filter(Boolean)
      .map(d => new Date(d));
    if (deadlines.length > 0) {
      shippingDeadline = new Date(Math.min(...deadlines));
    }
  }

  return {
    unifiedOrderId,

    sourceIds: {
      amazonOrderId: null,
      amazonVendorPONumber: null,
      bolOrderId,
      odooSaleOrderId: null,
      odooSaleOrderName: null
    },

    channel: CHANNELS.BOL,
    subChannel,
    marketplace: {
      code: 'NL',
      id: 'bol.com',
      name: 'Bol.com'
    },

    orderDate: new Date(bolApiOrder.orderPlacedDateTime),
    lastUpdateDate: new Date(),
    shippingDeadline, // Unified ship-by date (earliest item latestDeliveryDate)

    status: {
      unified: unifiedStatus,
      source: sourceStatus,
      odoo: null
    },

    customer: {
      name: customerName || fullName || null,
      email: bill.email || ship.email || null,
      odooPartnerId: null,
      odooPartnerName: null
    },

    shippingAddress,

    totals: {
      subtotal,
      tax: 0,
      total: subtotal,
      currency: 'EUR'
    },

    items: transformedItems,

    // Empty object (never null) to allow dot-notation updates
    odoo: {},

    amazonSeller: null,
    amazonVendor: null,
    bol: {
      fulfilmentMethod,
      shipmentMethod: ship.shipmentMethod || null,
      pickupPoint: ship.pickupPointName || null,
      trackingCode: null,
      shipmentReference: null,
      shipmentConfirmedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      itemCount: items.length
    },

    createdAt: new Date(),
    updatedAt: new Date()
  };
}

module.exports = {
  transformBolOrder,
  transformBolApiOrder
};
