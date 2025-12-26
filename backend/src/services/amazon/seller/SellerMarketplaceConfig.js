/**
 * Seller Marketplace Configuration
 *
 * Maps Amazon Seller Central marketplaces to:
 * - Country codes
 * - FBA warehouse IDs in Odoo
 * - Central warehouse ID
 * - Currencies
 * - Fiscal positions
 * - Pricelists
 *
 * Based on Emipro configuration from docs/AMAZON_SELLER_EMIPRO_CONFIG.md
 *
 * @module SellerMarketplaceConfig
 */

/**
 * Amazon Seller Central Marketplace IDs
 */
const MARKETPLACE_IDS = {
  FR: 'A13V1IB3VIYZZH',
  NL: 'A1805IZSGTT6HS',
  PL: 'A1C3SOZRARQ6R3',
  DE: 'A1PA6795UKMFR9',
  ES: 'A1RKKUPIHCS9HS',
  SE: 'A2NODRKZP88ZB9',
  TR: 'A33AVAJ2PDY3EV',
  BE: 'AMEN7PMS3EDWL',
  IT: 'APJ6JRA9NG5V4',
  UK: 'A1F83G8C2ARO7P',
  IE: 'A28R8C7NBKEWEA',
  SA: 'A17E79C6D8DWNP',
  AE: 'A2VIGQ35RCS4UG'
};

/**
 * Marketplace configuration with Odoo mappings
 * Based on Emipro amazon_ept configuration
 */
const MARKETPLACE_CONFIG = {
  // France
  'A13V1IB3VIYZZH': {
    country: 'FR',
    currency: 'EUR',
    fbaWarehouseId: 5,      // FBA Amazon.fr
    centralWarehouseId: 1,   // Central Warehouse
    salesTeamId: 19,         // Amazon FR
    domain: 'www.amazon.fr',
    name: 'Amazon.fr'
  },
  // Netherlands
  'A1805IZSGTT6HS': {
    country: 'NL',
    currency: 'EUR',
    fbaWarehouseId: 6,      // FBA Amazon.nl
    centralWarehouseId: 1,
    salesTeamId: 21,         // Amazon NL
    domain: 'www.amazon.nl',
    name: 'Amazon.nl'
  },
  // Poland
  'A1C3SOZRARQ6R3': {
    country: 'PL',
    currency: 'PLN',
    fbaWarehouseId: 7,      // FBA Amazon.pl
    centralWarehouseId: 1,
    salesTeamId: 22,         // Amazon PL
    domain: 'www.amazon.pl',
    name: 'Amazon.pl'
  },
  // Germany
  'A1PA6795UKMFR9': {
    country: 'DE',
    currency: 'EUR',
    fbaWarehouseId: 8,      // FBA Amazon.de
    centralWarehouseId: 1,
    salesTeamId: 17,         // Amazon DE
    domain: 'www.amazon.de',
    name: 'Amazon.de'
  },
  // Spain
  'A1RKKUPIHCS9HS': {
    country: 'ES',
    currency: 'EUR',
    fbaWarehouseId: 9,      // FBA Amazon.es
    centralWarehouseId: 1,
    salesTeamId: 18,         // Amazon ES
    domain: 'www.amazon.es',
    name: 'Amazon.es'
  },
  // Sweden
  'A2NODRKZP88ZB9': {
    country: 'SE',
    currency: 'SEK',
    fbaWarehouseId: 10,     // FBA Amazon.se
    centralWarehouseId: 1,
    salesTeamId: 24,         // Amazon SE
    domain: 'www.amazon.se',
    name: 'Amazon.se'
  },
  // Turkey
  'A33AVAJ2PDY3EV': {
    country: 'TR',
    currency: 'TRY',
    fbaWarehouseId: 11,     // FBA Amazon.com.tr
    centralWarehouseId: 1,
    salesTeamId: null,       // No specific team
    domain: 'www.amazon.com.tr',
    name: 'Amazon.com.tr'
  },
  // Belgium
  'AMEN7PMS3EDWL': {
    country: 'BE',
    currency: 'EUR',
    fbaWarehouseId: 12,     // FBA Amazon.com.be
    centralWarehouseId: 1,
    salesTeamId: 16,         // Amazon BE
    domain: 'www.amazon.com.be',
    name: 'Amazon.com.be'
  },
  // Italy
  'APJ6JRA9NG5V4': {
    country: 'IT',
    currency: 'EUR',
    fbaWarehouseId: 13,     // FBA Amazon.it
    centralWarehouseId: 1,
    salesTeamId: 20,         // Amazon IT
    domain: 'www.amazon.it',
    name: 'Amazon.it'
  },
  // United Kingdom
  'A1F83G8C2ARO7P': {
    country: 'UK',
    currency: 'GBP',
    fbaWarehouseId: 19,     // FBA Amazon.co.uk
    centralWarehouseId: 1,
    salesTeamId: 25,         // Amazon UK
    domain: 'www.amazon.co.uk',
    name: 'Amazon.co.uk'
  },
  // Ireland
  'A28R8C7NBKEWEA': {
    country: 'IE',
    currency: 'EUR',
    fbaWarehouseId: null,   // No specific FBA warehouse
    centralWarehouseId: 1,
    salesTeamId: null,
    domain: 'www.amazon.ie',
    name: 'Amazon.ie'
  },
  // Saudi Arabia
  'A17E79C6D8DWNP': {
    country: 'SA',
    currency: 'SAR',
    fbaWarehouseId: null,
    centralWarehouseId: 1,
    salesTeamId: null,
    domain: 'www.amazon.sa',
    name: 'Amazon.sa'
  },
  // UAE
  'A2VIGQ35RCS4UG': {
    country: 'AE',
    currency: 'AED',
    fbaWarehouseId: null,
    centralWarehouseId: 1,
    salesTeamId: null,
    domain: 'www.amazon.ae',
    name: 'Amazon.ae'
  }
};

