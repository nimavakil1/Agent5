/**
 * VendorOrderTransformer - Transform Amazon Vendor purchase orders to unified format
 *
 * @module VendorOrderTransformer
 */

const {
  CHANNELS,
  SUB_CHANNELS,
  UNIFIED_STATUS,
  STATUS_MAP
} = require('../UnifiedOrderService');

/**
 * Transform a vendor_purchase_orders document to unified format
 * @param {Object} vendorPO - Document from vendor_purchase_orders collection
 * @returns {Object} Unified order document
 */
function transformVendorOrder(vendorPO) {
  const poNumber = vendorPO.purchaseOrderNumber;
  const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

  // Map status
  const sourceStatus = vendorPO.purchaseOrderState;
  const unifiedStatus = STATUS_MAP[sourceStatus] || UNIFIED_STATUS.PENDING;

  // Calculate totals from items
  let subtotal = 0;
  let taxTotal = 0;
  const currency = 'EUR'; // Vendor Central uses EUR for EU

  const items = (vendorPO.items || []).map(item => {
    const unitCost = parseFloat(item.netCost?.amount) || 0;
    const qty = parseInt(item.orderedQuantity?.amount) || 0;
    const lineTotal = unitCost * qty;
    subtotal += lineTotal;

    return {
      sku: item.odoo?.sku || item.vendorProductIdentifier || null,
      asin: item.amazonProductIdentifier,
      ean: item.vendorProductIdentifier || null,
      name: item.odoo?.name || item.title || `ASIN: ${item.amazonProductIdentifier}`,
      quantity: qty,
      quantityShipped: 0, // Vendor orders don't track this the same way
      unitPrice: unitCost,
      lineTotal,
      tax: 0, // Tax calculated on invoice
      backordered: item.backordered || false,
      odooProductId: item.odoo?.productId || null
    };
  });

  // Build shipping address from shipToParty
  const shipTo = vendorPO.shipToParty || {};
  const shipAddr = shipTo.address || {};
  const shippingAddress = {
    name: shipAddr.name || null,
    street: shipAddr.addressLine1 || null,
    street2: shipAddr.addressLine2 || null,
    city: shipAddr.city || null,
    state: shipAddr.stateOrRegion || null,
    postalCode: shipAddr.postalCode || null,
    countryCode: shipAddr.countryCode || null,
    phone: null,
    warehouseCode: shipTo.partyId || null
  };

  // Customer is Amazon (Vendor Central = B2B)
  const customer = {
    name: 'Amazon Vendor Central',
    email: null,
    odooPartnerId: null, // Will be mapped to Amazon partner
    odooPartnerName: null,
    amazonPartyId: vendorPO.buyingParty?.partyId || null
  };

  // Marketplace
  const marketplace = {
    code: vendorPO.marketplaceId || 'DE',
    id: vendorPO.amazonMarketplaceId,
    name: `Amazon.${(vendorPO.marketplaceId || 'DE').toLowerCase()} (Vendor)`
  };

  // Embedded Odoo data
  const odoo = vendorPO.odoo ? {
    saleOrderId: vendorPO.odoo.saleOrderId || null,
    saleOrderName: vendorPO.odoo.saleOrderName || null,
    state: null,
    partnerId: null,
    partnerName: null,
    warehouseId: null,
    invoiceStatus: null,
    invoices: (vendorPO.invoices || []).map(inv => ({
      id: inv.odooInvoiceId || null,
      name: inv.odooInvoiceName || null,
      date: inv.invoiceDate || null,
      amount: inv.invoiceTotal || 0,
      state: inv.status || null,
      amazonTransactionId: inv.transactionId || null
    })),
    pickings: [],
    syncedAt: null,
    syncError: null
  } : null;

  // Vendor specific fields
  const amazonVendor = {
    purchaseOrderState: vendorPO.purchaseOrderState,
    purchaseOrderType: vendorPO.purchaseOrderType,
    deliveryWindow: vendorPO.deliveryWindow,
    buyingParty: vendorPO.buyingParty,
    sellingParty: vendorPO.sellingParty,
    shipToParty: vendorPO.shipToParty,
    billToParty: vendorPO.billToParty,
    acknowledgment: vendorPO.acknowledgment || {
      acknowledged: false,
      acknowledgedAt: null,
      status: null
    },
    shipmentStatus: vendorPO.shipmentStatus || 'not_shipped',
    shipments: vendorPO.shipments || []
  };

  return {
    unifiedOrderId,

    // Source identifiers
    sourceIds: {
      amazonOrderId: null,
      amazonVendorPONumber: poNumber,
      bolOrderId: null,
      odooSaleOrderId: vendorPO.odoo?.saleOrderId || null,
      odooSaleOrderName: vendorPO.odoo?.saleOrderName || null
    },

    // Channel discriminator
    channel: CHANNELS.AMAZON_VENDOR,
    subChannel: SUB_CHANNELS.VENDOR,
    marketplace,

    // Unified fields
    orderDate: vendorPO.purchaseOrderDate,
    lastUpdateDate: vendorPO.updatedAt,

    status: {
      unified: unifiedStatus,
      source: sourceStatus,
      odoo: null
    },

    customer,
    shippingAddress,

    totals: {
      subtotal,
      tax: taxTotal,
      total: subtotal, // Vendor orders don't include tax in PO
      currency
    },

    items,

    // Embedded Odoo data
    odoo,

    // Channel-specific extensions
    amazonSeller: null,
    amazonVendor,
    bol: null,

    // Metadata
    importedAt: vendorPO.createdAt,
    createdAt: vendorPO.createdAt || new Date(),
    updatedAt: vendorPO.updatedAt || new Date()
  };
}

