/**
 * Amazon Seller Order Schema
 *
 * Central type definitions for Amazon Seller order data structures.
 * These types ensure consistency across importer, creator, and transformer.
 *
 * IMPORTANT: When reading item quantity, always use `item.quantity` (not `quantityOrdered`).
 * The importer normalizes Amazon's `QuantityOrdered` to lowercase `quantity`.
 *
 * @module SellerOrderSchema
 */

/**
 * Amazon order item as stored in MongoDB (unified_orders collection)
 * @typedef {Object} AmazonOrderItem
 * @property {string} sku - Seller SKU (from Amazon's SellerSKU)
 * @property {string} sellerSku - Alias for sku (some code uses this)
 * @property {string} [asin] - Amazon ASIN
 * @property {string} [title] - Product title/name
 * @property {number} quantity - Ordered quantity (ALWAYS use this, not quantityOrdered)
 * @property {number} [quantityShipped] - Quantity already shipped
 * @property {string} orderItemId - Amazon's OrderItemId
 * @property {Object} [itemPrice] - Item price object
 * @property {string} itemPrice.amount - Price amount as string
 * @property {string} itemPrice.currencyCode - Currency code (EUR, USD, etc.)
 * @property {Object} [itemTax] - Item tax object
 * @property {string} itemTax.amount - Tax amount as string
 * @property {Object} [shippingPrice] - Shipping price object
 * @property {string} shippingPrice.amount - Shipping amount as string
 * @property {Object} [shippingDiscount] - Shipping discount object
 * @property {string} shippingDiscount.amount - Discount amount as string
 * @property {Object} [promotionDiscount] - Promotion discount object
 * @property {string} promotionDiscount.amount - Promotion discount amount as string
 */

/**
 * Amazon shipping address as stored in MongoDB
 * @typedef {Object} AmazonShippingAddress
 * @property {string} [name] - Recipient name
 * @property {string} [addressLine1] - Street address line 1
 * @property {string} [addressLine2] - Street address line 2
 * @property {string} [addressLine3] - Street address line 3
 * @property {string} [city] - City
 * @property {string} [stateOrRegion] - State or region
 * @property {string} [postalCode] - Postal/ZIP code
 * @property {string} [countryCode] - ISO country code (DE, FR, etc.)
 * @property {string} [phone] - Phone number
 */

/**
 * Amazon order as stored in MongoDB (unified_orders collection)
 * @typedef {Object} AmazonSellerOrder
 * @property {string} unifiedOrderId - Unified order ID (AMAZON_SELLER:amazonOrderId)
 * @property {string} amazonOrderId - Amazon's order ID (e.g., "028-5575618-9893126")
 * @property {string} channel - Always "AMAZON_SELLER"
 * @property {string} subChannel - "FBA" or "FBM"
 * @property {string} orderStatus - Amazon status (Pending, Unshipped, Shipped, etc.)
 * @property {string} fulfillmentChannel - "AFN" (FBA) or "MFN" (FBM)
 * @property {string} marketplaceId - Amazon marketplace ID
 * @property {string} [marketplaceCountry] - Derived country code
 * @property {Date} purchaseDate - Order date
 * @property {Date} [lastUpdateDate] - Last update timestamp
 * @property {AmazonOrderItem[]} items - Order line items
 * @property {AmazonShippingAddress} [shippingAddress] - Shipping address
 * @property {string} [buyerEmail] - Buyer's email (if available)
 * @property {string} [buyerName] - Buyer's name
 * @property {Object} [orderTotal] - Order total
 * @property {string} orderTotal.amount - Total amount
 * @property {string} orderTotal.currencyCode - Currency
 * @property {Object} [odoo] - Odoo sync status
 * @property {number} [odoo.saleOrderId] - Odoo sale.order ID
 * @property {string} [odoo.saleOrderName] - Odoo sale.order name (e.g., "FBM123")
 * @property {number} [odoo.partnerId] - Odoo res.partner ID
 * @property {string} [odoo.partnerName] - Customer name in Odoo
 * @property {string} [odoo.syncError] - Last sync error message
 * @property {Date} [odoo.lastSyncAt] - Last sync attempt timestamp
 */

/**
 * Odoo sale order line to create
 * @typedef {Object} OdooSaleOrderLine
 * @property {number} product_id - Odoo product.product ID
 * @property {number} product_uom_qty - Quantity (from AmazonOrderItem.quantity)
 * @property {number} price_unit - Unit price
 * @property {string} name - Line description
 */

/**
 * Helper to safely get quantity from an Amazon order item.
 * Handles both 'quantity' (correct) and 'quantityOrdered' (legacy) field names.
 *
 * @param {AmazonOrderItem|Object} item - The order item
 * @returns {number} The quantity, defaults to 1 if not found
 *
 * @example
 * const qty = getItemQuantity(item); // Always use this instead of item.quantity directly
 */
function getItemQuantity(item) {
  if (!item) return 1;
  return item.quantity || item.quantityOrdered || 1;
}

/**
 * Field name constants to avoid typos
 * @readonly
 * @enum {string}
 */
const ITEM_FIELDS = {
  /** The quantity field - ALWAYS use 'quantity', never 'quantityOrdered' */
  QUANTITY: 'quantity',
  SKU: 'sku',
  SELLER_SKU: 'sellerSku',
  ASIN: 'asin',
  TITLE: 'title',
  ORDER_ITEM_ID: 'orderItemId',
  QUANTITY_SHIPPED: 'quantityShipped',
  ITEM_PRICE: 'itemPrice',
  ITEM_TAX: 'itemTax',
  SHIPPING_PRICE: 'shippingPrice',
  SHIPPING_DISCOUNT: 'shippingDiscount',
  PROMOTION_DISCOUNT: 'promotionDiscount'
};

module.exports = {
  getItemQuantity,
  ITEM_FIELDS
};
