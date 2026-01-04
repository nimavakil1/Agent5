/**
 * FBM (Fulfilled by Merchant) Stock Sync Service
 *
 * Syncs Odoo inventory levels to Amazon for merchant-fulfilled products.
 * Generates feed data that can be sent to Amazon via Make.com or SP-API.
 *
 * Flow: Odoo Stock → Agent5 → Amazon (via Make.com webhook or feed upload)
 */

const { skuResolver } = require('./SkuResolver');
const { getDb } = require('../../db');

// Amazon inventory feed XML template
const FEED_HEADER = `<?xml version="1.0" encoding="utf-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.01</DocumentVersion>
    <MerchantIdentifier>{{MERCHANT_ID}}</MerchantIdentifier>
  </Header>
  <MessageType>Inventory</MessageType>`;

const FEED_FOOTER = `</AmazonEnvelope>`;

// Minimum stock threshold - don't update if quantity unchanged
const MIN_STOCK_CHANGE = 1;

// Safety stock buffer (keep some stock reserved)
const DEFAULT_SAFETY_STOCK = 0;

class FbmStockSync {
  constructor(odooClient, options = {}) {
    this.odoo = odooClient;
    this.merchantId = options.merchantId || process.env.AMAZON_MERCHANT_ID || '';
    this.safetyStock = options.safetyStock ?? DEFAULT_SAFETY_STOCK;
    this.productCache = new Map();
    this.skuMappingCache = new Map();
    this.lastSyncState = new Map();
  }

  /**
   * Get FBM products and their stock from Odoo
   * @param {object} options
   * @param {string[]} options.skus - Specific SKUs to sync (optional)
   * @param {number} options.warehouseId - Odoo warehouse ID (optional)
   * @param {boolean} options.onlyChanged - Only return changed stock (default: true)
   * @returns {Array} Stock items
   */
  async getOdooStock(options = {}) {
    const { skus, warehouseId: _warehouseId, onlyChanged = true } = options;

    try {
      // Get all SKU mappings
      await skuResolver.load();
      const mappings = skuResolver.getMappings();

      // Build product query
      const query = [['type', '=', 'product']];

      if (skus && skus.length > 0) {
        // Map Amazon SKUs to Odoo SKUs
        const odooSkus = skus.map(s => skuResolver.resolve(s).odooSku);
        query.push(['default_code', 'in', odooSkus]);
      }

      // Get products from Odoo
      const products = await this.odoo.searchRead('product.product',
        query,
        ['id', 'name', 'default_code', 'qty_available', 'virtual_available', 'free_qty']
      );

      const stockItems = [];

      for (const product of products) {
        if (!product.default_code) continue;

        // Find Amazon SKU for this Odoo product
        const amazonSku = this.findAmazonSku(product.default_code, mappings);
        if (!amazonSku) continue; // Skip products not mapped to Amazon

        // Calculate available quantity
        // free_qty = qty_available - reserved quantities
        const quantity = Math.max(0, Math.floor(product.free_qty || product.qty_available || 0) - this.safetyStock);

        // Check if stock has changed
        if (onlyChanged) {
          const lastQty = this.lastSyncState.get(amazonSku);
          if (lastQty !== undefined && Math.abs(lastQty - quantity) < MIN_STOCK_CHANGE) {
            continue; // Skip unchanged items
          }
        }

        stockItems.push({
          amazonSku,
          odooSku: product.default_code,
          odooProductId: product.id,
          productName: product.name,
          quantity,
          availableInOdoo: product.qty_available || 0,
          virtualAvailable: product.virtual_available || 0,
        });
      }

      return stockItems;

    } catch (error) {
      console.error('[FbmStockSync] Error getting Odoo stock:', error);
      throw error;
    }
  }

  /**
   * Find Amazon SKU from Odoo SKU
   * @param {string} odooSku
   * @param {object} mappings
   * @returns {string|null}
   */
  findAmazonSku(odooSku, mappings) {
    // Check cache
    if (this.skuMappingCache.has(odooSku)) {
      return this.skuMappingCache.get(odooSku);
    }

    // Direct match (Amazon SKU = Odoo SKU)
    if (odooSku) {
      this.skuMappingCache.set(odooSku, odooSku);
      return odooSku;
    }

    // Reverse lookup in mappings
    for (const [amazonSku, mapping] of Object.entries(mappings)) {
      if (mapping === odooSku || (mapping.odooSku === odooSku)) {
        this.skuMappingCache.set(odooSku, amazonSku);
        return amazonSku;
      }
    }

    return null;
  }

  /**
   * Generate Amazon inventory feed XML
   * @param {Array} stockItems
   * @returns {string} XML feed content
   */
  generateFeedXml(stockItems) {
    let xml = FEED_HEADER.replace('{{MERCHANT_ID}}', this.merchantId);

    let messageId = 1;
    for (const item of stockItems) {
      xml += `
  <Message>
    <MessageID>${messageId++}</MessageID>
    <OperationType>Update</OperationType>
    <Inventory>
      <SKU>${this.escapeXml(item.amazonSku)}</SKU>
      <Quantity>${item.quantity}</Quantity>
      <FulfillmentLatency>1</FulfillmentLatency>
    </Inventory>
  </Message>`;
    }

    xml += '\n' + FEED_FOOTER;
    return xml;
  }

