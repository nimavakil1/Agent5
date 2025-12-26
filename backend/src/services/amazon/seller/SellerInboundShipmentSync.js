/**
 * SellerInboundShipmentSync - Track FBA Inbound Shipments
 *
 * Tracks shipments you send TO Amazon's fulfillment centers:
 * 1. Get shipment status from Fulfillment Inbound API
 * 2. Update Odoo with shipment status
 *
 * @module SellerInboundShipmentSync
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { getAllMarketplaceIds } = require('./SellerMarketplaceConfig');

// Collection for inbound shipments
const INBOUND_SHIPMENTS_COLLECTION = 'seller_inbound_shipments';

// Shipment statuses
const SHIPMENT_STATUSES = {
  WORKING: 'Working',
  SHIPPED: 'Shipped',
  RECEIVING: 'Receiving',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
  DELETED: 'Deleted',
  ERROR: 'Error',
  IN_TRANSIT: 'In Transit',
  DELIVERED: 'Delivered',
  CHECKED_IN: 'Checked In'
};

/**
 * SellerInboundShipmentSync - Syncs inbound shipment status
 */
class SellerInboundShipmentSync {
  constructor() {
    this.odoo = null;
    this.client = null;
    this.db = null;
  }

  /**
   * Initialize the sync service
   */
  async init() {
    if (this.odoo && this.db) return;

    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    this.client = getSellerClient();
    await this.client.init();

    this.db = getDb();

    // Ensure index
    await this.db.collection(INBOUND_SHIPMENTS_COLLECTION).createIndex(
      { shipmentId: 1 },
      { unique: true }
    );
  }

  /**
   * Get inbound shipments from Amazon
   * @param {Object} options
   * @param {string[]} options.shipmentStatusList - Filter by status
   * @param {string[]} options.shipmentIdList - Specific shipment IDs
   */
  async getInboundShipments(options = {}) {
    await this.init();

    try {
      const spClient = await this.client.getClient();

      const queryParams = {
        QueryType: options.shipmentIdList ? 'SHIPMENT' : 'DATE_RANGE',
        MarketplaceId: getAllMarketplaceIds()[0] // Use first marketplace
      };

      if (options.shipmentStatusList) {
        queryParams.ShipmentStatusList = options.shipmentStatusList;
      }

      if (options.shipmentIdList) {
        queryParams.ShipmentIdList = options.shipmentIdList;
      }

      if (!options.shipmentIdList) {
        // Last 90 days
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
        queryParams.LastUpdatedAfter = ninetyDaysAgo.toISOString();
      }

      const response = await spClient.callAPI({
        operation: 'fulfillmentInbound.getShipments',
        query: queryParams
      });

      return response.ShipmentData || [];

    } catch (error) {
      console.error('[SellerInboundShipmentSync] Error getting shipments:', error.message);
      throw error;
    }
  }

  /**
   * Sync all inbound shipments
   */
  async syncShipments() {
    await this.init();

    const result = {
      fetched: 0,
      updated: 0,
      new: 0,
      errors: []
    };

    try {
      // Get active shipments (not closed/cancelled)
      const activeStatuses = ['WORKING', 'SHIPPED', 'RECEIVING', 'IN_TRANSIT', 'CHECKED_IN'];

      const shipments = await this.getInboundShipments({
        shipmentStatusList: activeStatuses
      });

      console.log(`[SellerInboundShipmentSync] Fetched ${shipments.length} active shipments`);
      result.fetched = shipments.length;

      for (const shipment of shipments) {
        try {
          const existing = await this.db.collection(INBOUND_SHIPMENTS_COLLECTION).findOne({
            shipmentId: shipment.ShipmentId
          });

          const shipmentData = {
            shipmentId: shipment.ShipmentId,
            shipmentName: shipment.ShipmentName,
            shipmentStatus: shipment.ShipmentStatus,
            destinationFulfillmentCenterId: shipment.DestinationFulfillmentCenterId,
            labelPrepType: shipment.LabelPrepType,
            areCasesRequired: shipment.AreCasesRequired,
            confirmedNeedByDate: shipment.ConfirmedNeedByDate,
            boxContentsSource: shipment.BoxContentsSource,
            updatedAt: new Date()
          };

          if (existing) {
            // Update existing
            await this.db.collection(INBOUND_SHIPMENTS_COLLECTION).updateOne(
              { shipmentId: shipment.ShipmentId },
              { $set: shipmentData }
            );
            result.updated++;
          } else {
            // Insert new
            shipmentData.createdAt = new Date();
            await this.db.collection(INBOUND_SHIPMENTS_COLLECTION).insertOne(shipmentData);
            result.new++;
          }

        } catch (error) {
          result.errors.push({ shipmentId: shipment.ShipmentId, error: error.message });
        }
      }

      // Also check recently updated closed shipments
      await this.checkClosedShipments(result);

    } catch (error) {
      result.errors.push({ error: error.message });
      console.error('[SellerInboundShipmentSync] Sync error:', error);
    }

    console.log(`[SellerInboundShipmentSync] Sync complete: ${result.new} new, ${result.updated} updated`);
    return result;
  }

