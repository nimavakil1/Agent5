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
const { isTestMode, wrapWithTestMode } = require('./TestMode');

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
   * Wraps with test mode support when enabled
   */
  getClient(marketplace) {
    const cacheKey = `${marketplace}_${isTestMode() ? 'test' : 'prod'}`;
    if (!this.clients[cacheKey]) {
      const client = new VendorClient(marketplace);
      this.clients[cacheKey] = wrapWithTestMode(client);
    }
    return this.clients[cacheKey];
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

      // Check if PO has Odoo order linked (skip for test mode)
      let picking = null;

      if (isTestMode() && po._testData) {
        // TEST MODE: Generate mock delivery for test POs
        picking = this._generateMockDelivery(po);
        result.warnings.push('TEST MODE: Using mock Odoo delivery');
        console.log(`[VendorASNCreator] TEST MODE: Generated mock delivery for PO ${poNumber}`);
      } else {
        if (!po.odoo?.saleOrderId) {
          result.errors.push('PO has no linked Odoo sale order');
          return result;
        }

        // Get delivery from Odoo
        picking = await this._getDeliveryFromOdoo(po.odoo.saleOrderId, odooPickingId);
        if (!picking) {
          result.errors.push('No completed delivery found for this order');
          return result;
        }
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
      const marketplace = po.amazonVendor?.marketplaceId || po.marketplaceId || 'FR';
      const client = this.getClient(marketplace);
      await client.init();

      const response = await client.submitShipmentConfirmations(asnPayload);

      // Store in MongoDB
      await this._saveShipment({
        shipmentId,
        purchaseOrderNumber: poNumber,
        marketplaceId: marketplace,
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
  _generateShipmentId(po, _picking) {
    const timestamp = Date.now().toString(36).toUpperCase();
    // Support unified schema (sourceIds) and legacy (purchaseOrderNumber)
    const poNum = po.sourceIds?.amazonVendorPONumber || po.purchaseOrderNumber;
    return `ASN-${poNum}-${timestamp}`;
  }

  /**
   * Build ASN payload for Amazon (legacy - item level only)
   * Uses the correct Amazon Vendor Shipments API schema
   */
  _buildASNPayload(po, picking, shipmentId) {
    const shipmentDate = picking.date_done || picking.scheduled_date || new Date().toISOString();

    // Build items from PO items (we ship what was acknowledged)
    // NOTE: Field is "shippedItems" not "shipmentItems" per Amazon API
    const shippedItems = po.items
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

    // Amazon Vendor Shipments API expected fields:
    // shipmentIdentifier, shipmentConfirmationType, shipmentType, shipmentConfirmationDate,
    // shippedDate, estimatedDeliveryDate, sellingParty, shipFromParty, shipToParty,
    // shipmentMeasurements, importDetails, shippedItems, cartons, pallets
    return {
      shipmentConfirmations: [{
        shipmentIdentifier: shipmentId,
        shipmentConfirmationType: 'Original',
        shipmentType: SHIPMENT_TYPES.SMALL_PARCEL,
        shipmentConfirmationDate: new Date(shipmentDate).toISOString(),
        shippedDate: new Date(shipmentDate).toISOString(),
        estimatedDeliveryDate: (po.amazonVendor?.deliveryWindow?.endDate || po.deliveryWindow?.endDate)
          ? new Date(po.amazonVendor?.deliveryWindow?.endDate || po.deliveryWindow?.endDate).toISOString()
          : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        sellingParty: {
          partyId: ACROPAQ_WAREHOUSE.partyId,
          address: ACROPAQ_WAREHOUSE.address
        },
        shipFromParty: {
          partyId: ACROPAQ_WAREHOUSE.partyId,
          address: ACROPAQ_WAREHOUSE.address
        },
        shipToParty: po.amazonVendor?.shipToParty || po.shipToParty || {
          partyId: 'AMAZON'
        },
        shippedItems
      }]
    };
  }

  /**
   * Build ASN payload with carton-level SSCCs
   *
   * Uses Amazon Vendor Shipments API schema:
   * shipmentIdentifier, shipmentConfirmationType, shipmentType, shipmentConfirmationDate,
   * shippedDate, estimatedDeliveryDate, sellingParty, shipFromParty, shipToParty,
   * shipmentMeasurements, importDetails, shippedItems, cartons, pallets
   *
   * @param {Object} po - Purchase order
   * @param {Object} picking - Odoo picking
   * @param {string} shipmentId - Shipment identifier
   * @param {Object} packingData - Carton/pallet packing data from UI
   * @param {Array} packingData.cartons - Array of carton objects with SSCC and items
   * @param {Array} packingData.pallets - Array of pallet objects with SSCC and carton SSCCs
   */
  _buildASNPayloadWithSSCC(po, picking, shipmentId, packingData = {}) {
    const shipmentDate = picking.date_done || picking.scheduled_date || new Date().toISOString();
    const { cartons = [], pallets = [] } = packingData;

    console.log(`[VendorASNCreator] _buildASNPayloadWithSSCC: ${cartons.length} cartons, ${pallets.length} pallets`);
    console.log(`[VendorASNCreator] PO items (${po.items?.length || 0}):`, po.items?.map(i => ({
      vendorProductIdentifier: i.vendorProductIdentifier,
      amazonProductIdentifier: i.amazonProductIdentifier,
      itemSequenceNumber: i.itemSequenceNumber
    })));

    // If no cartons provided, fall back to legacy format
    if (cartons.length === 0) {
      console.log(`[VendorASNCreator] No cartons provided, falling back to legacy format`);
      return this._buildASNPayload(po, picking, shipmentId);
    }

    // Build itemSequenceNumber map for proper itemReference values
    const itemSequenceMap = {};
    po.items.forEach(pi => {
      if (pi.vendorProductIdentifier) itemSequenceMap[pi.vendorProductIdentifier] = pi.itemSequenceNumber;
      if (pi.amazonProductIdentifier) itemSequenceMap[pi.amazonProductIdentifier] = pi.itemSequenceNumber;
    });

    // Build carton structures with SSCC - at root level per Amazon API
    const cartonData = cartons.map((carton, idx) => ({
      cartonIdentifiers: [carton.sscc], // SSCC-18 in array
      cartonSequenceNumber: String(idx + 1),
      items: carton.items.map((item) => {
        // Find matching PO item
        const poItem = po.items.find(
          pi => pi.vendorProductIdentifier === item.ean ||
                pi.amazonProductIdentifier === item.asin
        );
        if (!poItem) {
          console.warn(`[VendorASNCreator] No matching PO item for carton item: ean=${item.ean}, asin=${item.asin}, sku=${item.sku}`);
        } else {
          console.log(`[VendorASNCreator] Matched carton item ean=${item.ean} to PO item vendorProductIdentifier=${poItem.vendorProductIdentifier}`);
        }
        // itemReference must match the itemSequenceNumber from shippedItems
        const itemRef = itemSequenceMap[item.ean] || itemSequenceMap[item.asin] || poItem?.itemSequenceNumber || '1';
        return {
          itemReference: itemRef,
          shippedQuantity: {
            amount: item.quantity,
            unitOfMeasure: 'Each'
          }
        };
      })
    }));

    // Build pallet structures if any - at root level per Amazon API
    let palletData = null;
    if (pallets.length > 0) {
      palletData = pallets.map((pallet, idx) => ({
        palletIdentifiers: [pallet.sscc], // SSCC-18 in array
        tier: String(idx + 1),
        block: '1',
        cartonReferenceDetails: pallet.cartonSSCCs.map(sscc => {
          const cartonIdx = cartons.findIndex(c => c.sscc === sscc);
          return {
            cartonSequenceNumber: String(cartonIdx + 1)
          };
        })
      }));
    }

    // Calculate total shipped items for shippedItems array (NOT shipmentItems)
    const shippedItems = [];
    const itemTotals = {};

    cartons.forEach(carton => {
      carton.items.forEach(item => {
        const key = item.ean || item.asin;
        if (!itemTotals[key]) {
          const poItem = po.items.find(
            pi => pi.vendorProductIdentifier === item.ean ||
                  pi.amazonProductIdentifier === item.asin
          );
          itemTotals[key] = {
            itemSequenceNumber: poItem?.itemSequenceNumber || '1',
            amazonProductIdentifier: item.asin || poItem?.amazonProductIdentifier,
            vendorProductIdentifier: item.ean || poItem?.vendorProductIdentifier,
            shippedQuantity: {
              amount: 0,
              unitOfMeasure: 'Each'
            }
          };
        }
        itemTotals[key].shippedQuantity.amount += item.quantity;
      });
    });

    Object.values(itemTotals).forEach(item => shippedItems.push(item));

    // Build confirmation with correct Amazon API field names
    const confirmation = {
      shipmentIdentifier: shipmentId,
      shipmentConfirmationType: 'Original',
      shipmentType: pallets.length > 0 ? SHIPMENT_TYPES.LESS_THAN_TRUCK_LOAD : SHIPMENT_TYPES.SMALL_PARCEL,
      shipmentConfirmationDate: new Date(shipmentDate).toISOString(),
      shippedDate: new Date(shipmentDate).toISOString(),
      estimatedDeliveryDate: (po.amazonVendor?.deliveryWindow?.endDate || po.deliveryWindow?.endDate)
        ? new Date(po.amazonVendor?.deliveryWindow?.endDate || po.deliveryWindow?.endDate).toISOString()
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      sellingParty: {
        partyId: ACROPAQ_WAREHOUSE.partyId,
        address: ACROPAQ_WAREHOUSE.address
      },
      shipFromParty: {
        partyId: ACROPAQ_WAREHOUSE.partyId,
        address: ACROPAQ_WAREHOUSE.address
      },
      shipToParty: po.amazonVendor?.shipToParty || po.shipToParty || {
        partyId: 'AMAZON'
      },
      shippedItems,
      cartons: cartonData
    };

    // Add pallet data if present - at root level
    if (palletData) {
      confirmation.pallets = palletData;
    }

    return {
      shipmentConfirmations: [confirmation]
    };
  }

  /**
   * Submit ASN with carton-level SSCC data
   * @param {string} poNumber - Purchase order number
   * @param {Object} packingData - Carton/pallet data from UI
   * @param {Object} options - Additional options
   */
  async submitASNWithSSCC(poNumber, packingData, options = {}) {
    const { odooPickingId, dryRun = false } = options;

    const result = {
      success: false,
      purchaseOrderNumber: poNumber,
      shipmentId: null,
      transactionId: null,
      cartonCount: packingData.cartons?.length || 0,
      palletCount: packingData.pallets?.length || 0,
      errors: [],
      warnings: []
    };

    console.log(`[VendorASNCreator] submitASNWithSSCC called for PO: ${poNumber}`);
    console.log(`[VendorASNCreator]   cartons: ${packingData.cartons?.length || 0}, pallets: ${packingData.pallets?.length || 0}`);

    try {
      // Get PO from MongoDB
      console.log(`[VendorASNCreator] Fetching PO from MongoDB...`);
      const po = await this.importer.getPurchaseOrder(poNumber);
      if (!po) {
        console.error(`[VendorASNCreator] PO not found in MongoDB: ${poNumber}`);
        result.errors.push(`PO not found: ${poNumber}`);
        return result;
      }
      console.log(`[VendorASNCreator] PO found: marketplaceId=${po.marketplaceId}, odoo.saleOrderId=${po.odoo?.saleOrderId}`);

      // Get delivery from Odoo (optional - may not have Odoo order)
      let picking = null;
      if (po.odoo?.saleOrderId) {
        console.log(`[VendorASNCreator] Fetching Odoo delivery for saleOrderId: ${po.odoo.saleOrderId}`);
        picking = await this._getDeliveryFromOdoo(po.odoo.saleOrderId, odooPickingId);
        if (picking) {
          console.log(`[VendorASNCreator] Odoo picking found: ${picking.name} (id: ${picking.id})`);
        }
      }

      // Create a mock picking if none exists
      if (!picking) {
        console.log(`[VendorASNCreator] No Odoo picking found, using manual shipment date`);
        picking = {
          id: null,
          name: 'MANUAL',
          date_done: new Date().toISOString(),
          scheduled_date: new Date().toISOString()
        };
        result.warnings.push('No Odoo delivery found - using manual shipment date');
      }

      // Generate shipment ID
      const shipmentId = this._generateShipmentId(po, picking);
      console.log(`[VendorASNCreator] Generated shipmentId: ${shipmentId}`);

      // Build ASN payload with SSCCs
      console.log(`[VendorASNCreator] Building ASN payload...`);
      const asnPayload = this._buildASNPayloadWithSSCC(po, picking, shipmentId, packingData);
      console.log(`[VendorASNCreator] ASN payload built. Items: ${asnPayload.shipmentConfirmations?.[0]?.shipmentItems?.length || 0}`);

      if (dryRun) {
        console.log(`[VendorASNCreator] Dry run - not submitting to Amazon`);
        result.success = true;
        result.shipmentId = shipmentId;
        result.dryRun = true;
        result.payload = asnPayload;
        return result;
      }

      // Submit to Amazon
      const marketplace = po.amazonVendor?.marketplaceId || po.marketplaceId || 'FR';
      console.log(`[VendorASNCreator] Getting vendor client for marketplace: ${marketplace}`);
      const client = this.getClient(marketplace);
      await client.init();

      console.log(`[VendorASNCreator] Submitting ASN to Amazon Vendor Central...`);
      console.log(`[VendorASNCreator] Payload:`, JSON.stringify(asnPayload, null, 2));
      const response = await client.submitShipmentConfirmations(asnPayload);
      console.log(`[VendorASNCreator] Amazon response:`, JSON.stringify(response));

      // Store in MongoDB
      await this._saveShipment({
        shipmentId,
        purchaseOrderNumber: poNumber,
        marketplaceId: marketplace,
        odooPickingId: picking.id,
        odooPickingName: picking.name,
        transactionId: response.transactionId,
        status: 'submitted',
        submittedAt: new Date(),
        shipmentDate: new Date(picking.date_done || picking.scheduled_date),
        carrier: picking.carrier_id ? picking.carrier_id[1] : null,
        trackingNumber: picking.carrier_tracking_ref || null,
        cartons: packingData.cartons?.map(c => ({
          sscc: c.sscc,
          itemCount: c.items?.length || 0,
          totalUnits: c.items?.reduce((sum, i) => sum + (i.quantity || 0), 0) || 0
        })) || [],
        pallets: packingData.pallets?.map(p => ({
          sscc: p.sscc,
          cartonCount: p.cartonSSCCs?.length || 0
        })) || [],
        items: asnPayload.shipmentConfirmations[0].shipmentItems
      });

      // Update PO
      await this.db.collection(PO_COLLECTION).updateOne(
        { purchaseOrderNumber: poNumber },
        {
          $push: {
            shipments: {
              shipmentId,
              submittedAt: new Date(),
              odooPickingId: picking.id,
              cartonCount: packingData.cartons?.length || 0,
              palletCount: packingData.pallets?.length || 0
            }
          },
          $set: {
            shipmentStatus: 'shipped',
            updatedAt: new Date()
          }
        }
      );

      result.success = true;
      result.shipmentId = shipmentId;
      result.transactionId = response.transactionId;
      console.log(`[VendorASNCreator] ASN submitted successfully! transactionId: ${response.transactionId}`);

    } catch (error) {
      console.error(`[VendorASNCreator] ASN submission failed for ${poNumber}:`, error.message);
      console.error(`[VendorASNCreator] Error stack:`, error.stack);
      result.errors.push(error.message);
    }

    return result;
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
      const poNum = po.sourceIds?.amazonVendorPONumber || po.purchaseOrderNumber;
      const result = await this.submitASN(poNum, { dryRun });
      results.push(result);
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    // Record sync run for tracking health monitoring
    try {
      const { recordSyncRun } = require('../../alerts/TrackingAlertService');
      recordSyncRun('amazonVendor', failed === 0 || readyPOs.length === 0, {
        total: readyPOs.length,
        successful,
        failed
      });
    } catch (_) {
      // TrackingAlertService may not be initialized yet
    }

    return {
      total: readyPOs.length,
      successful,
      failed,
      results
    };
  }

  /**
   * Generate mock Odoo delivery for test mode
   * @param {Object} po - Purchase order
   * @returns {Object} Mock picking matching Odoo format
   */
  _generateMockDelivery(po) {
    const mockPickingId = 700000 + Math.floor(Math.random() * 100000);
    const now = new Date();

    // Build mock move lines from PO items
    const moveLines = (po.items || []).map((item, idx) => ({
      id: mockPickingId * 100 + idx,
      product_id: [item.odooProductId || 2000 + idx, item.vendorProductIdentifier || 'TEST-PRODUCT'],
      product_uom_qty: item.acknowledgeQty ?? item.orderedQuantity?.amount ?? 1,
      quantity_done: item.acknowledgeQty ?? item.orderedQuantity?.amount ?? 1,
      state: 'done'
    }));

    const poNum = po.sourceIds?.amazonVendorPONumber || po.purchaseOrderNumber;
    return {
      id: mockPickingId,
      name: `TEST-WH/OUT/${poNum}`,
      state: 'done',
      date_done: now.toISOString(),
      scheduled_date: now.toISOString(),
      carrier_id: [1, 'Test Carrier'],
      carrier_tracking_ref: `TEST-TRACK-${poNum}`,
      move_line_ids: moveLines.map(ml => ml.id),
      move_lines: moveLines,
      _testMode: true,
      _mockResponse: true
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
