/**
 * SellerInventoryExport - Export FBM inventory from Odoo to Amazon
 *
 * Pushes FBM stock levels to Amazon:
 * 1. Get stock levels from Odoo (Central Warehouse)
 * 2. Submit inventory feed to Amazon
 *
 * @module SellerInventoryExport
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { getAllMarketplaceIds } = require('./SellerMarketplaceConfig');

// Feed type for inventory updates
const INVENTORY_FEED_TYPE = 'POST_INVENTORY_AVAILABILITY_DATA';

// Collection for tracking feed submissions
const FEEDS_COLLECTION = 'seller_feeds';

/**
 * SellerInventoryExport - Exports FBM inventory to Amazon
 */
class SellerInventoryExport {
  constructor() {
    this.odoo = null;
    this.client = null;
    this.db = null;
    this.centralWarehouseId = null;
  }

  /**
   * Initialize the export service
   */
  async init() {
    if (this.odoo && this.db) return;

    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();

    this.client = getSellerClient();
    await this.client.init();

    this.db = getDb();

    // Find Central Warehouse
    const warehouses = await this.odoo.searchRead('stock.warehouse',
      [['name', 'ilike', 'Central%']],
      ['id', 'name', 'lot_stock_id']
    );

    if (warehouses.length > 0) {
      this.centralWarehouseId = warehouses[0].id;
      this.centralLocationId = warehouses[0].lot_stock_id[0];
    }
  }

  /**
   * Get FBM stock levels from Odoo
   */
  async getOdooStock() {
    await this.init();

    if (!this.centralLocationId) {
      throw new Error('Central Warehouse not found');
    }

    // Get stock quants for Central Warehouse
    const quants = await this.odoo.searchRead('stock.quant',
      [
        ['location_id', '=', this.centralLocationId],
        ['quantity', '>', 0]
      ],
      ['product_id', 'quantity', 'reserved_quantity']
    );

    // Get product SKUs
    const productIds = [...new Set(quants.map(q => q.product_id[0]))];

    const products = await this.odoo.searchRead('product.product',
      [['id', 'in', productIds]],
      ['id', 'default_code', 'name', 'active']
    );

    const productMap = {};
    for (const p of products) {
      if (p.default_code && p.active) {
        productMap[p.id] = p.default_code;
      }
    }

    // Build inventory list
    const inventory = [];
    for (const quant of quants) {
      const sku = productMap[quant.product_id[0]];
      if (!sku) continue;

      const available = Math.max(0, Math.floor(quant.quantity - (quant.reserved_quantity || 0)));

      inventory.push({
        sku,
        quantity: available,
        fulfillmentLatency: 3 // Default 3 days
      });
    }

    // Aggregate by SKU (in case of multiple quants)
    const skuTotals = {};
    for (const item of inventory) {
      if (!skuTotals[item.sku]) {
        skuTotals[item.sku] = { sku: item.sku, quantity: 0, fulfillmentLatency: item.fulfillmentLatency };
      }
      skuTotals[item.sku].quantity += item.quantity;
    }

    return Object.values(skuTotals);
  }

  /**
   * Generate inventory feed XML
   */
  generateFeedXml(inventory) {
    const merchantId = process.env.AMAZON_MERCHANT_ID || 'A1GJ5ZORIRYSYA';

    let xml = `<?xml version="1.0" encoding="utf-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.01</DocumentVersion>
    <MerchantIdentifier>${merchantId}</MerchantIdentifier>
  </Header>
  <MessageType>Inventory</MessageType>`;

    let messageId = 1;
    for (const item of inventory) {
      xml += `
  <Message>
    <MessageID>${messageId++}</MessageID>
    <OperationType>Update</OperationType>
    <Inventory>
      <SKU>${this.escapeXml(item.sku)}</SKU>
      <Quantity>${item.quantity}</Quantity>
      <FulfillmentLatency>${item.fulfillmentLatency}</FulfillmentLatency>
    </Inventory>
  </Message>`;
    }

    xml += '\n</AmazonEnvelope>';
    return xml;
  }

  /**
   * Submit inventory feed to Amazon
   */
  async submitFeed(inventory) {
    await this.init();

    if (inventory.length === 0) {
      return { success: true, message: 'No inventory to update' };
    }

    try {
      const spClient = await this.client.getClient();
      const feedXml = this.generateFeedXml(inventory);

      // Create feed document
      const createDocResponse = await spClient.callAPI({
        operation: 'feeds.createFeedDocument',
        body: {
          contentType: 'text/xml; charset=UTF-8'
        }
      });

      const feedDocumentId = createDocResponse.feedDocumentId;
      const uploadUrl = createDocResponse.url;

      // Upload feed content
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
        body: feedXml
      });

