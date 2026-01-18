/**
 * SellerFbmStockExport - Rock-solid FBM stock sync from Odoo to Amazon
 *
 * Flow:
 * 1. Get all FBM Seller SKUs from Amazon (via listings report)
 * 2. Use SkuResolver to map Amazon SKU → Odoo SKU
 * 3. Get CW stock for resolved Odoo SKUs
 * 4. Send stock to Amazon using Listings Items API (patchListingsItem)
 * 5. Notify via Teams + store unresolved SKUs for review
 *
 * This approach is rock-solid because:
 * - Amazon is the source of truth for which SKUs exist
 * - SkuResolver is already battle-tested from order imports
 * - Unresolved SKUs get flagged → we improve resolver → self-healing
 * - Uses Listings Items API (not Feeds API) for inventory updates
 *
 * @module SellerFbmStockExport
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { skuResolver } = require('../SkuResolver');
const { TeamsNotificationService } = require('../../../core/agents/services/TeamsNotificationService');
const { getAllMarketplaceIds, MARKETPLACE_IDS } = require('./SellerMarketplaceConfig');
const Product = require('../../../models/Product');

// Feed type for inventory updates (kept for backwards compatibility with stats)
const INVENTORY_FEED_TYPE = 'POST_INVENTORY_AVAILABILITY_DATA';

// Rate limiting for Listings Items API (5 requests per second to be safe)
const API_DELAY_MS = 200;

// Report type for listings
const LISTINGS_REPORT_TYPE = 'GET_MERCHANT_LISTINGS_DATA';

// Collections
const FEEDS_COLLECTION = 'seller_feeds';
const STOCK_UPDATES_COLLECTION = 'amazon_stock_updates';

// Target marketplaces for FBM stock sync
// These are the 7 marketplaces where Acropaq sells FBM
const FBM_TARGET_MARKETPLACES = ['DE', 'FR', 'NL', 'BE', 'ES', 'IT', 'UK'];
const UNRESOLVED_SKUS_COLLECTION = 'amazon_unresolved_skus';
const FBM_LISTINGS_COLLECTION = 'amazon_fbm_listings';

// Helper for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
   * Request a listings report from Amazon for a specific marketplace
   * @param {string} marketplaceCode - Marketplace code (DE, FR, NL, etc.)
   * @returns {Object} { success, reportId }
   */
  async requestListingsReport(marketplaceCode = 'DE') {
    await this.init();

    try {
      const spClient = await this.client.getClient();

      const marketplaceId = MARKETPLACE_IDS[marketplaceCode];
      if (!marketplaceId) {
        throw new Error(`Unknown marketplace code: ${marketplaceCode}`);
      }

      const response = await spClient.callAPI({
        operation: 'reports.createReport',
        body: {
          reportType: LISTINGS_REPORT_TYPE,
          marketplaceIds: [marketplaceId]
        }
      });

      const reportId = response.reportId;
      console.log(`[SellerFbmStockExport] Requested listings report for ${marketplaceCode}: ${reportId}`);

      // Store report request with marketplace info
      await this.db.collection('seller_reports').insertOne({
        reportId,
        reportType: LISTINGS_REPORT_TYPE,
        marketplace: marketplaceCode,
        purpose: 'fbm_stock_sync',
        status: 'IN_QUEUE',
        requestedAt: new Date(),
        processed: false
      });

      return { success: true, reportId, marketplace: marketplaceCode };

    } catch (error) {
      console.error(`[SellerFbmStockExport] Error requesting listings report for ${marketplaceCode}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Request listings reports from all target marketplaces
   * @returns {Object} { success, reports: [{ marketplace, reportId }] }
   */
  async requestAllMarketplaceReports() {
    await this.init();

    const results = [];

    for (const marketplaceCode of FBM_TARGET_MARKETPLACES) {
      const result = await this.requestListingsReport(marketplaceCode);
      if (result.success) {
        results.push({ marketplace: marketplaceCode, reportId: result.reportId });
      }
      // Small delay between requests to avoid rate limiting
      await sleep(500);
    }

    console.log(`[SellerFbmStockExport] Requested listings reports for ${results.length}/${FBM_TARGET_MARKETPLACES.length} marketplaces`);

    return { success: results.length > 0, reports: results };
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
      console.log('[SellerFbmStockExport] No FBM listings in cache, requesting reports for all marketplaces...');
      await this.requestAllMarketplaceReports();
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
          // Pass marketplace from the report document
          await this.downloadAndProcessListings(report.reportId, documentId, report.marketplace || 'DE');
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
   * @param {string} reportId - Report ID
   * @param {string} documentId - Document ID for download
   * @param {string} marketplace - Marketplace code this report is from
   */
  async downloadAndProcessListings(reportId, documentId, marketplace = 'DE') {
    const spClient = await this.client.getClient();

    try {
      const docResponse = await spClient.callAPI({
        operation: 'reports.getReportDocument',
        path: { reportDocumentId: documentId }
      });

      const reportData = await spClient.download(docResponse, { json: false });
      const listings = this.parseListingsReport(reportData, marketplace);

      console.log(`[SellerFbmStockExport] Parsed ${listings.length} listings from ${marketplace} report`);

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
        { $set: { processed: true, processedAt: now, listingCount: listings.length, marketplace } }
      );

      console.log(`[SellerFbmStockExport] Stored ${listings.length} ${marketplace} listings in cache`);

    } catch (error) {
      console.error(`[SellerFbmStockExport] Error processing ${marketplace} listings report:`, error.message);
      throw error;
    }
  }

  /**
   * Parse listings report (TSV format)
   * @param {Buffer|string} data - Report data
   * @param {string} marketplace - Marketplace code this report is from
   */
  parseListingsReport(data, marketplace = 'DE') {
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
      // Use the marketplace parameter - this is the marketplace the report was requested from
      listings.push({
        sellerSku: row.seller_sku || row.sku,
        asin: row.asin1 || row.asin,
        productName: row.item_name || row.product_name || row.title,
        price: parseFloat(row.price) || 0,
        quantity: parseInt(row.quantity) || 0,
        fulfillmentChannel: row.fulfillment_channel || 'DEFAULT', // DEFAULT = FBM, AMAZON_NA/EU = FBA
        status: row.status || 'Active',
        marketplace: marketplace // Use the marketplace the report was requested from
      });
    }

    return listings.filter(l => l.sellerSku);
  }

  /**
   * Get safety stock values from MongoDB for multiple Odoo SKUs
   * @param {string[]} odooSkus
   * @returns {Map<string, number>} Map of odooSku → safety stock value
   */
  async getSafetyStock(odooSkus) {
    const safetyStockMap = new Map();

    // Initialize all with default
    for (const sku of odooSkus) {
      safetyStockMap.set(sku, 10); // Default safety stock
    }

    try {
      const products = await Product.find({ sku: { $in: odooSkus } })
        .select('sku safetyStock')
        .lean();

      for (const p of products) {
        if (p.sku) {
          safetyStockMap.set(p.sku, p.safetyStock ?? 10);
        }
      }
    } catch (error) {
      console.error('[SellerFbmStockExport] Error fetching safety stock:', error.message);
    }

    return safetyStockMap;
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
   * @returns {Object} Sync results with detailed tracking for reporting
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
      detailedResults: [], // For Excel report
      feedId: null,
      feedItemCount: 0,
      summary: {
        totalSkus: 0,
        updated: 0,
        unchanged: 0,
        increases: 0,
        decreases: 0,
        zeroStock: 0
      }
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

      // Step 2: Resolve each Seller SKU to Odoo SKU and track marketplaces + current Amazon qty
      console.log('[SellerFbmStockExport] Step 2: Resolving SKUs...');
      const resolvedItems = [];
      const unresolvedItems = [];

      // Group listings by SKU to collect all marketplaces for each SKU
      const skuMarketplaces = new Map();
      for (const listing of fbmListings) {
        const sku = listing.sellerSku;
        if (!skuMarketplaces.has(sku)) {
          skuMarketplaces.set(sku, {
            listing,
            marketplaces: new Set(),
            amazonQtyBefore: listing.quantity || 0 // Current Amazon quantity
          });
        }
        // Add marketplace if present
        if (listing.marketplace && listing.marketplace !== 'ALL') {
          skuMarketplaces.get(sku).marketplaces.add(listing.marketplace);
        }
      }

      for (const [sellerSku, data] of skuMarketplaces) {
        const resolution = skuResolver.resolve(sellerSku);
        const listing = data.listing;
        const marketplaces = [...data.marketplaces];

        if (resolution.odooSku) {
          resolvedItems.push({
            sellerSku,
            odooSku: resolution.odooSku,
            asin: listing.asin,
            productName: listing.productName,
            matchType: resolution.matchType,
            marketplaces: marketplaces.length > 0 ? marketplaces : FBM_TARGET_MARKETPLACES, // All 7 FBM marketplaces
            amazonQtyBefore: data.amazonQtyBefore
          });
        } else {
          unresolvedItems.push({
            sellerSku,
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

      // Step 3: Get CW stock AND safety stock for resolved Odoo SKUs
      console.log('[SellerFbmStockExport] Step 3: Getting CW stock and safety stock...');
      const odooSkus = [...new Set(resolvedItems.map(i => i.odooSku))];
      const [stockMap, safetyStockMap] = await Promise.all([
        this.getCwStock(odooSkus),
        this.getSafetyStock(odooSkus)
      ]);

      // Step 4: Build stock items with safety stock deduction and detailed tracking
      console.log('[SellerFbmStockExport] Step 4: Building stock items with safety stock deduction...');
      const stockItems = [];
      const detailedResults = [];

      for (const item of resolvedItems) {
        const cwFreeQty = stockMap.get(item.odooSku) || 0;
        const safetyStock = safetyStockMap.get(item.odooSku) || 10;

        // Apply safety stock deduction: send max(0, cwFreeQty - safetyStock) to Amazon
        const newAmazonQty = Math.max(0, cwFreeQty - safetyStock);
        const delta = newAmazonQty - item.amazonQtyBefore;

        stockItems.push({
          sellerSku: item.sellerSku,
          odooSku: item.odooSku,
          quantity: newAmazonQty,
          fulfillmentLatency: 3,
          marketplaces: item.marketplaces || FBM_TARGET_MARKETPLACES
        });

        // Track detailed result for reporting
        detailedResults.push({
          asin: item.asin || '',
          amazonSku: item.sellerSku,
          odooSku: item.odooSku,
          productName: item.productName || '',
          amazonQtyBefore: item.amazonQtyBefore,
          cwQty: cwFreeQty + (cwFreeQty > 0 ? 0 : 0), // Total CW stock (before reserved)
          cwFreeQty: cwFreeQty,
          safetyStock: safetyStock,
          newAmazonQty: newAmazonQty,
          delta: delta,
          status: 'pending', // Will be updated after API call
          error: null,
          marketplaces: item.marketplaces || [] // Include marketplaces for Excel report
        });

        // Update summary counts
        if (delta > 0) result.summary.increases++;
        else if (delta < 0) result.summary.decreases++;
        else result.summary.unchanged++;

        if (newAmazonQty === 0) result.summary.zeroStock++;
      }

      result.stockItems = stockItems;
      result.detailedResults = detailedResults;
      result.summary.totalSkus = stockItems.length;

      console.log(`[SellerFbmStockExport] Safety stock applied: ${result.summary.increases} increases, ${result.summary.decreases} decreases, ${result.summary.unchanged} unchanged, ${result.summary.zeroStock} zero stock`);

      // Step 5: Handle unresolved SKUs
      if (unresolvedItems.length > 0) {
        await this.handleUnresolvedSkus(unresolvedItems);
      }

      // Step 6: Submit to Amazon via Listings Items API (unless dry run)
      if (!dryRun && stockItems.length > 0) {
        console.log('[SellerFbmStockExport] Step 6: Submitting to Amazon via Listings Items API...');
        const updateResult = await this.submitStockViaListingsApi(stockItems);
        result.updateId = updateResult.updateId;
        result.itemsUpdated = updateResult.updated;
        result.itemsFailed = updateResult.failed;
        result.feedItemCount = updateResult.updated; // For backwards compatibility
        result.success = updateResult.success;
        result.summary.updated = updateResult.updated;

        // Update detailed results with API response status
        if (updateResult.details) {
          const statusBySku = new Map();
          for (const detail of updateResult.details) {
            if (!statusBySku.has(detail.sku)) {
              statusBySku.set(detail.sku, { status: detail.status, error: detail.error });
            }
          }
          for (const dr of result.detailedResults) {
            const apiStatus = statusBySku.get(dr.amazonSku);
            if (apiStatus) {
              dr.status = apiStatus.status;
              dr.error = apiStatus.error;
            }
          }
        }

        if (!updateResult.success) {
          result.error = updateResult.error;
        }

        // IMPORTANT: Update cached listings with new quantities
        // This prevents the next sync from recalculating the same deltas
        await this.updateCachedQuantities(stockItems);
      } else if (dryRun) {
        result.success = true;
        result.message = 'Dry run - no updates submitted';
        // Mark all as skipped for dry run
        for (const dr of result.detailedResults) {
          dr.status = 'skipped';
        }
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
   * Submit stock updates via Listings Items API (patchListingsItem)
   * This replaces the old Feeds API approach which is restricted
   *
   * @param {Array} stockItems - Array of { sellerSku, quantity, marketplaces }
   * @returns {Object} { success, updated, failed, errors, updateId }
   */
  async submitStockViaListingsApi(stockItems) {
    await this.init();

    if (stockItems.length === 0) {
      return { success: true, message: 'No items to update', updated: 0, failed: 0 };
    }

    const sellerId = process.env.AMAZON_SELLER_ID || 'A1GJ5ZORIRYSYA';
    const spClient = await this.client.getClient();
    const now = new Date();
    const updateId = `stock_update_${now.getTime()}`;

    const results = {
      success: true,
      updateId,
      updated: 0,
      failed: 0,
      errors: [],
      details: []
    };

    console.log(`[SellerFbmStockExport] Starting Listings Items API updates for ${stockItems.length} SKUs...`);

    // Process each SKU
    for (let i = 0; i < stockItems.length; i++) {
      const item = stockItems[i];
      const marketplaces = item.marketplaces || FBM_TARGET_MARKETPLACES;

      // Update each marketplace for this SKU
      for (const marketplaceCode of marketplaces) {
        // Convert marketplace code (DE, FR, etc.) to marketplace ID
        const marketplaceId = MARKETPLACE_IDS[marketplaceCode];
        if (!marketplaceId) {
          console.warn(`[SellerFbmStockExport] Unknown marketplace code: ${marketplaceCode}, skipping`);
          continue;
        }

        try {
          // Use Listings Items API to update inventory
          const patchBody = {
            productType: 'PRODUCT',
            patches: [{
              op: 'replace',
              path: '/attributes/fulfillment_availability',
              value: [{
                fulfillment_channel_code: 'DEFAULT',
                quantity: item.quantity
              }]
            }]
          };

          await spClient.callAPI({
            operation: 'listingsItems.patchListingsItem',
            path: {
              sellerId,
              sku: item.sellerSku
            },
            query: {
              marketplaceIds: [marketplaceId]
            },
            body: patchBody
          });

          results.updated++;
          results.details.push({
            sku: item.sellerSku,
            marketplace: marketplaceCode,
            quantity: item.quantity,
            status: 'success'
          });

        } catch (error) {
          results.failed++;
          results.errors.push({
            sku: item.sellerSku,
            marketplace: marketplaceCode,
            error: error.message
          });
          results.details.push({
            sku: item.sellerSku,
            marketplace: marketplaceCode,
            quantity: item.quantity,
            status: 'failed',
            error: error.message
          });
          console.error(`[SellerFbmStockExport] Failed to update ${item.sellerSku} on ${marketplaceCode}: ${error.message}`);
        }

        // Rate limiting - wait between API calls
        await sleep(API_DELAY_MS);
      }

      // Progress logging every 50 SKUs
      if ((i + 1) % 50 === 0) {
        console.log(`[SellerFbmStockExport] Progress: ${i + 1}/${stockItems.length} SKUs processed (${results.updated} updated, ${results.failed} failed)`);
      }
    }

    // Store update record in MongoDB
    await this.db.collection(STOCK_UPDATES_COLLECTION).insertOne({
      updateId,
      method: 'listings_items_api',
      itemCount: stockItems.length,
      updated: results.updated,
      failed: results.failed,
      errors: results.errors.slice(0, 100), // Limit stored errors
      submittedAt: now,
      completedAt: new Date(),
      summary: {
        totalSkus: stockItems.length,
        totalQuantity: stockItems.reduce((sum, i) => sum + i.quantity, 0),
        zeroStock: stockItems.filter(i => i.quantity === 0).length
      }
    });

    // Also store in feeds collection for backwards compatibility with stats
    await this.db.collection(FEEDS_COLLECTION).insertOne({
      feedId: updateId,
      feedType: 'LISTINGS_ITEMS_API',
      itemCount: stockItems.length,
      status: 'DONE',
      submittedAt: now,
      processed: true,
      processedAt: new Date(),
      summary: {
        resolved: stockItems.length,
        updated: results.updated,
        failed: results.failed,
        totalQuantity: stockItems.reduce((sum, i) => sum + i.quantity, 0),
        zeroStock: stockItems.filter(i => i.quantity === 0).length
      }
    });

    console.log(`[SellerFbmStockExport] Completed: ${results.updated} updated, ${results.failed} failed`);

    results.success = results.failed < results.updated; // Consider success if more succeeded than failed

    return results;
  }

  /**
   * @deprecated Use submitStockViaListingsApi instead
   * Kept for backwards compatibility - redirects to new method
   */
  async submitFeed(stockItems) {
    console.warn('[SellerFbmStockExport] submitFeed is deprecated, using submitStockViaListingsApi');
    return this.submitStockViaListingsApi(stockItems);
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
   * Update cached quantities in the FBM listings collection after successful stock push
   * This is CRITICAL to prevent the same delta from being recalculated on the next sync
   *
   * @param {Array} stockItems - Array of { sellerSku, quantity, marketplaces }
   */
  async updateCachedQuantities(stockItems) {
    if (!stockItems || stockItems.length === 0) return;

    const now = new Date();
    let updated = 0;

    try {
      const bulkOps = [];

      for (const item of stockItems) {
        // Update all marketplace entries for this SKU
        bulkOps.push({
          updateMany: {
            filter: { sellerSku: item.sellerSku },
            update: {
              $set: {
                quantity: item.quantity,
                lastStockSyncAt: now
              }
            }
          }
        });
      }

      if (bulkOps.length > 0) {
        const result = await this.db.collection(FBM_LISTINGS_COLLECTION).bulkWrite(bulkOps);
        updated = result.modifiedCount || 0;
      }

      console.log(`[SellerFbmStockExport] Updated cached quantities for ${updated} listings`);

    } catch (error) {
      console.error('[SellerFbmStockExport] Error updating cached quantities:', error.message);
      // Don't throw - this is not critical enough to fail the whole sync
    }
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
