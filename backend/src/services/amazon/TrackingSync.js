/**
 * Tracking Sync Service
 *
 * Syncs shipment tracking information from Odoo to Amazon for FBM orders.
 * Generates feed data to update Amazon with carrier and tracking info.
 *
 * Flow: Odoo Shipments → Agent5 → Amazon (via Make.com webhook or feed upload)
 */

const { getDb } = require('../../db');

// Common carrier codes mapping (Odoo carrier name → Amazon carrier code)
const CARRIER_MAPPING = {
  // Belgium carriers
  'bpost': 'B Post',
  'bpost international': 'B Post',
  'dhl': 'DHL',
  'dhl express': 'DHL Express',
  'dhl parcel': 'DHL',
  'dpd': 'DPD',
  'gls': 'GLS',
  'fedex': 'FedEx',
  'ups': 'UPS',
  'tnt': 'TNT',
  'postnl': 'PostNL',
  'chronopost': 'Chronopost',
  'colissimo': 'Colissimo',
  'mondial relay': 'Mondial Relay',
  'hermes': 'Hermes',
  'royal mail': 'Royal Mail',
  'deutsche post': 'Deutsche Post',
  // Generic
  'other': 'Other',
};

// Amazon order fulfillment feed template
const FEED_HEADER = `<?xml version="1.0" encoding="utf-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.01</DocumentVersion>
    <MerchantIdentifier>{{MERCHANT_ID}}</MerchantIdentifier>
  </Header>
  <MessageType>OrderFulfillment</MessageType>`;

const FEED_FOOTER = `</AmazonEnvelope>`;

class TrackingSync {
  constructor(odooClient, options = {}) {
    this.odoo = odooClient;
    this.merchantId = options.merchantId || process.env.AMAZON_MERCHANT_ID || '';
    this.syncedTrackings = new Set(); // Track already synced
  }

  /**
   * Get shipments from Odoo that need tracking sync
   * @param {object} options
   * @param {string} options.since - Only shipments since this date
   * @param {string[]} options.amazonOrderIds - Specific orders to sync
   * @param {number} options.limit - Max shipments to return
   * @returns {Array} Shipments with tracking info
   */
  async getShipmentsToSync(options = {}) {
    const { since, amazonOrderIds, limit = 100 } = options;

    try {
      // Build domain for stock.picking (shipments)
      const domain = [
        ['state', '=', 'done'], // Only completed shipments
        ['picking_type_code', '=', 'outgoing'], // Only outgoing deliveries
        ['carrier_tracking_ref', '!=', false], // Has tracking number
      ];

      if (since) {
        domain.push(['date_done', '>=', since]);
      }

      // Get shipments from Odoo
      const pickings = await this.odoo.searchRead('stock.picking',
        domain,
        [
          'id', 'name', 'carrier_tracking_ref', 'carrier_id',
          'date_done', 'sale_id', 'origin', 'partner_id'
        ],
        { limit }
      );

      const shipments = [];

      for (const picking of pickings) {
        // Get Amazon order ID from sale order
        const amazonOrderId = await this.getAmazonOrderId(picking);
        if (!amazonOrderId) continue;

        // Filter by specific Amazon orders if provided
        if (amazonOrderIds && !amazonOrderIds.includes(amazonOrderId)) {
          continue;
        }

        // Skip if already synced
        const syncKey = `${amazonOrderId}:${picking.carrier_tracking_ref}`;
        if (this.syncedTrackings.has(syncKey)) {
          continue;
        }

        // Get carrier name
        const carrierName = picking.carrier_id?.[1] || '';
        const carrierCode = this.mapCarrierCode(carrierName);

        // Get shipped items
        const items = await this.getShippedItems(picking.id);

        shipments.push({
          odooPickingId: picking.id,
          odooPickingName: picking.name,
          amazonOrderId,
          trackingNumber: picking.carrier_tracking_ref,
          carrierCode,
          carrierName,
          shipDate: picking.date_done,
          items,
          syncKey,
        });
      }

      return shipments;

    } catch (error) {
      console.error('[TrackingSync] Error getting shipments:', error);
      throw error;
    }
  }

