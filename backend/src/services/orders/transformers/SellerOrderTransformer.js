/**
 * SellerOrderTransformer - Transform Amazon Seller orders to unified format
 *
 * @module SellerOrderTransformer
 */

const {
  CHANNELS,
  SUB_CHANNELS,
  UNIFIED_STATUS,
  STATUS_MAP
} = require('../UnifiedOrderService');
const { getItemQuantity } = require('../../amazon/seller/SellerOrderSchema');

/**
 * Transform a seller_orders document to unified format
 * @param {Object} sellerOrder - Document from seller_orders collection
 * @returns {Object} Unified order document
 */
function transformSellerOrder(sellerOrder) {
  const amazonOrderId = sellerOrder.amazonOrderId;
  const isFBA = sellerOrder.fulfillmentChannel === 'AFN';
  const subChannel = isFBA ? SUB_CHANNELS.FBA : SUB_CHANNELS.FBM;

  // Generate unified order ID
  const unifiedOrderId = `${CHANNELS.AMAZON_SELLER}:${amazonOrderId}`;

  // Map status
  const sourceStatus = sellerOrder.orderStatus;
  const unifiedStatus = STATUS_MAP[sourceStatus] || UNIFIED_STATUS.PENDING;

  // Extract order total
  const orderTotal = sellerOrder.orderTotal || {};
  const currency = orderTotal.currencyCode || 'EUR';
  const totalAmount = parseFloat(orderTotal.amount) || 0;

  // Calculate item totals
  let subtotal = 0;
  let taxTotal = 0;
  const items = (sellerOrder.items || []).map(item => {
    const itemPrice = parseFloat(item.itemPrice?.amount) || 0;
    const itemTax = parseFloat(item.itemTax?.amount) || 0;
    subtotal += itemPrice;
    taxTotal += itemTax;

    // @see SellerOrderSchema.js for field definitions
    const qty = getItemQuantity(item);
    return {
      sku: item.sellerSku,
      asin: item.asin,
      ean: null, // Not available from Amazon
      name: item.title,
      quantity: qty,
      quantityShipped: item.quantityShipped || 0,
      unitPrice: itemPrice / qty,
      lineTotal: itemPrice,
      tax: itemTax,
      orderItemId: item.orderItemId
    };
  });

  // Build shipping address
  const shippingAddress = sellerOrder.shippingAddress ? {
    name: sellerOrder.shippingAddress.name || null,
    street: sellerOrder.shippingAddress.addressLine1 || null,
    street2: sellerOrder.shippingAddress.addressLine2 || null,
    city: sellerOrder.shippingAddress.city || null,
    state: sellerOrder.shippingAddress.stateOrRegion || null,
    postalCode: sellerOrder.shippingAddress.postalCode || null,
    countryCode: sellerOrder.shippingAddress.countryCode || null,
    phone: sellerOrder.shippingAddress.phone || null
  } : null;

  // Build customer info
  const customer = {
    name: sellerOrder.shippingAddress?.name || sellerOrder.buyerName || null,
    email: sellerOrder.buyerEmail || null,
    odooPartnerId: sellerOrder.odoo?.partnerId || null,
    odooPartnerName: null // Will be populated from Odoo sync
  };

  // Determine marketplace
  const marketplace = {
    code: sellerOrder.marketplaceCountry || 'DE',
    id: sellerOrder.marketplaceId,
    name: `Amazon.${(sellerOrder.marketplaceCountry || 'DE').toLowerCase()}`
  };

  // Build Odoo data (embedded)
  const odoo = sellerOrder.odoo ? {
    saleOrderId: sellerOrder.odoo.saleOrderId || null,
    saleOrderName: sellerOrder.odoo.saleOrderName || null,
    state: null, // Will be populated from Odoo sync
    partnerId: sellerOrder.odoo.partnerId || null,
    partnerName: null,
    warehouseId: null,
    invoiceStatus: null,
    invoices: [],
    pickings: [],
    syncedAt: null,
    syncError: sellerOrder.odoo.syncError || null
  } : null;

  // Amazon Seller specific fields
  const amazonSeller = {
    fulfillmentChannel: sellerOrder.fulfillmentChannel,
    isPrime: sellerOrder.isPrime || false,
    isBusinessOrder: sellerOrder.isBusinessOrder || false,
    isPremiumOrder: sellerOrder.isPremiumOrder || false,
    salesChannel: sellerOrder.salesChannel,
    orderChannel: sellerOrder.orderChannel,
    shipServiceLevel: sellerOrder.shipServiceLevel,
    shipmentServiceLevelCategory: sellerOrder.shipmentServiceLevelCategory,
    buyerEmail: sellerOrder.buyerEmail,
    buyerName: sellerOrder.buyerName,
    autoImportEligible: sellerOrder.autoImportEligible,
    itemsFetched: sellerOrder.itemsFetched || false,
    // Ship-by dates (FBM only)
    earliestShipDate: sellerOrder.earliestShipDate || null,
    latestShipDate: sellerOrder.latestShipDate || null
  };

  // Unified shipping deadline (for cross-channel queries)
  // FBM: latestShipDate, FBA: null (Amazon handles fulfillment)
  const shippingDeadline = !isFBA && sellerOrder.latestShipDate
    ? new Date(sellerOrder.latestShipDate)
    : null;

  return {
    unifiedOrderId,

    // Source identifiers
    sourceIds: {
      amazonOrderId,
      amazonVendorPONumber: null,
      bolOrderId: null,
      odooSaleOrderId: sellerOrder.odoo?.saleOrderId || null,
      odooSaleOrderName: sellerOrder.odoo?.saleOrderName || null
    },

    // Channel discriminator
    channel: CHANNELS.AMAZON_SELLER,
    subChannel,
    marketplace,

    // Unified fields
    orderDate: sellerOrder.purchaseDate,
    lastUpdateDate: sellerOrder.lastUpdateDate,
    shippingDeadline, // Unified ship-by date for cross-channel queries

    status: {
      unified: unifiedStatus,
      source: sourceStatus,
      odoo: null // Will be populated from Odoo sync
    },

    customer,
    shippingAddress,

    // Billing address (separate from shipping - populated from TSV import)
    billingAddress: null,

    // AI-cleaned address data (populated by AddressCleanerAI during TSV import)
    addressCleaningResult: null,

    // B2B order indicators (extracted from TSV or API)
    isBusinessOrder: sellerOrder.isBusinessOrder || amazonSeller.isBusinessOrder || false,
    buyerCompanyName: sellerOrder.buyerCompanyName || null,

    // TSV import tracking (populated when imported via TSV)
    tsvImport: sellerOrder.tsvImport || null,

    totals: {
      subtotal: subtotal || totalAmount,
      tax: taxTotal,
      total: totalAmount,
      currency
    },

    items,

    // Embedded Odoo data
    odoo,

    // Channel-specific extensions
    amazonSeller,
    amazonVendor: null,
    bol: null,

    // Metadata
    importedAt: sellerOrder.importedAt,
    createdAt: sellerOrder.importedAt || new Date(),
    updatedAt: sellerOrder.updatedAt || new Date()
  };
}

