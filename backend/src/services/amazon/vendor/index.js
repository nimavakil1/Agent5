/**
 * Amazon Vendor Central Services
 *
 * Exports all Vendor Central integration services.
 *
 * @module amazon/vendor
 */

const { VendorClient, createAllVendorClients, MARKETPLACE_IDS, VENDOR_TOKEN_MAP, VENDOR_ACCOUNTS, PO_STATES, PO_TYPES } = require('./VendorClient');
const { VendorPOImporter, getVendorPOImporter, COLLECTION_NAME: PO_COLLECTION } = require('./VendorPOImporter');

module.exports = {
  // Client
  VendorClient,
  createAllVendorClients,

  // PO Import
  VendorPOImporter,
  getVendorPOImporter,

  // Constants
  MARKETPLACE_IDS,
  VENDOR_TOKEN_MAP,
  VENDOR_ACCOUNTS,
  PO_STATES,
  PO_TYPES,
  PO_COLLECTION
};
