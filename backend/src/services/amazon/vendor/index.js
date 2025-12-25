/**
 * Amazon Vendor Central Services
 *
 * Exports all Vendor Central integration services.
 *
 * @module amazon/vendor
 */

const { VendorClient, createAllVendorClients, MARKETPLACE_IDS, VENDOR_TOKEN_MAP, VENDOR_ACCOUNTS, PO_STATES, PO_TYPES } = require('./VendorClient');
const { VendorPOImporter, getVendorPOImporter, COLLECTION_NAME: PO_COLLECTION } = require('./VendorPOImporter');
const { VendorOrderCreator, getVendorOrderCreator, AMAZON_VENDOR_PARTNERS, MARKETPLACE_WAREHOUSE, VENDOR_SALES_TEAMS } = require('./VendorOrderCreator');
const { VendorPOAcknowledger, getVendorPOAcknowledger, ACK_CODES, VENDOR_PARTY_IDS } = require('./VendorPOAcknowledger');
const { VendorInvoiceSubmitter, getVendorInvoiceSubmitter, INVOICE_TYPES, ACROPAQ_COMPANY, INVOICE_COLLECTION } = require('./VendorInvoiceSubmitter');

module.exports = {
  // Client
  VendorClient,
  createAllVendorClients,

  // PO Import
  VendorPOImporter,
  getVendorPOImporter,

  // Order Creation
  VendorOrderCreator,
  getVendorOrderCreator,

  // PO Acknowledgment
  VendorPOAcknowledger,
  getVendorPOAcknowledger,

  // Invoice Submission
  VendorInvoiceSubmitter,
  getVendorInvoiceSubmitter,

  // Constants
  MARKETPLACE_IDS,
  VENDOR_TOKEN_MAP,
  VENDOR_ACCOUNTS,
  PO_STATES,
  PO_TYPES,
  PO_COLLECTION,
  AMAZON_VENDOR_PARTNERS,
  MARKETPLACE_WAREHOUSE,
  VENDOR_SALES_TEAMS,
  ACK_CODES,
  VENDOR_PARTY_IDS,
  INVOICE_TYPES,
  ACROPAQ_COMPANY,
  INVOICE_COLLECTION
};