  /**
   * Check for recently closed shipments
   */
  async checkClosedShipments(result) {
    try {
      // Get shipments we're tracking that might have closed
      const trackingShipments = await this.db.collection(INBOUND_SHIPMENTS_COLLECTION).find({
        shipmentStatus: { $nin: ['CLOSED', 'CANCELLED', 'DELETED'] }
      }).limit(50).toArray();

      if (trackingShipments.length === 0) return;

      const shipmentIds = trackingShipments.map(s => s.shipmentId);

      const updatedShipments = await this.getInboundShipments({
        shipmentIdList: shipmentIds
      });

      for (const shipment of updatedShipments) {
        await this.db.collection(INBOUND_SHIPMENTS_COLLECTION).updateOne(
          { shipmentId: shipment.ShipmentId },
          {
            $set: {
              shipmentStatus: shipment.ShipmentStatus,
              updatedAt: new Date()
            }
          }
        );

        if (['CLOSED', 'RECEIVING'].includes(shipment.ShipmentStatus)) {
          console.log(`[SellerInboundShipmentSync] Shipment ${shipment.ShipmentId} is now ${shipment.ShipmentStatus}`);
        }
      }

    } catch (error) {
      console.error('[SellerInboundShipmentSync] Error checking closed shipments:', error.message);
    }
  }

  /**
   * Get shipment items
   */
  async getShipmentItems(shipmentId) {
    await this.init();

    try {
      const spClient = await this.client.getClient();

      const response = await spClient.callAPI({
        operation: 'fulfillmentInbound.getShipmentItemsByShipmentId',
        path: { shipmentId },
        query: { MarketplaceId: getAllMarketplaceIds()[0] }
      });

      return response.ItemData || [];

    } catch (error) {
      console.error(`[SellerInboundShipmentSync] Error getting items for ${shipmentId}:`, error.message);
      return [];
    }
  }

  /**
   * Get detailed shipment info with items
   */
  async getShipmentDetails(shipmentId) {
    await this.init();

    const shipments = await this.getInboundShipments({
      shipmentIdList: [shipmentId]
    });

    if (shipments.length === 0) {
      return null;
    }

    const shipment = shipments[0];
    const items = await this.getShipmentItems(shipmentId);

    return {
      ...shipment,
      items
    };
  }

  /**
   * Update Odoo with shipment status (link to Odoo pickings if applicable)
   */
  async updateOdooShipmentStatus(shipmentId, status) {
    // Find related Odoo picking by shipment reference
    const pickings = await this.odoo.searchRead('stock.picking',
      [['origin', 'ilike', shipmentId]],
      ['id', 'name', 'state']
    );

    if (pickings.length > 0) {
      console.log(`[SellerInboundShipmentSync] Found Odoo picking ${pickings[0].name} for shipment ${shipmentId}`);

      // Add note about status update
      await this.odoo.execute('mail.message', 'create', [{
        model: 'stock.picking',
        res_id: pickings[0].id,
        body: `Amazon FBA Shipment Status: ${status}`,
        message_type: 'notification'
      }]);
    }
  }

  /**
   * Get sync statistics
   */
  async getStats() {
    await this.init();

    const statusCounts = await this.db.collection(INBOUND_SHIPMENTS_COLLECTION).aggregate([
      { $group: { _id: '$shipmentStatus', count: { $sum: 1 } } }
    ]).toArray();

    const byStatus = {};
    for (const s of statusCounts) {
      byStatus[s._id || 'Unknown'] = s.count;
    }

    const total = await this.db.collection(INBOUND_SHIPMENTS_COLLECTION).countDocuments({});

    return {
      total,
      byStatus,
      active: (byStatus.WORKING || 0) + (byStatus.SHIPPED || 0) + (byStatus.RECEIVING || 0) + (byStatus.IN_TRANSIT || 0)
    };
  }
}

// Singleton instance
let inboundShipmentSyncInstance = null;

/**
 * Get the singleton SellerInboundShipmentSync instance
 */
async function getSellerInboundShipmentSync() {
  if (!inboundShipmentSyncInstance) {
    inboundShipmentSyncInstance = new SellerInboundShipmentSync();
    await inboundShipmentSyncInstance.init();
  }
  return inboundShipmentSyncInstance;
}

module.exports = {
  SellerInboundShipmentSync,
  getSellerInboundShipmentSync,
  SHIPMENT_STATUSES
};