/**
 * Transform an Amazon API order response to unified format (for new orders)
 * @param {Object} amazonOrder - Order from Amazon SP-API
 * @param {Object} orderItems - Items from Amazon SP-API
 * @returns {Object} Unified order document
 */
function transformAmazonApiOrder(amazonOrder, orderItems = []) {
  const amazonOrderId = amazonOrder.AmazonOrderId;
  const isFBA = amazonOrder.FulfillmentChannel === 'AFN';
  const subChannel = isFBA ? SUB_CHANNELS.FBA : SUB_CHANNELS.FBM;

  const unifiedOrderId = `${CHANNELS.AMAZON_SELLER}:${amazonOrderId}`;

  const sourceStatus = amazonOrder.OrderStatus;
  const unifiedStatus = STATUS_MAP[sourceStatus] || UNIFIED_STATUS.PENDING;

  // Parse order total
  const orderTotal = amazonOrder.OrderTotal || {};
  const currency = orderTotal.CurrencyCode || 'EUR';
  const totalAmount = parseFloat(orderTotal.Amount) || 0;

  // Transform items
  let subtotal = 0;
  let taxTotal = 0;
  const items = orderItems.map(item => {
    const itemPrice = parseFloat(item.ItemPrice?.Amount) || 0;
    const itemTax = parseFloat(item.ItemTax?.Amount) || 0;
    subtotal += itemPrice;
    taxTotal += itemTax;

    return {
      sku: item.SellerSKU,
      asin: item.ASIN,
      ean: null,
      name: item.Title,
      quantity: item.QuantityOrdered || 1,
      quantityShipped: item.QuantityShipped || 0,
      unitPrice: itemPrice / (item.QuantityOrdered || 1),
      lineTotal: itemPrice,
      tax: itemTax,
      orderItemId: item.OrderItemId
    };
  });

  // Shipping address
  const addr = amazonOrder.ShippingAddress || {};
  const shippingAddress = Object.keys(addr).length > 0 ? {
    name: addr.Name || null,
    street: addr.AddressLine1 || null,
    street2: addr.AddressLine2 || null,
    city: addr.City || null,
    state: addr.StateOrRegion || null,
    postalCode: addr.PostalCode || null,
    countryCode: addr.CountryCode || null,
    phone: addr.Phone || null
  } : null;

  const customer = {
    name: addr.Name || amazonOrder.BuyerInfo?.BuyerName || null,
    email: amazonOrder.BuyerInfo?.BuyerEmail || null,
    odooPartnerId: null,
    odooPartnerName: null
  };

  // Unified shipping deadline (for cross-channel queries)
  // FBM: latestShipDate, FBA: null (Amazon handles fulfillment)
  const shippingDeadline = !isFBA && amazonOrder.LatestShipDate
    ? new Date(amazonOrder.LatestShipDate)
    : null;

  // Determine marketplace
  const marketplaceId = amazonOrder.MarketplaceId;
  const marketplaceCountry = getMarketplaceCountry(marketplaceId);

  return {
    unifiedOrderId,

    sourceIds: {
      amazonOrderId,
      amazonVendorPONumber: null,
      bolOrderId: null,
      odooSaleOrderId: null,
      odooSaleOrderName: null
    },

    channel: CHANNELS.AMAZON_SELLER,
    subChannel,
    marketplace: {
      code: marketplaceCountry,
      id: marketplaceId,
      name: `Amazon.${marketplaceCountry.toLowerCase()}`
    },

    orderDate: new Date(amazonOrder.PurchaseDate),
    lastUpdateDate: new Date(amazonOrder.LastUpdateDate),
    shippingDeadline, // Unified ship-by date for cross-channel queries

    status: {
      unified: unifiedStatus,
      source: sourceStatus,
      odoo: null
    },

    customer,
    shippingAddress,

    // Billing address (separate from shipping - populated from TSV import)
    billingAddress: null,

    // AI-cleaned address data (populated by AddressCleanerAI during TSV import)
    addressCleaningResult: null,

    // B2B order indicators (extracted from TSV or API)
    isBusinessOrder: amazonOrder.IsBusinessOrder || false,
    buyerCompanyName: null,

    // TSV import tracking (populated when imported via TSV)
    tsvImport: null,

    totals: {
      subtotal: subtotal || totalAmount,
      tax: taxTotal,
      total: totalAmount,
      currency
    },

    items,

    // Empty object (never null) to allow dot-notation updates
    odoo: {},

    amazonSeller: {
      fulfillmentChannel: amazonOrder.FulfillmentChannel,
      isPrime: amazonOrder.IsPrime || false,
      isBusinessOrder: amazonOrder.IsBusinessOrder || false,
      isPremiumOrder: amazonOrder.IsPremiumOrder || false,
      salesChannel: amazonOrder.SalesChannel,
      orderChannel: amazonOrder.OrderChannel,
      shipServiceLevel: amazonOrder.ShipServiceLevel,
      shipmentServiceLevelCategory: amazonOrder.ShipmentServiceLevelCategory,
      buyerEmail: amazonOrder.BuyerInfo?.BuyerEmail,
      buyerName: amazonOrder.BuyerInfo?.BuyerName,
      autoImportEligible: new Date(amazonOrder.PurchaseDate) >= new Date('2024-01-01'),
      itemsFetched: orderItems.length > 0,
      // Ship-by dates (FBM only - from Amazon SP-API)
      earliestShipDate: amazonOrder.EarliestShipDate ? new Date(amazonOrder.EarliestShipDate) : null,
      latestShipDate: amazonOrder.LatestShipDate ? new Date(amazonOrder.LatestShipDate) : null
    },
    amazonVendor: null,
    bol: null,

    createdAt: new Date(),
    updatedAt: new Date()
  };
}

/**
 * Get marketplace country from marketplace ID
 */
function getMarketplaceCountry(marketplaceId) {
  const marketplaceMap = {
    'A1PA6795UKMFR9': 'DE',
    'A13V1IB3VIYZZH': 'FR',
    'A1RKKUPIHCS9HS': 'ES',
    'APJ6JRA9NG5V4': 'IT',
    'A1F83G8C2ARO7P': 'UK',
    'A21TJRUUN4KGV': 'IN',
    'ATVPDKIKX0DER': 'US',
    'A2EUQ1WTGCTBG2': 'CA',
    'A1AM78C64UM0Y8': 'MX',
    'A1MQXOICRS2Z7M': 'TR',
    'A2NODRKZP88ZB9': 'SE',
    'A1C3SOZRARQ6R3': 'PL',
    'AMEN7PMS3EDWL': 'BE',
    'A1805IZSGTT6HS': 'NL'
  };
  return marketplaceMap[marketplaceId] || 'DE';
}

module.exports = {
  transformSellerOrder,
  transformAmazonApiOrder,
  getMarketplaceCountry
};
