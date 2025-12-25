/**
 * Amazon Services Index
 *
 * Core services for Amazon integration
 */

const { SkuResolver, skuResolver } = require('./SkuResolver');
const { EuCountryConfig, euCountryConfig, EU_COUNTRIES, VAT_REGISTERED_COUNTRIES, MARKETPLACE_TO_COUNTRY, FBA_WAREHOUSE_COUNTRY } = require('./EuCountryConfig');
const { OrderImporter } = require('./OrderImporter');
const { VcsInvoiceImporter } = require('./VcsInvoiceImporter');
const { FbaInventoryReconciler, ODOO_FBA_WAREHOUSES } = require('./FbaInventoryReconciler');
const { FbmStockSync } = require('./FbmStockSync');
const { TrackingSync, CARRIER_MAPPING } = require('./TrackingSync');
const { VcsTaxReportParser, VAT_RATES } = require('./VcsTaxReportParser');
const { VcsOdooInvoicer, MARKETPLACE_JOURNALS, FISCAL_POSITIONS } = require('./VcsOdooInvoicer');
const { FbaInventoryReportParser, FBA_WAREHOUSES } = require('./FbaInventoryReportParser');
const { ReturnsReportParser, RETURN_REASONS, DISPOSITIONS } = require('./ReturnsReportParser');

// Vendor Central
const vendor = require('./vendor');

module.exports = {
  // SKU Resolution
  SkuResolver,
  skuResolver,

  // EU Country Configuration
  EuCountryConfig,
  euCountryConfig,

  // Order Import
  OrderImporter,

  // VCS Invoice Import
  VcsInvoiceImporter,

  // FBA Inventory Reconciliation
  FbaInventoryReconciler,
  ODOO_FBA_WAREHOUSES,

  // FBM Stock Sync
  FbmStockSync,

  // Tracking Sync
  TrackingSync,
  CARRIER_MAPPING,

  // VCS Tax Report Processing
  VcsTaxReportParser,
  VcsOdooInvoicer,
  VAT_RATES,
  MARKETPLACE_JOURNALS,
  FISCAL_POSITIONS,

  // FBA Inventory Report Parser
  FbaInventoryReportParser,
  FBA_WAREHOUSES,

  // Returns Report Parser
  ReturnsReportParser,
  RETURN_REASONS,
  DISPOSITIONS,

  // Constants
  EU_COUNTRIES,
  VAT_REGISTERED_COUNTRIES,
  MARKETPLACE_TO_COUNTRY,
  FBA_WAREHOUSE_COUNTRY,

  // Vendor Central
  vendor,
  VendorClient: vendor.VendorClient,
  VendorPOImporter: vendor.VendorPOImporter,
  getVendorPOImporter: vendor.getVendorPOImporter,
};
