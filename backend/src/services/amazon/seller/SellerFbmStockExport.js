/**
 * SellerFbmStockExport - Rock-solid FBM stock sync from Odoo to Amazon
 *
 * Flow:
 * 1. Get all FBM Seller SKUs from Amazon (via listings report)
 * 2. Use SkuResolver to map Amazon SKU → Odoo SKU
 * 3. Get CW stock for resolved Odoo SKUs
 * 4. Send stock to Amazon using original Seller SKU
 * 5. Notify via Teams + store unresolved SKUs for review
 *
 * This approach is rock-solid because:
 * - Amazon is the source of truth for which SKUs exist
 * - SkuResolver is already battle-tested from order imports
 * - Unresolved SKUs get flagged → we improve resolver → self-healing
 *
 * @module SellerFbmStockExport
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { skuResolver } = require('../SkuResolver');
const { TeamsNotificationService } = require('../../../core/agents/services/TeamsNotificationService');
const { getAllMarketplaceIds } = require('./SellerMarketplaceConfig');

// Feed type for inventory updates
const INVENTORY_FEED_TYPE = 'POST_INVENTORY_AVAILABILITY_DATA';

// Report type for listings
const LISTINGS_REPORT_TYPE = 'GET_MERCHANT_LISTINGS_DATA';

// Collections
const FEEDS_COLLECTION = 'seller_feeds';
const UNRESOLVED_SKUS_COLLECTION = 'amazon_unresolved_skus';
const FBM_LISTINGS_COLLECTION = 'amazon_fbm_listings';

/**
 * SellerFbmStockExport - Exports FBM inventory to Amazon with proper SKU resolution
 */
class SellerFbmStockExport {
  constructor() {
    this.odoo = null;
    this.client = null;
    this.db = null;
    this.centralWarehouseId = null;
    this.centralLocationId = null;
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

    // Load SKU resolver
    await skuResolver.load();

    // Find Central Warehouse
    const warehouses = await this.odoo.searchRead('stock.warehouse',
      [['code', '=', 'CW']],
      ['id', 'name', 'lot_stock_id']
    );

    if (warehouses.length > 0) {
      this.centralWarehouseId = warehouses[0].id;
      this.centralLocationId = warehouses[0].lot_stock_id[0];
      console.log(`[SellerFbmStockExport] Central Warehouse: ${warehouses[0].name} (location: ${this.centralLocationId})`);
    } else {
      console.warn('[SellerFbmStockExport] Central Warehouse not found!');
    }
  }

