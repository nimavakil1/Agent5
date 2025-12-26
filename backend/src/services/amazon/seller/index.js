/**
 * Amazon Seller Central Services
 *
 * Exports all seller-related services for order import, Odoo creation, scheduling,
 * shipment sync, and tracking push.
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