      // Submit feed
      const submitResponse = await spClient.callAPI({
        operation: 'feeds.createFeed',
        body: {
          feedType: INVENTORY_FEED_TYPE,
          marketplaceIds: getAllMarketplaceIds(),
          inputFeedDocumentId: feedDocumentId
        }
      });

      const feedId = submitResponse.feedId;
      console.log(`[SellerInventoryExport] Submitted feed ${feedId} with ${inventory.length} items`);

      // Store feed record
      await this.db.collection(FEEDS_COLLECTION).insertOne({
        feedId,
        feedDocumentId,
        feedType: INVENTORY_FEED_TYPE,
        itemCount: inventory.length,
        status: 'IN_QUEUE',
        submittedAt: new Date(),
        processed: false
      });

      return { success: true, feedId, itemCount: inventory.length };

    } catch (error) {
      console.error('[SellerInventoryExport] Error submitting feed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check status of submitted feeds
   */
  async checkFeedStatus() {
    await this.init();

    const result = {
      checked: 0,
      completed: 0,
      errors: []
    };

    try {
      const pendingFeeds = await this.db.collection(FEEDS_COLLECTION).find({
        feedType: INVENTORY_FEED_TYPE,
        processed: false,
        status: { $nin: ['CANCELLED', 'FATAL'] }
      }).toArray();

      console.log(`[SellerInventoryExport] Checking ${pendingFeeds.length} pending feeds`);
      result.checked = pendingFeeds.length;

      const spClient = await this.client.getClient();

      for (const feed of pendingFeeds) {
        try {
          const statusResponse = await spClient.callAPI({
            operation: 'feeds.getFeed',
            path: { feedId: feed.feedId }
          });

          const status = statusResponse.processingStatus;

          await this.db.collection(FEEDS_COLLECTION).updateOne(
            { feedId: feed.feedId },
            {
              $set: {
                status,
                updatedAt: new Date(),
                resultFeedDocumentId: statusResponse.resultFeedDocumentId
              }
            }
          );

          if (status === 'DONE') {
            // Could fetch and parse result document for errors
            await this.db.collection(FEEDS_COLLECTION).updateOne(
              { feedId: feed.feedId },
              { $set: { processed: true, processedAt: new Date() } }
            );
            result.completed++;
            console.log(`[SellerInventoryExport] Feed ${feed.feedId} completed`);

          } else if (status === 'FATAL' || status === 'CANCELLED') {
            await this.db.collection(FEEDS_COLLECTION).updateOne(
              { feedId: feed.feedId },
              { $set: { processed: true, processedAt: new Date() } }
            );
            result.errors.push({ feedId: feed.feedId, status });
          }

        } catch (error) {
          result.errors.push({ feedId: feed.feedId, error: error.message });
        }
      }

    } catch (error) {
      result.errors.push({ error: error.message });
    }

    return result;
  }

  /**
   * Full export: get Odoo stock and submit to Amazon
   */
  async exportInventory() {
    await this.init();

    const inventory = await this.getOdooStock();
    console.log(`[SellerInventoryExport] Got ${inventory.length} SKUs from Odoo`);

    if (inventory.length === 0) {
      return { success: true, message: 'No inventory to export', itemCount: 0 };
    }

    return await this.submitFeed(inventory);
  }

  /**
   * Get export statistics
   */
  async getStats() {
    await this.init();

    const [
      pendingFeeds,
      completedFeeds,
      lastFeed
    ] = await Promise.all([
      this.db.collection(FEEDS_COLLECTION).countDocuments({
        feedType: INVENTORY_FEED_TYPE,
        processed: false
      }),
      this.db.collection(FEEDS_COLLECTION).countDocuments({
        feedType: INVENTORY_FEED_TYPE,
        processed: true,
        status: 'DONE'
      }),
      this.db.collection(FEEDS_COLLECTION).findOne(
        { feedType: INVENTORY_FEED_TYPE, processed: true },
        { sort: { processedAt: -1 } }
      )
    ]);

    return {
      pendingFeeds,
      completedFeeds,
      lastExportAt: lastFeed?.submittedAt,
      lastItemCount: lastFeed?.itemCount
    };
  }

  /**
   * Escape XML special characters
   */
  escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

// Singleton instance
let inventoryExportInstance = null;

/**
 * Get the singleton SellerInventoryExport instance
 */
async function getSellerInventoryExport() {
  if (!inventoryExportInstance) {
    inventoryExportInstance = new SellerInventoryExport();
    await inventoryExportInstance.init();
  }
  return inventoryExportInstance;
}

module.exports = {
  SellerInventoryExport,
  getSellerInventoryExport,
  INVENTORY_FEED_TYPE
};
