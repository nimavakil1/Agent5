/**
 * VendorASNCreator - Create and Submit ASN (Advance Shipping Notice) to Amazon
 *
 * Handles shipment confirmation workflow for Vendor Central orders.
 * When an Odoo delivery is done, creates an ASN to notify Amazon.
 *
 * Flow:
 * 1. Get PO from MongoDB
 * 2. Get delivery (stock.picking) from Odoo
 * 3. Map delivery data to Amazon ASN format
 * 4. Submit to Amazon
 * 5. Track transaction status
 *
 * @module VendorASNCreator
 */

const { getDb } = require('../../../db');
const { VendorClient } = require('./VendorClient');
const { getVendorPOImporter } = require('./VendorPOImporter');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');

/**
 * Shipment types
 */
const SHIPMENT_TYPES = {
  TRUCK_LOAD: 'TruckLoad',
  LESS_THAN_TRUCK_LOAD: 'LessThanTruckLoad',
  SMALL_PARCEL: 'SmallParcel'
};

/**
 * Transportation methods
 */
const TRANSPORTATION_METHODS = {
  ROAD: 'Road',
  AIR: 'Air',
  OCEAN: 'Ocean',
  RAIL: 'Rail'
};

/**
 * ACROPAQ company info for shipFromParty
 */
const ACROPAQ_WAREHOUSE = {
  partyId: 'ACROPAQ_CW',
  address: {
    name: 'ACROPAQ BV - Central Warehouse',
    addressLine1: 'Patronaatstraat 79',
    city: 'Dendermonde',
    stateOrRegion: 'Oost-Vlaanderen',
    postalOrZipCode: '9200',
    countryCode: 'BE'
  }
};

/**
 * MongoDB collection for tracking shipments
 */
const SHIPMENT_COLLECTION = 'vendor_shipments';
const PO_COLLECTION = 'vendor_purchase_orders';

class VendorASNCreator {
  constructor(odooClient = null) {
    this.db = null;
    this.importer = null;
    this.odoo = odooClient || new OdooDirectClient();
    this.clients = {};
  }

  /**
   * Initialize the creator
   */
  async init() {
    this.db = getDb();
    this.importer = await getVendorPOImporter();

    // Authenticate with Odoo
    if (!this.odoo.authenticated) {
      await this.odoo.authenticate();
    }

    // Ensure indexes
    await this.ensureIndexes();

    return this;
  }

  /**
   * Ensure MongoDB indexes exist
   */
  async ensureIndexes() {
    const collection = this.db.collection(SHIPMENT_COLLECTION);
    await collection.createIndexes([
      { key: { shipmentId: 1 }, unique: true },
      { key: { purchaseOrderNumber: 1 } },
      { key: { odooPickingId: 1 } },
      { key: { status: 1 } },
      { key: { submittedAt: -1 } }
    ]);
  }

  /**
   * Get or create VendorClient for marketplace
   */
  getClient(marketplace) {
    if (!this.clients[marketplace]) {
      this.clients[marketplace] = new VendorClient(marketplace);
    }
    return this.clients[marketplace];
  }