  /**
   * Request a listings report from Amazon
   * @returns {Object} { success, reportId }
   */
  async requestListingsReport() {
    await this.init();

    try {
      const spClient = await this.client.getClient();

      const response = await spClient.callAPI({
        operation: 'reports.createReport',
        body: {
          reportType: LISTINGS_REPORT_TYPE,
          marketplaceIds: getAllMarketplaceIds()
        }
      });

      const reportId = response.reportId;
      console.log(`[SellerFbmStockExport] Requested listings report: ${reportId}`);

      // Store report request
      await this.db.collection('seller_reports').insertOne({
        reportId,
        reportType: LISTINGS_REPORT_TYPE,
        purpose: 'fbm_stock_sync',
        status: 'IN_QUEUE',
        requestedAt: new Date(),
        processed: false
      });

      return { success: true, reportId };

    } catch (error) {
      console.error('[SellerFbmStockExport] Error requesting listings report:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get FBM listings from cache or Amazon
   * @param {Object} options
   * @param {boolean} options.forceRefresh - Force refresh from Amazon
   * @returns {Array} FBM listings with seller SKU
   */
  async getFbmListings(options = {}) {
    await this.init();

    const { forceRefresh = false } = options;

    // Check cache first (listings cached from last report)
    if (!forceRefresh) {
      const cachedListings = await this.db.collection(FBM_LISTINGS_COLLECTION)
        .find({ fulfillmentChannel: 'DEFAULT' }) // DEFAULT = FBM in Amazon terms
        .toArray();

      if (cachedListings.length > 0) {
        const cacheAge = Date.now() - new Date(cachedListings[0].updatedAt).getTime();
        const maxCacheAge = 24 * 60 * 60 * 1000; // 24 hours

        if (cacheAge < maxCacheAge) {
          console.log(`[SellerFbmStockExport] Using cached FBM listings (${cachedListings.length} items, ${Math.round(cacheAge / 3600000)}h old)`);
          return cachedListings;
        }
      }
    }

    // Try to process any pending listings reports
    await this.processListingsReports();

    // Return whatever we have in cache
    const listings = await this.db.collection(FBM_LISTINGS_COLLECTION)
      .find({ fulfillmentChannel: 'DEFAULT' })
      .toArray();

    if (listings.length === 0) {
      console.log('[SellerFbmStockExport] No FBM listings in cache, requesting new report...');
      await this.requestListingsReport();
    }

    return listings;
  }

  /**
   * Process pending listings reports
   */
  async processListingsReports() {
    await this.init();

    const pendingReports = await this.db.collection('seller_reports').find({
      reportType: LISTINGS_REPORT_TYPE,
      processed: false,
      status: { $nin: ['CANCELLED', 'FATAL'] }
    }).toArray();

    if (pendingReports.length === 0) return { processed: 0 };

    const spClient = await this.client.getClient();
    let processed = 0;

    for (const report of pendingReports) {
      try {
        const statusResponse = await spClient.callAPI({
          operation: 'reports.getReport',
          path: { reportId: report.reportId }
        });

        const status = statusResponse.processingStatus;

        await this.db.collection('seller_reports').updateOne(
          { reportId: report.reportId },
          { $set: { status, updatedAt: new Date() } }
        );

        if (status === 'DONE') {
          const documentId = statusResponse.reportDocumentId;
          await this.downloadAndProcessListings(report.reportId, documentId);
          processed++;
        }

      } catch (error) {
        console.error(`[SellerFbmStockExport] Error checking report ${report.reportId}:`, error.message);
      }
    }

    return { processed };
  }

  /**
   * Download and process listings report
   */
  async downloadAndProcessListings(reportId, documentId) {
    const spClient = await this.client.getClient();

    try {
      const docResponse = await spClient.callAPI({
        operation: 'reports.getReportDocument',
        path: { reportDocumentId: documentId }
      });

      const reportData = await spClient.download(docResponse, { json: false });
      const listings = this.parseListingsReport(reportData);

      console.log(`[SellerFbmStockExport] Parsed ${listings.length} listings from report`);

      // Store in MongoDB
      const now = new Date();
      const operations = listings.map(listing => ({
        updateOne: {
          filter: { sellerSku: listing.sellerSku, marketplace: listing.marketplace },
          update: {
            $set: {
              ...listing,
              updatedAt: now
            },
            $setOnInsert: { createdAt: now }
          },
          upsert: true
        }
      }));

      if (operations.length > 0) {
        await this.db.collection(FBM_LISTINGS_COLLECTION).bulkWrite(operations);
      }

      // Mark report as processed
      await this.db.collection('seller_reports').updateOne(
        { reportId },
        { $set: { processed: true, processedAt: now, listingCount: listings.length } }
      );

      console.log(`[SellerFbmStockExport] Stored ${listings.length} listings in cache`);

    } catch (error) {
      console.error(`[SellerFbmStockExport] Error processing listings report:`, error.message);
      throw error;
    }
  }

  /**
   * Parse listings report (TSV format)
   */
  parseListingsReport(data) {
    const lines = data.toString().split('\n');
    const listings = [];

    if (lines.length < 2) return listings;

    // Parse header
    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '_'));

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      if (values.length < 2) continue;

      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx]?.trim() || '';
      });

      // Standard listings report fields
      listings.push({
        sellerSku: row.seller_sku || row.sku,
        asin: row.asin1 || row.asin,
        productName: row.item_name || row.product_name || row.title,
        price: parseFloat(row.price) || 0,
        quantity: parseInt(row.quantity) || 0,
        fulfillmentChannel: row.fulfillment_channel || 'DEFAULT', // DEFAULT = FBM, AMAZON_NA/EU = FBA
        status: row.status || 'Active',
        marketplace: row.marketplace || 'ALL'
      });
    }

    return listings.filter(l => l.sellerSku);
  }

  /**
   * Get CW stock for multiple Odoo SKUs
   * @param {string[]} odooSkus
   * @returns {Map<string, number>} Map of odooSku → available quantity
   */
  async getCwStock(odooSkus) {
    await this.init();

    if (!this.centralLocationId) {
      throw new Error('Central Warehouse not configured');
    }

    // Get products by SKU
    const products = await this.odoo.searchRead('product.product',
      [['default_code', 'in', odooSkus], ['active', '=', true]],
      ['id', 'default_code']
    );

    const productIdToSku = {};
    for (const p of products) {
      if (p.default_code) {
        productIdToSku[p.id] = p.default_code;
      }
    }

    const productIds = Object.keys(productIdToSku).map(id => parseInt(id));

    if (productIds.length === 0) {
      return new Map();
    }

    // Get stock quants for CW
    const quants = await this.odoo.searchRead('stock.quant',
      [
        ['product_id', 'in', productIds],
        ['location_id', '=', this.centralLocationId]
      ],
      ['product_id', 'quantity', 'reserved_quantity']
    );

    // Build stock map
    const stockMap = new Map();

    // Initialize all requested SKUs to 0
    for (const sku of odooSkus) {
      stockMap.set(sku, 0);
    }

    // Fill in actual stock
    for (const quant of quants) {
      const productId = quant.product_id[0];
      const sku = productIdToSku[productId];
      if (sku) {
        const available = Math.max(0, Math.floor(quant.quantity - (quant.reserved_quantity || 0)));
        stockMap.set(sku, (stockMap.get(sku) || 0) + available);
      }
    }

    return stockMap;
  }

  /**
   * Main sync function - the rock-solid approach
   * @param {Object} options
   * @param {boolean} options.dryRun - Don't submit to Amazon, just return what would be sent
   * @returns {Object} Sync results
   */
  async syncStock(options = {}) {
    await this.init();

    const { dryRun = false } = options;
    const result = {
      success: false,
      resolved: 0,
      unresolved: 0,
      unresolvedSkus: [],
      stockItems: [],
      feedId: null,
      feedItemCount: 0
    };

    try {
      // Step 1: Get FBM listings from Amazon
      console.log('[SellerFbmStockExport] Step 1: Getting FBM listings...');
      const fbmListings = await this.getFbmListings();

      if (fbmListings.length === 0) {
        result.success = true;
        result.message = 'No FBM listings found. Report may be processing - try again later.';
        return result;
      }

      console.log(`[SellerFbmStockExport] Found ${fbmListings.length} FBM listings`);

      // Step 2: Resolve each Seller SKU to Odoo SKU
      console.log('[SellerFbmStockExport] Step 2: Resolving SKUs...');
      const resolvedItems = [];
      const unresolvedItems = [];

      for (const listing of fbmListings) {
        const resolution = skuResolver.resolve(listing.sellerSku);

        if (resolution.odooSku) {
          resolvedItems.push({
            sellerSku: listing.sellerSku,
            odooSku: resolution.odooSku,
            asin: listing.asin,
            productName: listing.productName,
            matchType: resolution.matchType
          });
        } else {
          unresolvedItems.push({
            sellerSku: listing.sellerSku,
            asin: listing.asin,
            productName: listing.productName,
            reason: 'Could not resolve to Odoo SKU'
          });
        }
      }

      result.resolved = resolvedItems.length;
      result.unresolved = unresolvedItems.length;
      result.unresolvedSkus = unresolvedItems;

      console.log(`[SellerFbmStockExport] Resolved: ${resolvedItems.length}, Unresolved: ${unresolvedItems.length}`);

      // Step 3: Get CW stock for resolved Odoo SKUs
      console.log('[SellerFbmStockExport] Step 3: Getting CW stock...');
      const odooSkus = [...new Set(resolvedItems.map(i => i.odooSku))];
      const stockMap = await this.getCwStock(odooSkus);

      // Step 4: Build stock items with original Seller SKU
      console.log('[SellerFbmStockExport] Step 4: Building stock items...');
      const stockItems = [];

      for (const item of resolvedItems) {
        const quantity = stockMap.get(item.odooSku) || 0;
        stockItems.push({
          sellerSku: item.sellerSku,
          odooSku: item.odooSku,
          quantity,
          fulfillmentLatency: 3
        });
      }

      result.stockItems = stockItems;

      // Step 5: Handle unresolved SKUs
      if (unresolvedItems.length > 0) {
        await this.handleUnresolvedSkus(unresolvedItems);
      }

      // Step 6: Submit to Amazon (unless dry run)
      if (!dryRun && stockItems.length > 0) {
        console.log('[SellerFbmStockExport] Step 5: Submitting to Amazon...');
        const feedResult = await this.submitFeed(stockItems);
        result.feedId = feedResult.feedId;
        result.feedItemCount = feedResult.itemCount;
        result.success = feedResult.success;
        if (!feedResult.success) {
          result.error = feedResult.error;
        }
      } else if (dryRun) {
        result.success = true;
        result.message = 'Dry run - no feed submitted';
      } else {
        result.success = true;
        result.message = 'No stock items to submit';
      }

      return result;

    } catch (error) {
      console.error('[SellerFbmStockExport] Sync error:', error.message);
      result.error = error.message;
      return result;
    }
  }

  /**
   * Handle unresolved SKUs - store in DB and send Teams notification
   */
  async handleUnresolvedSkus(unresolvedItems) {
    const now = new Date();

    // Store in MongoDB
    const operations = unresolvedItems.map(item => ({
      updateOne: {
        filter: { sellerSku: item.sellerSku },
        update: {
          $set: {
            sellerSku: item.sellerSku,
            asin: item.asin,
            productName: item.productName,
            reason: item.reason,
            lastSeenAt: now,
            resolved: false
          },
          $setOnInsert: { createdAt: now },
          $inc: { seenCount: 1 }
        },
        upsert: true
      }
    }));

    await this.db.collection(UNRESOLVED_SKUS_COLLECTION).bulkWrite(operations);

    // Send Teams notification (if webhook configured)
    await this.sendUnresolvedSkusNotification(unresolvedItems);
  }

  /**
   * Send Teams notification for unresolved SKUs
   */
  async sendUnresolvedSkusNotification(unresolvedItems) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) {
      console.log('[SellerFbmStockExport] No Teams webhook configured, skipping notification');
      return;
    }

    // Only notify if there are new unresolved SKUs (not seen in last 24h)
    const recentThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const newUnresolved = [];

    for (const item of unresolvedItems) {
      const existing = await this.db.collection(UNRESOLVED_SKUS_COLLECTION).findOne({
        sellerSku: item.sellerSku,
        lastSeenAt: { $gte: recentThreshold }
      });

      if (!existing || existing.seenCount <= 1) {
        newUnresolved.push(item);
      }
    }

    if (newUnresolved.length === 0) {
      return; // All unresolved SKUs were already reported recently
    }

    try {
      const teams = new TeamsNotificationService({ webhookUrl });

      const skuList = newUnresolved.slice(0, 10).map(item =>
        `- **${item.sellerSku}** (${item.asin || 'no ASIN'}): ${item.productName?.substring(0, 50) || 'Unknown'}`
      ).join('\n');

      const moreText = newUnresolved.length > 10
        ? `\n\n...and ${newUnresolved.length - 10} more`
        : '';

      const card = {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: `Amazon FBM Stock Sync: ${newUnresolved.length} Unresolved SKUs`,
            weight: 'bolder',
            size: 'medium',
            color: 'warning'
          },
          {
            type: 'TextBlock',
            text: 'The following Amazon Seller SKUs could not be resolved to Odoo products. Please update the SKU resolver or add custom mappings.',
            wrap: true
          },
          {
            type: 'TextBlock',
            text: skuList + moreText,
            wrap: true,
            fontType: 'monospace'
          },
          {
            type: 'TextBlock',
            text: `Time: ${new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}`,
            size: 'small',
            isSubtle: true
          }
        ]
      };

      await teams.sendMessage(card);
      console.log(`[SellerFbmStockExport] Teams notification sent for ${newUnresolved.length} unresolved SKUs`);

    } catch (error) {
      console.error('[SellerFbmStockExport] Failed to send Teams notification:', error.message);
    }
  }

  /**
   * Generate inventory feed XML
   */
  generateFeedXml(stockItems) {
    const merchantId = process.env.AMAZON_MERCHANT_ID || 'A1GJ5ZORIRYSYA';

    let xml = `<?xml version="1.0" encoding="utf-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.01</DocumentVersion>
    <MerchantIdentifier>${merchantId}</MerchantIdentifier>
  </Header>
  <MessageType>Inventory</MessageType>`;

    let messageId = 1;
    for (const item of stockItems) {
      xml += `
  <Message>
    <MessageID>${messageId++}</MessageID>
    <OperationType>Update</OperationType>
    <Inventory>
      <SKU>${this.escapeXml(item.sellerSku)}</SKU>
      <Quantity>${item.quantity}</Quantity>
      <FulfillmentLatency>${item.fulfillmentLatency || 3}</FulfillmentLatency>
    </Inventory>
  </Message>`;
    }

    xml += '\n</AmazonEnvelope>';
    return xml;
  }

  /**
   * Submit inventory feed to Amazon
   */
  async submitFeed(stockItems) {
    await this.init();

    if (stockItems.length === 0) {
      return { success: true, message: 'No items to update', itemCount: 0 };
    }

    try {
      const spClient = await this.client.getClient();
      const feedXml = this.generateFeedXml(stockItems);

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
      console.log(`[SellerFbmStockExport] Submitted feed ${feedId} with ${stockItems.length} items`);

      // Store feed record
      await this.db.collection(FEEDS_COLLECTION).insertOne({
        feedId,
        feedDocumentId,
        feedType: INVENTORY_FEED_TYPE,
        itemCount: stockItems.length,
        status: 'IN_QUEUE',
        submittedAt: new Date(),
        processed: false,
        // Store summary for debugging
        summary: {
          resolved: stockItems.length,
          totalQuantity: stockItems.reduce((sum, i) => sum + i.quantity, 0),
          zeroStock: stockItems.filter(i => i.quantity === 0).length
        }
      });

      return { success: true, feedId, itemCount: stockItems.length };

    } catch (error) {
      console.error('[SellerFbmStockExport] Error submitting feed:', error.message);
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
            await this.db.collection(FEEDS_COLLECTION).updateOne(
              { feedId: feed.feedId },
              { $set: { processed: true, processedAt: new Date() } }
            );
            result.completed++;
            console.log(`[SellerFbmStockExport] Feed ${feed.feedId} completed`);

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
   * Get statistics
   */
  async getStats() {
    await this.init();

    const [
      pendingFeeds,
      completedFeeds,
      lastFeed,
      unresolvedCount,
      fbmListingsCount
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
      ),
      this.db.collection(UNRESOLVED_SKUS_COLLECTION).countDocuments({ resolved: false }),
      this.db.collection(FBM_LISTINGS_COLLECTION).countDocuments({ fulfillmentChannel: 'DEFAULT' })
    ]);

    return {
      pendingFeeds,
      completedFeeds,
      lastExportAt: lastFeed?.submittedAt,
      lastItemCount: lastFeed?.itemCount,
      lastSummary: lastFeed?.summary,
      unresolvedSkus: unresolvedCount,
      fbmListingsInCache: fbmListingsCount
    };
  }

  /**
   * Get list of unresolved SKUs
   */
  async getUnresolvedSkus() {
    await this.init();

    return this.db.collection(UNRESOLVED_SKUS_COLLECTION)
      .find({ resolved: false })
      .sort({ seenCount: -1, lastSeenAt: -1 })
      .toArray();
  }

  /**
   * Mark an unresolved SKU as resolved (after adding mapping)
   */
  async markSkuResolved(sellerSku) {
    await this.init();

    await this.db.collection(UNRESOLVED_SKUS_COLLECTION).updateOne(
      { sellerSku },
      { $set: { resolved: true, resolvedAt: new Date() } }
    );
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
let fbmStockExportInstance = null;

/**
 * Get the singleton SellerFbmStockExport instance
 */
async function getSellerFbmStockExport() {
  if (!fbmStockExportInstance) {
    fbmStockExportInstance = new SellerFbmStockExport();
    await fbmStockExportInstance.init();
  }
  return fbmStockExportInstance;
}

module.exports = {
  SellerFbmStockExport,
  getSellerFbmStockExport,
  INVENTORY_FEED_TYPE,
  LISTINGS_REPORT_TYPE
};