  /**
   * Get Amazon Order ID from Odoo picking
   * @param {object} picking
   * @returns {string|null}
   */
  async getAmazonOrderId(picking) {
    try {
      // Check if origin contains Amazon order ID pattern
      const origin = picking.origin || '';
      const amazonPattern = /\d{3}-\d{7}-\d{7}/;
      const match = origin.match(amazonPattern);
      if (match) {
        return match[0];
      }

      // Try to get from sale order
      if (picking.sale_id?.[0]) {
        const saleOrders = await this.odoo.searchRead('sale.order',
          [['id', '=', picking.sale_id[0]]],
          ['name', 'client_order_ref', 'origin']
        );

        if (saleOrders.length > 0) {
          const so = saleOrders[0];
          // Check client_order_ref (often contains Amazon order ID)
          if (so.client_order_ref) {
            const refMatch = so.client_order_ref.match(amazonPattern);
            if (refMatch) return refMatch[0];
          }
          // Check name
          const nameMatch = so.name?.match(amazonPattern);
          if (nameMatch) return nameMatch[0];
          // Check origin
          const originMatch = so.origin?.match(amazonPattern);
          if (originMatch) return originMatch[0];
        }
      }

      return null;

    } catch (error) {
      console.error('[TrackingSync] Error getting Amazon order ID:', error);
      return null;
    }
  }

  /**
   * Get shipped items from picking
   * @param {number} pickingId
   * @returns {Array}
   */
  async getShippedItems(pickingId) {
    try {
      const moves = await this.odoo.searchRead('stock.move',
        [['picking_id', '=', pickingId], ['state', '=', 'done']],
        ['product_id', 'product_uom_qty', 'quantity_done']
      );

      const items = [];
      for (const move of moves) {
        if (move.product_id) {
          const products = await this.odoo.searchRead('product.product',
            [['id', '=', move.product_id[0]]],
            ['default_code']
          );

          if (products.length > 0 && products[0].default_code) {
            items.push({
              sku: products[0].default_code,
              quantity: Math.floor(move.quantity_done || move.product_uom_qty || 1),
            });
          }
        }
      }

      return items;

    } catch (error) {
      console.error('[TrackingSync] Error getting shipped items:', error);
      return [];
    }
  }

  /**
   * Map Odoo carrier name to Amazon carrier code
   * @param {string} carrierName
   * @returns {string}
   */
  mapCarrierCode(carrierName) {
    if (!carrierName) return 'Other';

    const normalized = carrierName.toLowerCase().trim();

    // Check exact matches first
    if (CARRIER_MAPPING[normalized]) {
      return CARRIER_MAPPING[normalized];
    }

    // Check partial matches
    for (const [key, value] of Object.entries(CARRIER_MAPPING)) {
      if (normalized.includes(key)) {
        return value;
      }
    }

    return 'Other';
  }

  /**
   * Generate Amazon order fulfillment feed XML
   * @param {Array} shipments
   * @returns {string}
   */
  generateFeedXml(shipments) {
    let xml = FEED_HEADER.replace('{{MERCHANT_ID}}', this.merchantId);

    let messageId = 1;
    for (const shipment of shipments) {
      xml += `
  <Message>
    <MessageID>${messageId++}</MessageID>
    <OrderFulfillment>
      <AmazonOrderID>${this.escapeXml(shipment.amazonOrderId)}</AmazonOrderID>
      <FulfillmentDate>${this.formatDate(shipment.shipDate)}</FulfillmentDate>
      <FulfillmentData>
        <CarrierCode>${this.escapeXml(shipment.carrierCode)}</CarrierCode>
        <ShippingMethod>Standard</ShippingMethod>
        <ShipperTrackingNumber>${this.escapeXml(shipment.trackingNumber)}</ShipperTrackingNumber>
      </FulfillmentData>`;

      // Add items if available
      if (shipment.items && shipment.items.length > 0) {
        for (const item of shipment.items) {
          xml += `
      <Item>
        <MerchantSKU>${this.escapeXml(item.sku)}</MerchantSKU>
        <Quantity>${item.quantity}</Quantity>
      </Item>`;
        }
      }

      xml += `
    </OrderFulfillment>
  </Message>`;
    }

    xml += '\n' + FEED_FOOTER;
    return xml;
  }

  /**
   * Generate JSON payload for Make.com webhook
   * @param {Array} shipments
   * @returns {object}
   */
  generateWebhookPayload(shipments) {
    return {
      feedType: 'POST_ORDER_FULFILLMENT_DATA',
      timestamp: new Date().toISOString(),
      shipmentCount: shipments.length,
      shipments: shipments.map(s => ({
        amazonOrderId: s.amazonOrderId,
        trackingNumber: s.trackingNumber,
        carrierCode: s.carrierCode,
        carrierName: s.carrierName,
        shipDate: s.shipDate,
        items: s.items
      }))
    };
  }