/**
 * Transform an Amazon Vendor API PO response to unified format
 * @param {Object} amazonPO - PO from Amazon Vendor API
 * @param {string} marketplace - Marketplace code
 * @returns {Object} Unified order document
 */
function transformAmazonVendorApiOrder(amazonPO, marketplace = 'DE') {
  const poNumber = amazonPO.purchaseOrderNumber;
  const unifiedOrderId = `${CHANNELS.AMAZON_VENDOR}:${poNumber}`;

  const details = amazonPO.orderDetails || {};
  const sourceStatus = amazonPO.purchaseOrderState;
  const unifiedStatus = STATUS_MAP[sourceStatus] || UNIFIED_STATUS.PENDING;

  // Parse items
  let subtotal = 0;
  const items = (details.items || []).map(item => {
    const unitCost = parseFloat(item.netCost?.amount) || 0;
    const qty = parseInt(item.orderedQuantity?.amount) || 0;
    const lineTotal = unitCost * qty;
    subtotal += lineTotal;

    return {
      sku: item.vendorProductIdentifier || null,
      asin: item.amazonProductIdentifier,
      ean: item.vendorProductIdentifier || null,
      name: item.title || `ASIN: ${item.amazonProductIdentifier}`,
      quantity: qty,
      quantityShipped: 0,
      unitPrice: unitCost,
      lineTotal,
      tax: 0
    };
  });

  // Parse delivery window
  let deliveryWindow = null;
  if (details.deliveryWindow) {
    if (typeof details.deliveryWindow === 'string') {
      const parts = details.deliveryWindow.split('--');
      if (parts.length === 2) {
        deliveryWindow = {
          startDate: new Date(parts[0]),
          endDate: new Date(parts[1])
        };
      }
    } else if (typeof details.deliveryWindow === 'object') {
      deliveryWindow = {
        startDate: details.deliveryWindow.startDate ? new Date(details.deliveryWindow.startDate) : null,
        endDate: details.deliveryWindow.endDate ? new Date(details.deliveryWindow.endDate) : null
      };
    }
  }

  // Shipping address from shipToParty
  const shipTo = details.shipToParty || {};
  const shipAddr = shipTo.address || {};
  const shippingAddress = {
    name: shipAddr.name || null,
    street: shipAddr.addressLine1 || null,
    street2: shipAddr.addressLine2 || null,
    city: shipAddr.city || null,
    state: shipAddr.stateOrRegion || null,
    postalCode: shipAddr.postalCode || null,
    countryCode: shipAddr.countryCode || null,
    phone: null,
    warehouseCode: shipTo.partyId || null
  };

  return {
    unifiedOrderId,

    sourceIds: {
      amazonOrderId: null,
      amazonVendorPONumber: poNumber,
      bolOrderId: null,
      odooSaleOrderId: null,
      odooSaleOrderName: null
    },

    channel: CHANNELS.AMAZON_VENDOR,
    subChannel: SUB_CHANNELS.VENDOR,
    marketplace: {
      code: marketplace,
      id: null,
      name: `Amazon.${marketplace.toLowerCase()} (Vendor)`
    },

    orderDate: details.purchaseOrderDate ? new Date(details.purchaseOrderDate) : new Date(),
    lastUpdateDate: new Date(),

    status: {
      unified: unifiedStatus,
      source: sourceStatus,
      odoo: null
    },

    customer: {
      name: 'Amazon Vendor Central',
      email: null,
      odooPartnerId: null,
      odooPartnerName: null,
      amazonPartyId: details.buyingParty?.partyId || null
    },

    shippingAddress,

    totals: {
      subtotal,
      tax: 0,
      total: subtotal,
      currency: 'EUR'
    },

    items,

    // Empty object (never null) to allow dot-notation updates
    odoo: {},

    amazonSeller: null,
    amazonVendor: {
      purchaseOrderState: amazonPO.purchaseOrderState,
      purchaseOrderType: details.purchaseOrderType || 'RegularOrder',
      deliveryWindow,
      buyingParty: details.buyingParty || null,
      sellingParty: details.sellingParty || null,
      shipToParty: details.shipToParty || null,
      billToParty: details.billToParty || null,
      acknowledgment: {
        acknowledged: false,
        acknowledgedAt: null,
        status: null
      },
      shipmentStatus: 'not_shipped',
      shipments: []
    },
    bol: null,

    createdAt: new Date(),
    updatedAt: new Date()
  };
}

module.exports = {
  transformVendorOrder,
  transformAmazonVendorApiOrder
};