  /**
   * Create and submit ASN for a PO
   * @param {string} poNumber - Purchase order number
   * @param {Object} options - Options
   * @param {number} options.odooPickingId - Specific Odoo picking ID (optional)
   * @param {boolean} options.dryRun - If true, don't actually submit
   */
  async submitASN(poNumber, options = {}) {
    const { odooPickingId, dryRun = false } = options;

    const result = {
      success: false,
      purchaseOrderNumber: poNumber,
      shipmentId: null,
      transactionId: null,
      errors: [],
      warnings: []
    };

    try {
      // Get PO from MongoDB
      const po = await this.importer.getPurchaseOrder(poNumber);
      if (!po) {
        result.errors.push(`PO not found: ${poNumber}`);
        return result;
      }

      // Check if PO has Odoo order linked
      if (!po.odoo?.saleOrderId) {
        result.errors.push('PO has no linked Odoo sale order');
        return result;
      }

      // Get delivery from Odoo
      const picking = await this._getDeliveryFromOdoo(po.odoo.saleOrderId, odooPickingId);
      if (!picking) {
        result.errors.push('No completed delivery found for this order');
        return result;
      }

      // Check if already submitted
      const existingShipment = await this.db.collection(SHIPMENT_COLLECTION).findOne({
        odooPickingId: picking.id
      });
      if (existingShipment) {
        result.warnings.push(`Shipment already submitted: ${existingShipment.shipmentId}`);
        result.shipmentId = existingShipment.shipmentId;
        result.success = true;
        return result;
      }

      // Build ASN payload
      const shipmentId = this._generateShipmentId(po, picking);
      const asnPayload = this._buildASNPayload(po, picking, shipmentId);

      if (dryRun) {
        result.success = true;
        result.shipmentId = shipmentId;
        result.dryRun = true;
        result.payload = asnPayload;
        return result;
      }

      // Submit to Amazon
      const client = this.getClient(po.marketplaceId);
      await client.init();

      const response = await client.submitShipmentConfirmations(asnPayload);

      // Store in MongoDB
      await this._saveShipment({
        shipmentId,
        purchaseOrderNumber: poNumber,
        marketplaceId: po.marketplaceId,
        odooPickingId: picking.id,
        odooPickingName: picking.name,
        transactionId: response.transactionId,
        status: 'submitted',
        submittedAt: new Date(),
        shipmentDate: new Date(picking.date_done || picking.scheduled_date),
        carrier: picking.carrier_id ? picking.carrier_id[1] : null,
        trackingNumber: picking.carrier_tracking_ref || null,
        items: asnPayload.shipmentConfirmations[0].shipmentItems
      });

      // Update PO with shipment info
      await this.db.collection(PO_COLLECTION).updateOne(
        { purchaseOrderNumber: poNumber },
        {
          $push: {
            shipments: {
              shipmentId,
              submittedAt: new Date(),
              odooPickingId: picking.id,
              trackingNumber: picking.carrier_tracking_ref || null
            }
          },
          $set: { updatedAt: new Date() }
        }
      );

      result.success = true;
      result.shipmentId = shipmentId;
      result.transactionId = response.transactionId;

    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Get delivery from Odoo for a sale order
   */
  async _getDeliveryFromOdoo(saleOrderId, specificPickingId = null) {
    // If specific picking requested
    if (specificPickingId) {
      const pickings = await this.odoo.searchRead('stock.picking',
        [['id', '=', specificPickingId]],
        ['id', 'name', 'state', 'date_done', 'scheduled_date', 'carrier_id', 'carrier_tracking_ref', 'move_ids_without_package'],
        { limit: 1 }
      );
      return pickings.length > 0 ? pickings[0] : null;
    }

    // Find outgoing deliveries for this sale order that are done
    const pickings = await this.odoo.searchRead('stock.picking',
      [
        ['sale_id', '=', saleOrderId],
        ['picking_type_code', '=', 'outgoing'],
        ['state', '=', 'done']
      ],
      ['id', 'name', 'state', 'date_done', 'scheduled_date', 'carrier_id', 'carrier_tracking_ref', 'move_ids_without_package'],
      { order: 'date_done desc', limit: 1 }
    );

    return pickings.length > 0 ? pickings[0] : null;
  }

  /**
   * Generate shipment ID
   */
  _generateShipmentId(po, picking) {
    const timestamp = Date.now().toString(36).toUpperCase();
    return `ASN-${po.purchaseOrderNumber}-${timestamp}`;
  }

  /**
   * Build ASN payload for Amazon
   */
  _buildASNPayload(po, picking, shipmentId) {
    const shipmentDate = picking.date_done || picking.scheduled_date || new Date().toISOString();

    // Build items from PO items (we ship what was acknowledged)
    const shipmentItems = po.items
      .filter(item => (item.acknowledgeQty || item.orderedQuantity?.amount) > 0)
      .map(item => ({
        itemSequenceNumber: item.itemSequenceNumber,
        amazonProductIdentifier: item.amazonProductIdentifier,
        vendorProductIdentifier: item.vendorProductIdentifier,
        shippedQuantity: {
          amount: item.acknowledgeQty || item.orderedQuantity?.amount || 0,
          unitOfMeasure: item.orderedQuantity?.unitOfMeasure || 'Each'
        }
      }));

    return {
      shipmentConfirmations: [{
        shipmentIdentifier: shipmentId,
        shipmentConfirmationType: 'Original',
        shipmentType: SHIPMENT_TYPES.SMALL_PARCEL,
        shipmentStructure: 'PalletizedAssortmentCase',
        transportationDetails: {
          carrierScac: picking.carrier_id ? 'OTHR' : null,
          carrierShipmentReferenceNumber: picking.carrier_tracking_ref || null,
          transportationMode: TRANSPORTATION_METHODS.ROAD
        },
        amazonReferenceNumber: po.purchaseOrderNumber,
        shipmentDate: new Date(shipmentDate).toISOString(),
        shippedDate: new Date(shipmentDate).toISOString(),
        estimatedDeliveryDate: po.deliveryWindow?.endDate
          ? new Date(po.deliveryWindow.endDate).toISOString()
          : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        sellingParty: {
          partyId: ACROPAQ_WAREHOUSE.partyId,
          address: ACROPAQ_WAREHOUSE.address
        },
        shipFromParty: {
          partyId: ACROPAQ_WAREHOUSE.partyId,
          address: ACROPAQ_WAREHOUSE.address
        },
        shipToParty: po.shipToParty || {
          partyId: 'AMAZON',
          address: {
            name: 'Amazon Fulfillment Center',
            countryCode: po.marketplaceId === 'UK' ? 'GB' : po.marketplaceId
          }
        },
        shipmentItems
      }]
    };
  }

  /**
   * Save shipment to MongoDB
   */
  async _saveShipment(shipment) {
    const collection = this.db.collection(SHIPMENT_COLLECTION);
    await collection.insertOne({
      ...shipment,
      createdAt: new Date()
    });
  }

  /**
   * Get shipments from MongoDB
   */
  async getShipments(filters = {}, options = {}) {
    const collection = this.db.collection(SHIPMENT_COLLECTION);

    const query = {};
    if (filters.purchaseOrderNumber) query.purchaseOrderNumber = filters.purchaseOrderNumber;
    if (filters.status) query.status = filters.status;
    if (filters.marketplaceId) query.marketplaceId = filters.marketplaceId;

    const cursor = collection.find(query);

    if (options.sort) {
      cursor.sort(options.sort);
    } else {
      cursor.sort({ submittedAt: -1 });
    }

    if (options.limit) cursor.limit(options.limit);
    if (options.skip) cursor.skip(options.skip);

    return cursor.toArray();
  }

  /**
   * Get shipment by ID
   */
  async getShipment(shipmentId) {
    const collection = this.db.collection(SHIPMENT_COLLECTION);
    return collection.findOne({ shipmentId });
  }

  /**
   * Check transaction status with Amazon
   */
  async checkTransactionStatus(shipmentId) {
    const shipment = await this.getShipment(shipmentId);
    if (!shipment || !shipment.transactionId) {
      return { error: 'Shipment or transaction not found' };
    }

    try {
      const client = this.getClient(shipment.marketplaceId);
      await client.init();

      const status = await client.getTransactionStatus(shipment.transactionId);

      // Update status in MongoDB if changed
      if (status.transactionStatus) {
        await this.db.collection(SHIPMENT_COLLECTION).updateOne(
          { shipmentId },
          {
            $set: {
              amazonStatus: status.transactionStatus,
              lastStatusCheck: new Date(),
              statusDetails: status
            }
          }
        );
      }

      return status;
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Find POs ready to ship (acknowledged but no ASN sent)
   */
  async findPOsReadyToShip() {
    const poCollection = this.db.collection(PO_COLLECTION);

    return poCollection.find({
      purchaseOrderState: 'Acknowledged',
      'acknowledgment.acknowledged': true,
      'odoo.saleOrderId': { $ne: null },
      shipmentStatus: { $nin: ['fully_shipped', 'cancelled'] },
      $or: [
        { shipments: { $size: 0 } },
        { shipments: { $exists: false } }
      ]
    }).toArray();
  }

  /**
   * Auto-submit ASNs for all ready POs
   */
  async autoSubmitASNs(dryRun = false) {
    const readyPOs = await this.findPOsReadyToShip();
    const results = [];

    for (const po of readyPOs) {
      const result = await this.submitASN(po.purchaseOrderNumber, { dryRun });
      results.push(result);
    }

    return {
      total: readyPOs.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    };
  }
}

// Singleton instance
let asnCreatorInstance = null;

async function getVendorASNCreator() {
  if (!asnCreatorInstance) {
    asnCreatorInstance = new VendorASNCreator();
    await asnCreatorInstance.init();
  }
  return asnCreatorInstance;
}

module.exports = {
  VendorASNCreator,
  getVendorASNCreator,
  SHIPMENT_TYPES,
  TRANSPORTATION_METHODS
};
