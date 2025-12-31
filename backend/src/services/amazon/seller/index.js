/**
 * Amazon Seller Central Services
 *
 * Complete Emipro replacement - all seller-related services:
 * - Order import, creation, scheduling
 * - Shipment sync (FBA) and tracking push (FBM)
 * - Canceled order sync
 * - FBA inventory import
 * - FBM inventory export
 * - Stock adjustments and removal orders
 * - Inbound shipment tracking
 * - Fulfillment center sync
 * - Multi-Channel Fulfillment (MCF)
 *
 * @module services/amazon/seller
 */

const { SellerClient, getSellerClient } = require('./SellerClient');
const {
  SellerOrderImporter,
  getSellerOrderImporter,
  COLLECTION_NAME,
  HISTORICAL_CUTOFF
} = require('./SellerOrderImporter');
const { SellerOrderCreator, getSellerOrderCreator } = require('./SellerOrderCreator');
const {
  SellerOrderScheduler,
  getSellerOrderScheduler,
  startSellerScheduler
} = require('./SellerOrderScheduler');
const {
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
} = require('./SellerMarketplaceConfig');
const { SellerShipmentSync, getSellerShipmentSync } = require('./SellerShipmentSync');
const { SellerTrackingPusher, getSellerTrackingPusher, CARRIER_MAPPING } = require('./SellerTrackingPusher');
const { SellerCanceledOrderSync, getSellerCanceledOrderSync } = require('./SellerCanceledOrderSync');
const { SellerFbaInventorySync, getSellerFbaInventorySync, FBA_INVENTORY_REPORT } = require('./SellerFbaInventorySync');
const { SellerInventoryExport, getSellerInventoryExport, INVENTORY_FEED_TYPE } = require('./SellerInventoryExport');
const { SellerFbaReportsSync, getSellerFbaReportsSync, STOCK_ADJUSTMENT_REPORT, REMOVAL_ORDER_REPORT } = require('./SellerFbaReportsSync');
const { SellerInboundShipmentSync, getSellerInboundShipmentSync, SHIPMENT_STATUSES } = require('./SellerInboundShipmentSync');
const { SellerFulfillmentSync, getSellerFulfillmentSync } = require('./SellerFulfillmentSync');
const { AddressCleaner, getAddressCleaner, LEGAL_TERMS_REGEX } = require('./AddressCleaner');

module.exports = {
  // Client
  SellerClient,
  getSellerClient,

  // Importer
  SellerOrderImporter,
  getSellerOrderImporter,
  COLLECTION_NAME,
  HISTORICAL_CUTOFF,

  // Creator
  SellerOrderCreator,
  getSellerOrderCreator,

  // Scheduler
  SellerOrderScheduler,
  getSellerOrderScheduler,
  startSellerScheduler,

  // Shipment Sync (FBA: Amazon → Odoo)
  SellerShipmentSync,
  getSellerShipmentSync,

  // Tracking Push (FBM: Odoo → Amazon)
  SellerTrackingPusher,
  getSellerTrackingPusher,
  CARRIER_MAPPING,

  // Canceled Order Sync
  SellerCanceledOrderSync,
  getSellerCanceledOrderSync,

  // FBA Inventory Import
  SellerFbaInventorySync,
  getSellerFbaInventorySync,
  FBA_INVENTORY_REPORT,

  // FBM Inventory Export
  SellerInventoryExport,
  getSellerInventoryExport,
  INVENTORY_FEED_TYPE,

  // FBA Reports (Adjustments & Removals)
  SellerFbaReportsSync,
  getSellerFbaReportsSync,
  STOCK_ADJUSTMENT_REPORT,
  REMOVAL_ORDER_REPORT,

  // Inbound Shipment Tracking
  SellerInboundShipmentSync,
  getSellerInboundShipmentSync,
  SHIPMENT_STATUSES,

  // Fulfillment Centers & MCF
  SellerFulfillmentSync,
  getSellerFulfillmentSync,

  // Marketplace Config
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
