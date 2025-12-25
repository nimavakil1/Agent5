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
const { VendorASNCreator, getVendorASNCreator, SHIPMENT_TYPES, TRANSPORTATION_METHODS } = require('./VendorASNCreator');
const { VendorChargebackTracker, getVendorChargebackTracker, CHARGEBACK_TYPES, DISPUTE_STATUS } = require('./VendorChargebackTracker');
const { VendorRemittanceParser, getVendorRemittanceParser, PAYMENT_STATUS, PAYMENT_TYPES } = require('./VendorRemittanceParser');

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

  // ASN/Shipment Creation
  VendorASNCreator,
  getVendorASNCreator,

  // Chargeback Tracking
  VendorChargebackTracker,
  getVendorChargebackTracker,

  // Remittance Parsing
  VendorRemittanceParser,
  getVendorRemittanceParser,

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
  INVOICE_COLLECTION,
  SHIPMENT_TYPES,
  TRANSPORTATION_METHODS,
  CHARGEBACK_TYPES,
  DISPUTE_STATUS,
  PAYMENT_STATUS,
  PAYMENT_TYPES
};
