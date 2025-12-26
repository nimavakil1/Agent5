/**
 * SellerFulfillmentSync - Sync Fulfillment Centers and MCF Orders
 *
 * Handles:
 * 1. Sync Amazon Fulfillment Centers
 * 2. Create MCF (Multi-Channel Fulfillment) outbound orders
 *
 * @module SellerFulfillmentSync
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { getAllMarketplaceIds } = require('./SellerMarketplaceConfig');

// Collections
const FULFILLMENT_CENTERS_COLLECTION = 'seller_fulfillment_centers';
const MCF_ORDERS_COLLECTION = 'seller_mcf_orders';

/**
 * SellerFulfillmentSync - Syncs FCs and MCF orders
 */
class SellerFulfillmentSync {
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
  }

  // ==================== FULFILLMENT CENTERS ====================

  /**
   * Sync fulfillment centers from Amazon
   * Note: There's no direct API for this; we extract from shipment data
   */
  async syncFulfillmentCenters() {
    await this.init();

    const result = {
      synced: 0,
      errors: []
    };

    try {
      // Known EU fulfillment centers (from Amazon documentation)
      const knownFCs = [
        // France
        { id: 'LYS1', name: 'Lyon FC', country: 'FR', region: 'Europe' },
        { id: 'ORY1', name: 'Paris FC 1', country: 'FR', region: 'Europe' },
        { id: 'ORY2', name: 'Paris FC 2', country: 'FR', region: 'Europe' },
        { id: 'MRS1', name: 'Marseille FC', country: 'FR', region: 'Europe' },
        // Germany
        { id: 'FRA1', name: 'Frankfurt FC 1', country: 'DE', region: 'Europe' },
        { id: 'FRA3', name: 'Frankfurt FC 3', country: 'DE', region: 'Europe' },
        { id: 'LEJ1', name: 'Leipzig FC', country: 'DE', region: 'Europe' },
        { id: 'DUS2', name: 'Dusseldorf FC', country: 'DE', region: 'Europe' },
        { id: 'STR1', name: 'Stuttgart FC', country: 'DE', region: 'Europe' },
        { id: 'BER3', name: 'Berlin FC', country: 'DE', region: 'Europe' },
        // UK
        { id: 'LCY1', name: 'London FC 1', country: 'GB', region: 'Europe' },
        { id: 'MAN1', name: 'Manchester FC', country: 'GB', region: 'Europe' },
        { id: 'EDI4', name: 'Edinburgh FC', country: 'GB', region: 'Europe' },
        // Spain
        { id: 'MAD4', name: 'Madrid FC', country: 'ES', region: 'Europe' },
        { id: 'BCN1', name: 'Barcelona FC', country: 'ES', region: 'Europe' },
        // Italy
        { id: 'MXP5', name: 'Milan FC', country: 'IT', region: 'Europe' },
        { id: 'FCO1', name: 'Rome FC', country: 'IT', region: 'Europe' },
        // Poland
        { id: 'WRO1', name: 'Wroclaw FC 1', country: 'PL', region: 'Europe' },
        { id: 'WRO2', name: 'Wroclaw FC 2', country: 'PL', region: 'Europe' },
        { id: 'KTW1', name: 'Katowice FC', country: 'PL', region: 'Europe' },
        // Czech Republic
        { id: 'PRG1', name: 'Prague FC', country: 'CZ', region: 'Europe' },
        // Netherlands
        { id: 'AMS1', name: 'Amsterdam FC', country: 'NL', region: 'Europe' },
        // Belgium
        { id: 'BRU1', name: 'Brussels FC', country: 'BE', region: 'Europe' },
        // Sweden
        { id: 'ARN1', name: 'Stockholm FC', country: 'SE', region: 'Europe' }
      ];

      for (const fc of knownFCs) {
        await this.db.collection(FULFILLMENT_CENTERS_COLLECTION).updateOne(
          { id: fc.id },
          {
            $set: {
              ...fc,
              updatedAt: new Date()
            },
            $setOnInsert: {
              createdAt: new Date()
            }
          },
          { upsert: true }
        );
        result.synced++;
      }

      console.log(`[SellerFulfillmentSync] Synced ${result.synced} fulfillment centers`);

    } catch (error) {
      result.errors.push({ error: error.message });
      console.error('[SellerFulfillmentSync] Error syncing FCs:', error);
    }

    return result;
  }

  /**
   * Get all fulfillment centers
   */
  async getFulfillmentCenters() {
    await this.init();
    return this.db.collection(FULFILLMENT_CENTERS_COLLECTION).find({}).toArray();
  }

  // ==================== MCF OUTBOUND ORDERS ====================

  /**
   * Create an MCF (Multi-Channel Fulfillment) order
   * This lets Amazon fulfill orders from other sales channels
   */
  async createMcfOrder(orderData) {
    await this.init();

    const {
      orderId, // Your order reference
      items, // [{ sku, quantity }]
      shippingAddress,
      shippingSpeed = 'Standard' // Standard, Expedited, Priority
    } = orderData;

    try {
      const spClient = await this.client.getClient();

      const fulfillmentOrder = {
        sellerFulfillmentOrderId: orderId,
        displayableOrderId: orderId,
        displayableOrderDate: new Date().toISOString(),
        displayableOrderComment: `MCF Order from Odoo - ${orderId}`,
        shippingSpeedCategory: shippingSpeed,
        destinationAddress: {
          name: shippingAddress.name,
          addressLine1: shippingAddress.addressLine1,
          addressLine2: shippingAddress.addressLine2 || '',
          city: shippingAddress.city,
          stateOrRegion: shippingAddress.stateOrRegion || '',
          postalCode: shippingAddress.postalCode,
          countryCode: shippingAddress.countryCode,
          phone: shippingAddress.phone || ''
        },
        items: items.map((item, idx) => ({
          sellerSku: item.sku,
          sellerFulfillmentOrderItemId: `${orderId}-${idx + 1}`,
          quantity: item.quantity
        }))
      };

      const response = await spClient.callAPI({
        operation: 'fulfillmentOutbound.createFulfillmentOrder',
        body: fulfillmentOrder
      });

      // Store MCF order
      await this.db.collection(MCF_ORDERS_COLLECTION).insertOne({
        orderId,
        amazonOrderId: response.fulfillmentOrderId,
        status: 'RECEIVED',
        items,
        shippingAddress,
        shippingSpeed,
        createdAt: new Date()
      });

      console.log(`[SellerFulfillmentSync] Created MCF order ${orderId}`);

      return { success: true, orderId, amazonOrderId: response.fulfillmentOrderId };

    } catch (error) {
      console.error(`[SellerFulfillmentSync] Error creating MCF order:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get MCF order status
   */
  async getMcfOrderStatus(orderId) {
    await this.init();

    try {
      const spClient = await this.client.getClient();

      const response = await spClient.callAPI({
        operation: 'fulfillmentOutbound.getFulfillmentOrder',
        path: { sellerFulfillmentOrderId: orderId }
      });

      const status = response.fulfillmentOrderStatus;

      // Update stored order
      await this.db.collection(MCF_ORDERS_COLLECTION).updateOne(
        { orderId },
        {
          $set: {
            status,
            amazonStatus: response,
            updatedAt: new Date()
          }
        }
      );

      return response;

    } catch (error) {
      console.error(`[SellerFulfillmentSync] Error getting MCF order status:`, error.message);
      return null;
    }
  }

  /**
   * Sync all pending MCF orders
   */
  async syncMcfOrders() {
    await this.init();

    const result = {
      checked: 0,
      updated: 0,
      errors: []
    };

    try {
      // Find pending MCF orders
      const pendingOrders = await this.db.collection(MCF_ORDERS_COLLECTION).find({
        status: { $nin: ['COMPLETE', 'CANCELLED', 'INVALID'] }
      }).toArray();

      console.log(`[SellerFulfillmentSync] Checking ${pendingOrders.length} pending MCF orders`);
      result.checked = pendingOrders.length;

      for (const order of pendingOrders) {
        try {
          const status = await this.getMcfOrderStatus(order.orderId);
          if (status) {
            result.updated++;
          }
        } catch (error) {
          result.errors.push({ orderId: order.orderId, error: error.message });
        }
      }

    } catch (error) {
      result.errors.push({ error: error.message });
    }

    return result;
  }

  /**
   * Cancel MCF order
   */
  async cancelMcfOrder(orderId) {
    await this.init();

    try {
      const spClient = await this.client.getClient();

      await spClient.callAPI({
        operation: 'fulfillmentOutbound.cancelFulfillmentOrder',
        path: { sellerFulfillmentOrderId: orderId }
      });

      await this.db.collection(MCF_ORDERS_COLLECTION).updateOne(
        { orderId },
        { $set: { status: 'CANCELLED', cancelledAt: new Date() } }
      );

      console.log(`[SellerFulfillmentSync] Cancelled MCF order ${orderId}`);
      return { success: true };

    } catch (error) {
      console.error(`[SellerFulfillmentSync] Error cancelling MCF order:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create MCF order from Odoo sale order
   * Auto-detect eligible Odoo orders and send to Amazon for fulfillment
   */
  async createMcfFromOdooOrder(saleOrderId) {
    await this.init();

    // Get sale order
    const saleOrders = await this.odoo.searchRead('sale.order',
      [['id', '=', saleOrderId]],
      ['id', 'name', 'partner_id', 'partner_shipping_id', 'order_line']
    );

    if (saleOrders.length === 0) {
      return { success: false, error: 'Sale order not found' };
    }

    const saleOrder = saleOrders[0];

    // Get shipping address
    const partners = await this.odoo.searchRead('res.partner',
      [['id', '=', saleOrder.partner_shipping_id[0]]],
      ['name', 'street', 'street2', 'city', 'state_id', 'zip', 'country_id', 'phone']
    );

    if (partners.length === 0) {
      return { success: false, error: 'Shipping address not found' };
    }

    const partner = partners[0];

    // Get order lines with products
    const orderLines = await this.odoo.searchRead('sale.order.line',
      [['order_id', '=', saleOrderId], ['product_id', '!=', false]],
      ['product_id', 'product_uom_qty']
    );

    const items = [];
    for (const line of orderLines) {
      const products = await this.odoo.searchRead('product.product',
        [['id', '=', line.product_id[0]]],
        ['default_code']
      );

      if (products.length > 0 && products[0].default_code) {
        items.push({
          sku: products[0].default_code,
          quantity: Math.floor(line.product_uom_qty)
        });
      }
    }

    if (items.length === 0) {
      return { success: false, error: 'No products with SKU found' };
    }

    // Get country code
    let countryCode = 'FR';
    if (partner.country_id) {
      const countries = await this.odoo.searchRead('res.country',
        [['id', '=', partner.country_id[0]]],
        ['code']
      );
      if (countries.length > 0) {
        countryCode = countries[0].code;
      }
    }

    // Create MCF order
    return await this.createMcfOrder({
      orderId: saleOrder.name,
      items,
      shippingAddress: {
        name: partner.name,
        addressLine1: partner.street || '',
        addressLine2: partner.street2 || '',
        city: partner.city || '',
        stateOrRegion: partner.state_id ? partner.state_id[1] : '',
        postalCode: partner.zip || '',
        countryCode,
        phone: partner.phone || ''
      }
    });
  }

  /**
   * Get statistics
   */
  async getStats() {
    await this.init();

    const [
      totalFCs,
      totalMcfOrders,
      pendingMcfOrders
    ] = await Promise.all([
      this.db.collection(FULFILLMENT_CENTERS_COLLECTION).countDocuments({}),
      this.db.collection(MCF_ORDERS_COLLECTION).countDocuments({}),
      this.db.collection(MCF_ORDERS_COLLECTION).countDocuments({
        status: { $nin: ['COMPLETE', 'CANCELLED', 'INVALID'] }
      })
    ]);

    return {
      totalFulfillmentCenters: totalFCs,
      totalMcfOrders,
      pendingMcfOrders
    };
  }
}

// Singleton instance
let fulfillmentSyncInstance = null;

/**
 * Get the singleton SellerFulfillmentSync instance
 */
async function getSellerFulfillmentSync() {
  if (!fulfillmentSyncInstance) {
    fulfillmentSyncInstance = new SellerFulfillmentSync();
    await fulfillmentSyncInstance.init();
  }
  return fulfillmentSyncInstance;
}

module.exports = {
  SellerFulfillmentSync,
  getSellerFulfillmentSync
};
