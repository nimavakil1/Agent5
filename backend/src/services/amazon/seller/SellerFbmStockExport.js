/**
 * SellerFbmStockExport - Simplified FBM stock sync from Odoo to Amazon
 *
 * Flow:
 * 1. Daily: Fetch FBM listings from all marketplaces (to know which SKUs exist where)
 * 2. Every 30 min: Get CW stock, apply safety stock, send to Amazon
 * 3. Send report to Teams with Excel showing what was sent
 *
 * Simple approach:
 * - No "before" tracking or delta calculation
 * - Just send current stock levels to Amazon
 * - Report shows what was sent, not what changed
 *
 * @module SellerFbmStockExport
 */

const ExcelJS = require('exceljs');
const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { skuResolver } = require('../SkuResolver');
const { TeamsNotificationService } = require('../../../core/agents/services/TeamsNotificationService');
const { MARKETPLACE_IDS } = require('./SellerMarketplaceConfig');
const Product = require('../../../models/Product');
const oneDriveService = require('../../onedriveService');

// Report folder for unresolved SKUs
const UNRESOLVED_SKUS_REPORTS_FOLDER = 'FBM_Unresolved_SKUs';

// Rate limiting for Listings Items API
const API_DELAY_MS = 200;

// Report type for listings
const LISTINGS_REPORT_TYPE = 'GET_MERCHANT_LISTINGS_DATA';

// Collections
const FBM_LISTINGS_COLLECTION = 'amazon_fbm_listings';
const STOCK_UPDATES_COLLECTION = 'amazon_stock_updates';
const UNRESOLVED_SKUS_COLLECTION = 'amazon_unresolved_skus';

// Target marketplaces for FBM stock sync
const FBM_TARGET_MARKETPLACES = ['DE', 'FR', 'NL', 'BE', 'ES', 'IT', 'UK'];