  /**
   * Generate JSON format for Make.com webhook
   * @param {Array} stockItems
   * @returns {object} Webhook payload
   */
  generateWebhookPayload(stockItems) {
    return {
      feedType: 'POST_INVENTORY_AVAILABILITY_DATA',
      timestamp: new Date().toISOString(),
      itemCount: stockItems.length,
      items: stockItems.map(item => ({
        sku: item.amazonSku,
        quantity: item.quantity,
        fulfillmentLatency: 1
      }))
    };
  }

  /**
   * Sync stock to Amazon via webhook
   * @param {object} options
   * @param {string} options.webhookUrl - Make.com webhook URL
   * @param {string[]} options.skus - Specific SKUs to sync (optional)
   * @returns {object} Sync result
   */
  async syncToWebhook(options = {}) {
    const { webhookUrl, skus } = options;

    if (!webhookUrl) {
      throw new Error('webhookUrl is required');
    }

    const startTime = Date.now();
    const result = {
      success: false,
      timestamp: new Date().toISOString(),
      itemsSynced: 0,
      errors: [],
    };

    try {
      // Get stock from Odoo
      const stockItems = await this.getOdooStock({ skus, onlyChanged: true });

      if (stockItems.length === 0) {
        result.success = true;
        result.message = 'No stock changes to sync';
        return result;
      }

      // Generate payload
      const payload = this.generateWebhookPayload(stockItems);

      // Send to webhook
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}: ${await response.text()}`);
      }

      // Update last sync state
      for (const item of stockItems) {
        this.lastSyncState.set(item.amazonSku, item.quantity);
      }

      result.success = true;
      result.itemsSynced = stockItems.length;
      result.webhookResponse = await response.json().catch(() => null);

    } catch (error) {
      result.errors.push(error.message);
      console.error('[FbmStockSync] Webhook sync error:', error);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Queue stock sync for later processing
   * @param {object} options
   * @param {string[]} options.skus - Specific SKUs to sync (optional)
   * @returns {object} Queue result
   */
  async queueSync(options = {}) {
    const { skus } = options;
    const db = getDb();

    const stockItems = await this.getOdooStock({ skus, onlyChanged: true });

    if (stockItems.length === 0) {
      return { queued: 0, message: 'No stock changes to queue' };
    }

    // Store in MongoDB for later processing
    const doc = {
      status: 'pending',
      createdAt: new Date(),
      itemCount: stockItems.length,
      items: stockItems.map(item => ({
        amazonSku: item.amazonSku,
        odooSku: item.odooSku,
        quantity: item.quantity,
      })),
      feedXml: this.generateFeedXml(stockItems),
    };

    const result = await db.collection('amazon_stock_sync_queue').insertOne(doc);

    return {
      queued: stockItems.length,
      queueId: result.insertedId.toString(),
    };
  }

  /**
   * Get pending sync queue
   * @returns {Array} Pending sync items
   */
  async getPendingQueue() {
    const db = getDb();
    return db.collection('amazon_stock_sync_queue')
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

    await db.collection('amazon_stock_sync_queue').updateOne(
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
   * Get current stock comparison
   * @returns {object} Comparison data
   */
  async getStockComparison() {
    const db = getDb();

    // Get Odoo stock
    const odooStock = await this.getOdooStock({ onlyChanged: false });

    // Get last Amazon inventory from MongoDB
    const amazonInventory = await db.collection('amazon_inventory')
      .find({})
      .toArray();

    const comparison = [];

    for (const item of odooStock) {
      const amazonItem = amazonInventory.find(a =>
        a.sellerSku === item.amazonSku || a.sellerSku === item.odooSku
      );

      comparison.push({
        sku: item.amazonSku,
        odooSku: item.odooSku,
        productName: item.productName,
        odooQty: item.quantity,
        amazonQty: amazonItem?.fulfillableQuantity || 0,
        difference: item.quantity - (amazonItem?.fulfillableQuantity || 0),
        needsSync: item.quantity !== (amazonItem?.fulfillableQuantity || 0),
      });
    }

    // Sort by difference (largest first)
    comparison.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

    return {
      total: comparison.length,
      needsSync: comparison.filter(c => c.needsSync).length,
      items: comparison,
    };
  }

  /**
   * Get sync history
   * @param {number} limit
   * @returns {Array} Sync history
   */
  async getSyncHistory(limit = 20) {
    const db = getDb();
    return db.collection('amazon_stock_sync_queue')
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .project({
        status: 1,
        createdAt: 1,
        processedAt: 1,
        itemCount: 1,
        'result.success': 1,
        'result.errors': 1,
      })
      .toArray();
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
   * Clear caches
   */
  clearCaches() {
    this.productCache.clear();
    this.skuMappingCache.clear();
    this.lastSyncState.clear();
  }
}

module.exports = { FbmStockSync };