  /**
   * Sync tracking to Amazon via webhook
   * @param {object} options
   * @param {string} options.webhookUrl - Make.com webhook URL
   * @param {string} options.since - Only shipments since this date
   * @param {string[]} options.amazonOrderIds - Specific orders
   * @returns {object}
   */
  async syncToWebhook(options = {}) {
    const { webhookUrl, since, amazonOrderIds } = options;

    if (!webhookUrl) {
      throw new Error('webhookUrl is required');
    }

    const result = {
      success: false,
      timestamp: new Date().toISOString(),
      shipmentsSynced: 0,
      errors: [],
    };

    try {
      // Get shipments from Odoo
      const shipments = await this.getShipmentsToSync({ since, amazonOrderIds });

      if (shipments.length === 0) {
        result.success = true;
        result.message = 'No shipments to sync';
        return result;
      }

      // Generate payload
      const payload = this.generateWebhookPayload(shipments);

      // Send to webhook
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}: ${await response.text()}`);
      }

      // Mark as synced
      for (const shipment of shipments) {
        this.syncedTrackings.add(shipment.syncKey);
      }

      // Store sync record
      await this.recordSync(shipments, true);

      result.success = true;
      result.shipmentsSynced = shipments.length;
      result.webhookResponse = await response.json().catch(() => null);

    } catch (error) {
      result.errors.push(error.message);
      console.error('[TrackingSync] Webhook sync error:', error);
    }

    return result;
  }

  /**
   * Queue tracking sync for later processing
   * @param {object} options
   * @returns {object}
   */
  async queueSync(options = {}) {
    const shipments = await this.getShipmentsToSync(options);

    if (shipments.length === 0) {
      return { queued: 0, message: 'No shipments to queue' };
    }

    const db = getDb();

    const doc = {
      status: 'pending',
      createdAt: new Date(),
      shipmentCount: shipments.length,
      shipments: shipments.map(s => ({
        amazonOrderId: s.amazonOrderId,
        trackingNumber: s.trackingNumber,
        carrierCode: s.carrierCode,
        odooPickingName: s.odooPickingName,
        items: s.items,
      })),
      feedXml: this.generateFeedXml(shipments),
    };

    const result = await db.collection('amazon_tracking_sync_queue').insertOne(doc);

    return {
      queued: shipments.length,
      queueId: result.insertedId.toString(),
    };
  }

  /**
   * Record sync in database
   * @param {Array} shipments
   * @param {boolean} success
   */
  async recordSync(shipments, success) {
    try {
      const db = getDb();

      await db.collection('amazon_tracking_syncs').insertOne({
        syncedAt: new Date(),
        success,
        shipmentCount: shipments.length,
        amazonOrderIds: shipments.map(s => s.amazonOrderId),
        trackingNumbers: shipments.map(s => s.trackingNumber),
      });

    } catch (error) {
      console.error('[TrackingSync] Error recording sync:', error);
    }
  }

  /**
   * Get pending tracking sync queue
   * @returns {Array}
   */
  async getPendingQueue() {
    const db = getDb();
    return db.collection('amazon_tracking_sync_queue')
      .find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .toArray();
  }

  /**
   * Mark queue item as processed
   * @param {string} queueId
   * @param {object} result
   */
  async markQueueProcessed(queueId, result) {
    const db = getDb();
    const { ObjectId } = require('mongodb');

    await db.collection('amazon_tracking_sync_queue').updateOne(
      { _id: new ObjectId(queueId) },
      {
        $set: {
          status: result.success ? 'completed' : 'failed',
          processedAt: new Date(),
          result,
        }
      }
    );
  }

  /**
   * Get tracking sync history
   * @param {number} limit
   * @returns {Array}
   */
  async getSyncHistory(limit = 20) {
    const db = getDb();
    return db.collection('amazon_tracking_syncs')
      .find({})
      .sort({ syncedAt: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Get orders pending tracking confirmation
   * @returns {Array}
   */
  async getPendingOrders() {
    const db = getDb();

    // Get Amazon orders that are shipped but not confirmed
    const orders = await db.collection('amazon_orders')
      .find({
        orderStatus: { $in: ['Shipped', 'Unshipped'] },
        fulfillmentChannel: 'MFN', // Merchant fulfilled
        'trackingSync.synced': { $ne: true }
      })
      .project({
        amazonOrderId: 1,
        purchaseDate: 1,
        orderStatus: 1,
        'orderItems.SellerSKU': 1,
      })
      .sort({ purchaseDate: -1 })
      .limit(100)
      .toArray();

    return orders;
  }

  /**
   * Format date for Amazon feed
   * @param {Date|string} date
   * @returns {string}
   */
  formatDate(date) {
    const d = new Date(date);
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * Escape XML special characters
   * @param {string} str
   * @returns {string}
   */
  escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Clear sync tracking cache
   */
  clearCache() {
    this.syncedTrackings.clear();
  }
}

module.exports = { TrackingSync, CARRIER_MAPPING };