// Helper for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * SellerFbmStockExport - Simplified FBM stock sync
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

  // ============================================
  // DAILY: Refresh FBM listings from all marketplaces
  // ============================================

  /**
   * Request listings reports from all marketplaces (run daily)
   * @returns {Object} { success, reports: [{ marketplace, reportId }] }
   */
  async requestAllMarketplaceReports() {
    await this.init();

    const results = [];
    const spClient = await this.client.getClient();

    for (const marketplaceCode of FBM_TARGET_MARKETPLACES) {
      try {
        const marketplaceId = MARKETPLACE_IDS[marketplaceCode];
        if (!marketplaceId) continue;

        const response = await spClient.callAPI({
          operation: 'reports.createReport',
          body: {
            reportType: LISTINGS_REPORT_TYPE,
            marketplaceIds: [marketplaceId]
          }
        });

        const reportId = response.reportId;
        console.log(`[SellerFbmStockExport] Requested listings report for ${marketplaceCode}: ${reportId}`);

        // Store report request
        await this.db.collection('seller_reports').insertOne({
          reportId,
          reportType: LISTINGS_REPORT_TYPE,
          marketplace: marketplaceCode,
          purpose: 'fbm_listings_refresh',
          status: 'IN_QUEUE',
          requestedAt: new Date(),
          processed: false
        });

        results.push({ marketplace: marketplaceCode, reportId });

        // Small delay between requests
        await sleep(500);

      } catch (error) {
        console.error(`[SellerFbmStockExport] Error requesting report for ${marketplaceCode}:`, error.message);
      }
    }

    console.log(`[SellerFbmStockExport] Requested ${results.length}/${FBM_TARGET_MARKETPLACES.length} marketplace reports`);
    return { success: results.length > 0, reports: results };
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
   */
  async downloadAndProcessListings(reportId, documentId, marketplace) {
    const spClient = await this.client.getClient();

    try {
      const docResponse = await spClient.callAPI({
        operation: 'reports.getReportDocument',
        path: { reportDocumentId: documentId }
      });

      const reportData = await spClient.download(docResponse, { json: false });
      const listings = this.parseListingsReport(reportData, marketplace);

      console.log(`[SellerFbmStockExport] Parsed ${listings.length} listings from ${marketplace}`);

      // Store/update in MongoDB
      const now = new Date();
      const operations = listings.map(listing => ({
        updateOne: {
          filter: { sellerSku: listing.sellerSku, marketplace: listing.marketplace },
          update: {
            $set: { ...listing, updatedAt: now },
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

      console.log(`[SellerFbmStockExport] Stored ${listings.length} ${marketplace} FBM listings`);

    } catch (error) {
      console.error(`[SellerFbmStockExport] Error processing ${marketplace} report:`, error.message);
      throw error;
    }
  }

  /**
   * Parse listings report (TSV format)
   */
  parseListingsReport(data, marketplace) {
    const lines = data.toString().split('\n');
    const listings = [];

    if (lines.length < 2) return listings;

    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '_'));

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      if (values.length < 2) continue;

      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx]?.trim() || '';
      });

      const fulfillmentChannel = row.fulfillment_channel || 'DEFAULT';

      // Only FBM listings (DEFAULT = Merchant Fulfilled)
      if (fulfillmentChannel !== 'DEFAULT') continue;

      listings.push({
        sellerSku: row.seller_sku || row.sku,
        asin: row.asin1 || row.asin,
        productName: row.item_name || row.product_name || row.title,
        fulfillmentChannel: 'DEFAULT',
        status: row.status || 'Active',
        marketplace: marketplace
      });
    }

    return listings.filter(l => l.sellerSku);
  }

  // ============================================
  // EVERY 30 MIN: Sync stock levels to Amazon
  // ============================================

  /**
   * Get FBM listings grouped by SKU with their marketplaces
   */
  async getFbmListingsGrouped() {
    await this.init();

    // First, try to process any pending reports
    await this.processListingsReports();

    // Get all FBM listings
    const listings = await this.db.collection(FBM_LISTINGS_COLLECTION)
      .find({ fulfillmentChannel: 'DEFAULT' })
      .toArray();

    if (listings.length === 0) {
      console.log('[SellerFbmStockExport] No FBM listings in cache, requesting reports...');
      await this.requestAllMarketplaceReports();
      return [];
    }

    // Group by SKU to collect marketplaces
    const skuMap = new Map();
    for (const listing of listings) {
      const sku = listing.sellerSku;
      if (!skuMap.has(sku)) {
        skuMap.set(sku, {
          sellerSku: sku,
          asin: listing.asin,
          productName: listing.productName,
          marketplaces: new Set()
        });
      }
      if (listing.marketplace) {
        skuMap.get(sku).marketplaces.add(listing.marketplace);
      }
    }

    // Convert to array with marketplace arrays
    const grouped = [];
    for (const [sku, data] of skuMap) {
      grouped.push({
        sellerSku: data.sellerSku,
        asin: data.asin,
        productName: data.productName,
        marketplaces: [...data.marketplaces]
      });
    }

    console.log(`[SellerFbmStockExport] ${grouped.length} unique FBM SKUs across ${listings.length} marketplace listings`);
    return grouped;
  }

  /**
   * Get safety stock values from MongoDB
   */
  async getSafetyStock(odooSkus) {
    const safetyStockMap = new Map();

    for (const sku of odooSkus) {
      safetyStockMap.set(sku, 10); // Default
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
   */
  async getCwStock(odooSkus) {
    await this.init();

    if (!this.centralLocationId) {
      throw new Error('Central Warehouse not configured');
    }

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
    if (productIds.length === 0) return new Map();

    const quants = await this.odoo.searchRead('stock.quant',
      [
        ['product_id', 'in', productIds],
        ['location_id', '=', this.centralLocationId]
      ],
      ['product_id', 'quantity', 'reserved_quantity']
    );

    const stockMap = new Map();
    for (const sku of odooSkus) {
      stockMap.set(sku, 0);
    }

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
   * Main sync function - simplified approach
   * @param {Object} options
   * @param {boolean} options.dryRun - Don't submit to Amazon
   * @returns {Object} Sync results
   */
  async syncStock(options = {}) {
    await this.init();

    const { dryRun = false } = options;
    const result = {
      success: false,
      totalSkus: 0,
      resolved: 0,
      unresolved: 0,
      unresolvedSkus: [],
      sentItems: [], // What we sent to Amazon
      itemsUpdated: 0,
      itemsFailed: 0,
      summary: {
        totalSkus: 0,
        zeroStock: 0,
        withStock: 0,
        belowSafetyStock: 0  // Products with 0 < cwFreeQty < safetyStock (have stock but listed as 0)
      }
    };

    try {
      // Step 1: Get FBM listings (grouped by SKU with marketplaces)
      console.log('[SellerFbmStockExport] Step 1: Getting FBM listings...');
      const fbmListings = await this.getFbmListingsGrouped();

      if (fbmListings.length === 0) {
        result.success = true;
        result.message = 'No FBM listings found. Reports may be processing.';
        return result;
      }

      console.log(`[SellerFbmStockExport] Found ${fbmListings.length} FBM SKUs`);

      // Step 2: Resolve SKUs to Odoo
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
            marketplaces: listing.marketplaces.length > 0 ? listing.marketplaces : FBM_TARGET_MARKETPLACES
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

      // Step 3: Get CW stock and safety stock
      console.log('[SellerFbmStockExport] Step 3: Getting CW stock and safety stock...');
      const odooSkus = [...new Set(resolvedItems.map(i => i.odooSku))];
      const [stockMap, safetyStockMap] = await Promise.all([
        this.getCwStock(odooSkus),
        this.getSafetyStock(odooSkus)
      ]);

      // Step 4: Build stock items to send
      console.log('[SellerFbmStockExport] Step 4: Calculating stock to send...');
      const stockItems = [];
      const sentItems = [];

      for (const item of resolvedItems) {
        const cwFreeQty = stockMap.get(item.odooSku) || 0;
        const safetyStock = safetyStockMap.get(item.odooSku) || 10;
        const amazonQty = Math.max(0, cwFreeQty - safetyStock);

        stockItems.push({
          sellerSku: item.sellerSku,
          odooSku: item.odooSku,
          quantity: amazonQty,
          marketplaces: item.marketplaces
        });

        // Track what we're sending (for report)
        sentItems.push({
          asin: item.asin || '',
          amazonSku: item.sellerSku,
          odooSku: item.odooSku,
          productName: item.productName || '',
          cwFreeQty: cwFreeQty,
          safetyStock: safetyStock,
          sentQty: amazonQty,
          marketplaces: item.marketplaces,
          status: 'pending'
        });

        if (amazonQty === 0) {
          result.summary.zeroStock++;
          // Track products that have some stock but below safety stock
          if (cwFreeQty > 0 && cwFreeQty < safetyStock) {
            result.summary.belowSafetyStock++;
          }
        } else {
          result.summary.withStock++;
        }
      }

      result.totalSkus = stockItems.length;
      result.summary.totalSkus = stockItems.length;
      result.sentItems = sentItems;

      console.log(`[SellerFbmStockExport] ${result.summary.withStock} with stock, ${result.summary.zeroStock} zero (${result.summary.belowSafetyStock} below safety stock)`);

      // Step 5: Handle unresolved SKUs
      if (unresolvedItems.length > 0) {
        await this.handleUnresolvedSkus(unresolvedItems);
      }

      // Step 6: Submit to Amazon
      if (!dryRun && stockItems.length > 0) {
        console.log('[SellerFbmStockExport] Step 6: Sending to Amazon...');
        const updateResult = await this.submitStockViaListingsApi(stockItems);
        result.itemsUpdated = updateResult.updated;
        result.itemsFailed = updateResult.failed;
        result.success = updateResult.success;

        // Update sentItems status based on API response
        if (updateResult.details) {
          const statusBySku = new Map();
          for (const detail of updateResult.details) {
            if (!statusBySku.has(detail.sku)) {
              statusBySku.set(detail.sku, { status: detail.status, error: detail.error });
            }
          }
          for (const item of result.sentItems) {
            const apiStatus = statusBySku.get(item.amazonSku);
            if (apiStatus) {
              item.status = apiStatus.status;
              item.error = apiStatus.error;
            }
          }
        }

        if (!updateResult.success) {
          result.error = updateResult.error;
        }
      } else if (dryRun) {
        result.success = true;
        result.message = 'Dry run - no updates sent';
        for (const item of result.sentItems) {
          item.status = 'dry_run';
        }
      } else {
        result.success = true;
        result.message = 'No items to send';
      }

      return result;

    } catch (error) {
      console.error('[SellerFbmStockExport] Sync error:', error.message);
      result.error = error.message;
      return result;
    }
  }

  /**
   * Submit stock updates via Listings Items API
   */
  async submitStockViaListingsApi(stockItems) {
    await this.init();

    if (stockItems.length === 0) {
      return { success: true, updated: 0, failed: 0 };
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

    console.log(`[SellerFbmStockExport] Sending stock for ${stockItems.length} SKUs...`);

    for (let i = 0; i < stockItems.length; i++) {
      const item = stockItems[i];
      const marketplaces = item.marketplaces || FBM_TARGET_MARKETPLACES;

      for (const marketplaceCode of marketplaces) {
        const marketplaceId = MARKETPLACE_IDS[marketplaceCode];
        if (!marketplaceId) continue;

        try {
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
            path: { sellerId, sku: item.sellerSku },
            query: { marketplaceIds: [marketplaceId] },
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
          console.error(`[SellerFbmStockExport] Failed ${item.sellerSku} on ${marketplaceCode}: ${error.message}`);
        }

        await sleep(API_DELAY_MS);
      }

      if ((i + 1) % 50 === 0) {
        console.log(`[SellerFbmStockExport] Progress: ${i + 1}/${stockItems.length} SKUs`);
      }
    }

    // Store record
    await this.db.collection(STOCK_UPDATES_COLLECTION).insertOne({
      updateId,
      method: 'listings_items_api',
      itemCount: stockItems.length,
      updated: results.updated,
      failed: results.failed,
      submittedAt: now,
      summary: {
        totalSkus: stockItems.length,
        totalQuantity: stockItems.reduce((sum, i) => sum + i.quantity, 0),
        zeroStock: stockItems.filter(i => i.quantity === 0).length
      }
    });

    console.log(`[SellerFbmStockExport] Completed: ${results.updated} sent, ${results.failed} failed`);
    results.success = results.failed < results.updated;

    return results;
  }

  /**
   * Handle unresolved SKUs
   */
  async handleUnresolvedSkus(unresolvedItems) {
    const now = new Date();

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
    await this.sendUnresolvedSkusNotification(unresolvedItems);
  }

  /**
   * Generate Excel report for unresolved SKUs
   */
  async generateUnresolvedSkusExcel(unresolvedItems) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Agent5 FBM Stock Export';
    workbook.created = new Date();

    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

    const worksheet = workbook.addWorksheet('Unresolved SKUs', {
      views: [{ state: 'frozen', ySplit: 2 }]
    });

    worksheet.addRow(['FBM Stock Sync - Unresolved SKUs', '', '', '', dateStr]);
    worksheet.mergeCells('A1:D1');
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('E1').font = { italic: true, size: 10 };

    worksheet.addRow(['Amazon SKU', 'ASIN', 'Product Name', 'Reason', 'First Seen', 'Times Seen']);
    const headerRow = worksheet.getRow(2);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF8C00' } };

    worksheet.columns = [
      { width: 30 }, { width: 15 }, { width: 40 }, { width: 25 }, { width: 18 }, { width: 12 }
    ];

    for (const item of unresolvedItems) {
      worksheet.addRow([
        item.sellerSku,
        item.asin || '-',
        item.productName || '-',
        item.reason || 'Not found in Odoo',
        item.createdAt ? new Date(item.createdAt).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '-',
        item.seenCount || 1
      ]);
    }

    if (unresolvedItems.length === 0) {
      worksheet.addRow(['No unresolved SKUs', '', '', '', '', '']);
    }

    return workbook.xlsx.writeBuffer();
  }

  /**
   * Send Teams notification for unresolved SKUs
   */
  async sendUnresolvedSkusNotification(unresolvedItems) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) return;

    // Only notify for new unresolved SKUs
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

    if (newUnresolved.length === 0) return;

    // Generate and upload Excel report
    let reportUrl = null;
    try {
      const excelBuffer = await this.generateUnresolvedSkusExcel(unresolvedItems);
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const fileName = `FBM_Unresolved_SKUs_${timestamp}.xlsx`;

      const uploadResult = await oneDriveService.uploadReport(excelBuffer, fileName, UNRESOLVED_SKUS_REPORTS_FOLDER);
      reportUrl = uploadResult.url;
      console.log(`[SellerFbmStockExport] Excel report uploaded: ${reportUrl}`);
    } catch (uploadError) {
      console.error('[SellerFbmStockExport] Failed to upload Excel report:', uploadError.message);
    }

    try {
      const teams = new TeamsNotificationService({ webhookUrl });

      const skuList = newUnresolved.slice(0, 10).map(item =>
        `- **${item.sellerSku}** (${item.asin || 'no ASIN'})`
      ).join('\n');

      const actions = [];
      if (reportUrl) {
        actions.push({
          type: 'Action.OpenUrl',
          title: '📊 Download Excel Report',
          url: reportUrl
        });
      }

      const card = {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: `⚠️ FBM Stock Sync: ${newUnresolved.length} Unresolved SKUs`,
            weight: 'bolder',
            size: 'medium',
            color: 'warning'
          },
          {
            type: 'TextBlock',
            text: `Total unresolved: ${unresolvedItems.length} | New: ${newUnresolved.length}`,
            size: 'small',
            isSubtle: true
          },
          {
            type: 'TextBlock',
            text: skuList + (newUnresolved.length > 10 ? `\n\n...and ${newUnresolved.length - 10} more` : ''),
            wrap: true,
            fontType: 'monospace'
          }
        ]
      };

      if (actions.length > 0) {
        card.body.push({ type: 'ActionSet', actions });
      }

      await teams.sendMessage(card);
      console.log(`[SellerFbmStockExport] Teams notification sent for ${newUnresolved.length} unresolved SKUs`);

    } catch (error) {
      console.error('[SellerFbmStockExport] Failed to send Teams notification:', error.message);
    }
  }

  /**
   * Get statistics
   */
  async getStats() {
    await this.init();

    const [
      fbmListingsCount,
      lastUpdate,
      unresolvedCount
    ] = await Promise.all([
      this.db.collection(FBM_LISTINGS_COLLECTION).countDocuments({ fulfillmentChannel: 'DEFAULT' }),
      this.db.collection(STOCK_UPDATES_COLLECTION).findOne({}, { sort: { submittedAt: -1 } }),
      this.db.collection(UNRESOLVED_SKUS_COLLECTION).countDocuments({ resolved: false })
    ]);

    return {
      fbmListingsInCache: fbmListingsCount,
      lastExportAt: lastUpdate?.submittedAt,
      lastItemCount: lastUpdate?.itemCount,
      lastSummary: lastUpdate?.summary,
      unresolvedSkus: unresolvedCount
    };
  }

  /**
   * Get unresolved SKUs
   */
  async getUnresolvedSkus() {
    await this.init();
    return this.db.collection(UNRESOLVED_SKUS_COLLECTION)
      .find({ resolved: false })
      .sort({ seenCount: -1, lastSeenAt: -1 })
      .toArray();
  }

  /**
   * Mark SKU as resolved
   */
  async markSkuResolved(sellerSku) {
    await this.init();
    await this.db.collection(UNRESOLVED_SKUS_COLLECTION).updateOne(
      { sellerSku },
      { $set: { resolved: true, resolvedAt: new Date() } }
    );
  }
}

// Singleton
let fbmStockExportInstance = null;

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
  LISTINGS_REPORT_TYPE,
  FBM_TARGET_MARKETPLACES
};
