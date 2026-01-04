/**
 * Order Transformers Index
 *
 * Re-exports all transformers for easy importing
 */

const { transformSellerOrder, transformAmazonApiOrder, getMarketplaceCountry } = require('./SellerOrderTransformer');
const { transformVendorOrder, transformAmazonVendorApiOrder } = require('./VendorOrderTransformer');
const { transformBolOrder, transformBolApiOrder } = require('./BolOrderTransformer');

module.exports = {
  // Amazon Seller
  transformSellerOrder,
  transformAmazonApiOrder,
  getMarketplaceCountry,

  // Amazon Vendor
  transformVendorOrder,
  transformAmazonVendorApiOrder,

  // Bol.com
  transformBolOrder,
  transformBolApiOrder
};