/**
 * Special products for accounting (Odoo product IDs)
 */
const SPECIAL_PRODUCTS = {
  SHIPPING_CHARGE: { id: 16401, ref: '[SHIP AMAZON]' },
  GIFT_WRAPPER: { id: 16403, ref: '[GIFT WRAPPER FEE]' },
  PROMOTION_DISCOUNT: { id: 16404, ref: '[PROMOTION DISCOUNT]' },
  SHIPMENT_DISCOUNT: { id: 16405, ref: '[SHIPMENT DISCOUNT]' },
  REIMBURSEMENT: { id: 16406, ref: '[REIMBURSEMENT]' }
};

/**
 * Order prefixes matching Emipro configuration
 */
const ORDER_PREFIXES = {
  FBA: 'FBA',  // Fulfilled by Amazon
  FBM: 'FBM'   // Fulfilled by Merchant
};

/**
 * Fulfillment channel codes from Amazon API
 */
const FULFILLMENT_CHANNELS = {
  AFN: 'FBA',  // Amazon Fulfillment Network
  MFN: 'FBM'   // Merchant Fulfillment Network
};

/**
 * Order statuses from Amazon API
 */
const ORDER_STATUSES = {
  PENDING: 'Pending',
  UNSHIPPED: 'Unshipped',
  PARTIALLY_SHIPPED: 'PartiallyShipped',
  SHIPPED: 'Shipped',
  CANCELED: 'Canceled',
  UNFULFILLABLE: 'Unfulfillable',
  INVOICE_UNCONFIRMED: 'InvoiceUnconfirmed',
  PENDING_AVAILABILITY: 'PendingAvailability'
};

/**
 * Get marketplace configuration by marketplace ID
 * @param {string} marketplaceId - Amazon marketplace ID
 * @returns {object|null} Marketplace configuration
 */
function getMarketplaceConfig(marketplaceId) {
  return MARKETPLACE_CONFIG[marketplaceId] || null;
}

/**
 * Get marketplace ID by country code
 * @param {string} countryCode - 2-letter country code
 * @returns {string|null} Marketplace ID
 */
function getMarketplaceIdByCountry(countryCode) {
  const country = countryCode.toUpperCase();
  return MARKETPLACE_IDS[country] || null;
}

/**
 * Get country code from marketplace ID
 * @param {string} marketplaceId - Amazon marketplace ID
 * @returns {string|null} Country code
 */
function getCountryFromMarketplace(marketplaceId) {
  const config = MARKETPLACE_CONFIG[marketplaceId];
  return config ? config.country : null;
}

/**
 * Get warehouse ID based on fulfillment channel
 * @param {string} marketplaceId - Amazon marketplace ID
 * @param {string} fulfillmentChannel - 'AFN' (FBA) or 'MFN' (FBM)
 * @returns {number} Odoo warehouse ID
 */
function getWarehouseId(marketplaceId, fulfillmentChannel) {
  const config = MARKETPLACE_CONFIG[marketplaceId];
  if (!config) return 1; // Default to central warehouse

  if (fulfillmentChannel === 'AFN' && config.fbaWarehouseId) {
    return config.fbaWarehouseId;
  }

  return config.centralWarehouseId || 1;
}

/**
 * Get order prefix based on fulfillment channel
 * @param {string} fulfillmentChannel - 'AFN' (FBA) or 'MFN' (FBM)
 * @returns {string} Order prefix
 */
function getOrderPrefix(fulfillmentChannel) {
  return FULFILLMENT_CHANNELS[fulfillmentChannel] || 'FBM';
}

/**
 * Get all marketplace IDs for polling
 * @returns {string[]} Array of all marketplace IDs
 */
function getAllMarketplaceIds() {
  return Object.values(MARKETPLACE_IDS);
}

/**
 * Get all configured marketplaces with their configurations
 * @returns {object[]} Array of marketplace configurations with IDs
 */
function getAllMarketplaces() {
  return Object.entries(MARKETPLACE_CONFIG).map(([id, config]) => ({
    marketplaceId: id,
    ...config
  }));
}

module.exports = {
  MARKETPLACE_IDS,
  MARKETPLACE_CONFIG,
  SPECIAL_PRODUCTS,
  ORDER_PREFIXES,
  FULFILLMENT_CHANNELS,
  ORDER_STATUSES,
  getMarketplaceConfig,
  getMarketplaceIdByCountry,
  getCountryFromMarketplace,
  getWarehouseId,
  getOrderPrefix,
  getAllMarketplaceIds,
  getAllMarketplaces
};
