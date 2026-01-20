/**
 * SellerFbaInventorySync - Sync FBA inventory from Amazon to Odoo
 *
 * Rock-solid approach (same as FBM export):
 * 1. Request GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA report
 * 2. Download and parse the report
 * 3. Use SkuResolver to map Amazon SKU → Odoo SKU
 * 4. Update Odoo stock.quant for FBA warehouses
 * 5. Notify via Teams for unresolved SKUs
 *
 * @module SellerFbaInventorySync
 */

const ExcelJS = require('exceljs');
const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { MARKETPLACE_CONFIG, getWarehouseId: _getWarehouseId } = require('./SellerMarketplaceConfig');
const { skuResolver } = require('../SkuResolver');
const { TeamsNotificationService } = require('../../../core/agents/services/TeamsNotificationService');
const oneDriveService = require('../../onedriveService');

// Report folder for FBA unresolved SKUs
const FBA_UNRESOLVED_SKUS_REPORTS_FOLDER = 'FBA_Unresolved_SKUs';

// FBA Inventory report type
const FBA_INVENTORY_REPORT = 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA';

// Collection for tracking report requests
const REPORTS_COLLECTION = 'seller_reports';

// Collection for unresolved SKUs (shared with FBM)
const UNRESOLVED_SKUS_COLLECTION = 'amazon_unresolved_skus';

/**
 * SellerFbaInventorySync - Syncs FBA inventory to Odoo
 */
class SellerFbaInventorySync {
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

    // Load SKU resolver for Amazon → Odoo mapping
    await skuResolver.load();
  }

  /**
   * Request a new FBA inventory report
   */
  async requestReport() {
    await this.init();

    try {
      const spClient = await this.client.getClient();

      // Request the report
      const response = await spClient.callAPI({
        operation: 'reports.createReport',
        body: {
          reportType: FBA_INVENTORY_REPORT,
          marketplaceIds: Object.values(MARKETPLACE_CONFIG).map(m => m.marketplaceId)
        }
      });

      const reportId = response.reportId;
      console.log(`[SellerFbaInventorySync] Requested report ${reportId}`);

      // Store report request
      await this.db.collection(REPORTS_COLLECTION).insertOne({
        reportId,
        reportType: FBA_INVENTORY_REPORT,
        status: 'IN_QUEUE',
        requestedAt: new Date(),
        processed: false
      });

      return { success: true, reportId };

    } catch (error) {
      console.error('[SellerFbaInventorySync] Error requesting report:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check status of pending reports and process completed ones
   */
  async processReports() {
    await this.init();

    const result = {
      checked: 0,
      processed: 0,
      errors: []
    };

    try {
      // Find pending reports
      const pendingReports = await this.db.collection(REPORTS_COLLECTION).find({
        reportType: FBA_INVENTORY_REPORT,
        processed: false,
        status: { $nin: ['CANCELLED', 'FATAL'] }
      }).toArray();

      console.log(`[SellerFbaInventorySync] Checking ${pendingReports.length} pending reports`);
      result.checked = pendingReports.length;

      const spClient = await this.client.getClient();

      for (const report of pendingReports) {
        try {
          // Check report status
          const statusResponse = await spClient.callAPI({
            operation: 'reports.getReport',
            path: { reportId: report.reportId }
          });

          const status = statusResponse.processingStatus;

          // Update status in DB
          await this.db.collection(REPORTS_COLLECTION).updateOne(
            { reportId: report.reportId },
            { $set: { status, updatedAt: new Date() } }
          );

          if (status === 'DONE') {
            // Download and process the report
            const documentId = statusResponse.reportDocumentId;
            await this.downloadAndProcessReport(report.reportId, documentId);
            result.processed++;

          } else if (status === 'FATAL' || status === 'CANCELLED') {
            console.log(`[SellerFbaInventorySync] Report ${report.reportId} failed: ${status}`);
            result.errors.push({ reportId: report.reportId, status });
          }

        } catch (error) {
          result.errors.push({ reportId: report.reportId, error: error.message });
          console.error(`[SellerFbaInventorySync] Error checking report ${report.reportId}:`, error.message);
        }
      }

    } catch (error) {
      result.errors.push({ error: error.message });
      console.error('[SellerFbaInventorySync] Process error:', error);
    }

    return result;
  }

  /**
   * Download and process a completed report
   */
  async downloadAndProcessReport(reportId, documentId) {
    const spClient = await this.client.getClient();

    try {
      // Get document details
      const docResponse = await spClient.callAPI({
        operation: 'reports.getReportDocument',
        path: { reportDocumentId: documentId }
      });

      // Download the report
      const reportData = await spClient.download(docResponse, { json: false });

      // Parse TSV data
      const inventory = this.parseInventoryReport(reportData);

      console.log(`[SellerFbaInventorySync] Parsed ${inventory.length} inventory items`);

      // Update Odoo
      const updateResult = await this.updateOdooInventory(inventory);

      // Mark report as processed
      await this.db.collection(REPORTS_COLLECTION).updateOne(
        { reportId },
        {
          $set: {
            processed: true,
            processedAt: new Date(),
            itemCount: inventory.length,
            updateResult
          }
        }
      );

      console.log(`[SellerFbaInventorySync] Processed report ${reportId}: ${updateResult.updated} items updated`);

    } catch (error) {
      console.error(`[SellerFbaInventorySync] Error processing report ${reportId}:`, error.message);
      throw error;
    }
  }

  /**
   * Parse FBA inventory report (TSV format)
   */
  parseInventoryReport(data) {
    const lines = data.toString().split('\n');
    const inventory = [];

    if (lines.length < 2) return inventory;

    // Parse header
    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '_'));

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      if (values.length < 2) continue;

      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx]?.trim() || '';
      });

      // Standard FBA inventory report fields
      inventory.push({
        sku: row.sku || row.seller_sku,
        asin: row.asin,
        fnsku: row.fnsku,
        productName: row.product_name || row.title,
        condition: row.condition || 'New',
        quantity: parseInt(row.afn_fulfillable_quantity || row.quantity || 0, 10),
        warehouseQuantity: parseInt(row.afn_warehouse_quantity || 0, 10),
        inboundQuantity: parseInt(row.afn_inbound_shipped_quantity || 0, 10),
        reservedQuantity: parseInt(row.afn_reserved_quantity || 0, 10),
        unfulfillableQuantity: parseInt(row.afn_unsellable_quantity || 0, 10),
        fulfillmentCenter: row.fulfillment_center_id || ''
      });
    }

    return inventory.filter(item => item.sku);
  }

  /**
   * Update Odoo inventory with FBA stock levels
   * Uses SkuResolver for rock-solid Amazon → Odoo SKU mapping
   */
  async updateOdooInventory(inventory) {
    const result = {
      updated: 0,
      resolved: 0,
      unresolved: 0,
      unresolvedSkus: [],
      errors: []
    };

    // Group by SKU (sum quantities across fulfillment centers)
    const skuQuantities = {};
    for (const item of inventory) {
      if (!skuQuantities[item.sku]) {
        skuQuantities[item.sku] = {
          amazonSku: item.sku,
          asin: item.asin,
          productName: item.productName,
          quantity: 0,
          warehouseQuantity: 0,
          inboundQuantity: 0,
          reservedQuantity: 0
        };
      }
      skuQuantities[item.sku].quantity += item.quantity;
      skuQuantities[item.sku].warehouseQuantity += item.warehouseQuantity;
      skuQuantities[item.sku].inboundQuantity += item.inboundQuantity;
      skuQuantities[item.sku].reservedQuantity += item.reservedQuantity;
    }

    // Step 1: Resolve all Amazon SKUs to Odoo SKUs
    console.log(`[SellerFbaInventorySync] Resolving ${Object.keys(skuQuantities).length} Amazon SKUs...`);

    const resolvedItems = [];
    const unresolvedItems = [];

    for (const [amazonSku, data] of Object.entries(skuQuantities)) {
      const resolution = skuResolver.resolve(amazonSku);

      if (resolution.odooSku) {
        resolvedItems.push({
          amazonSku,
          odooSku: resolution.odooSku,
          matchType: resolution.matchType,
          ...data
        });
      } else {
        unresolvedItems.push({
          sellerSku: amazonSku,
          asin: data.asin,
          productName: data.productName,
          quantity: data.quantity,
          reason: 'Could not resolve to Odoo SKU (FBA inventory)'
        });
      }
    }

    result.resolved = resolvedItems.length;
    result.unresolved = unresolvedItems.length;
    result.unresolvedSkus = unresolvedItems;

    console.log(`[SellerFbaInventorySync] Resolved: ${resolvedItems.length}, Unresolved: ${unresolvedItems.length}`);

    // Step 2: Handle unresolved SKUs
    if (unresolvedItems.length > 0) {
      await this.handleUnresolvedSkus(unresolvedItems);
    }

    // Step 3: Get FBA warehouse location
    const fbaWarehouses = await this.odoo.searchRead('stock.warehouse',
      [['name', 'like', 'FBA%']],
      ['id', 'name', 'lot_stock_id']
    );

    if (fbaWarehouses.length === 0) {
      console.error('[SellerFbaInventorySync] No FBA warehouses found in Odoo');
      return result;
    }

    const fbaLocationId = fbaWarehouses[0].lot_stock_id[0];
    console.log(`[SellerFbaInventorySync] Using FBA location: ${fbaWarehouses[0].name} (${fbaLocationId})`);

    // Step 4: Update Odoo for resolved items
    // First, batch-fetch all products by Odoo SKU
    const odooSkus = [...new Set(resolvedItems.map(i => i.odooSku))];
    const products = await this.odoo.searchRead('product.product',
      [['default_code', 'in', odooSkus], ['active', '=', true]],
      ['id', 'default_code']
    );

    const skuToProductId = {};
    for (const p of products) {
      if (p.default_code) {
        skuToProductId[p.default_code] = p.id;
      }
    }

    for (const item of resolvedItems) {
      try {
        const productId = skuToProductId[item.odooSku];

        if (!productId) {
          // Odoo SKU doesn't exist as a product
          result.errors.push({
            amazonSku: item.amazonSku,
            odooSku: item.odooSku,
            error: 'Odoo product not found for resolved SKU'
          });
          continue;
        }

        // Find or create quant
        const quants = await this.odoo.searchRead('stock.quant',
          [
            ['product_id', '=', productId],
            ['location_id', '=', fbaLocationId]
          ],
          ['id', 'quantity']
        );

        if (quants.length > 0) {
          // Update existing quant
          await this.odoo.write('stock.quant', [quants[0].id], {
            quantity: item.quantity
          });
        } else {
          // Create new quant
          await this.odoo.create('stock.quant', {
            product_id: productId,
            location_id: fbaLocationId,
            quantity: item.quantity
          });
        }

        result.updated++;

      } catch (error) {
        result.errors.push({ amazonSku: item.amazonSku, odooSku: item.odooSku, error: error.message });
      }
    }

    return result;
  }

  /**
   * Handle unresolved SKUs - store in DB and send Teams notification
   */
  async handleUnresolvedSkus(unresolvedItems) {
    const now = new Date();

    // Store in MongoDB (same collection as FBM for unified tracking)
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
            resolved: false,
            source: 'FBA_INVENTORY' // Track which sync found this
          },
          $setOnInsert: { createdAt: now },
          $inc: { seenCount: 1 }
        },
        upsert: true
      }
    }));

    await this.db.collection(UNRESOLVED_SKUS_COLLECTION).bulkWrite(operations);

    // Send Teams notification for new unresolved SKUs
    await this.sendUnresolvedSkusNotification(unresolvedItems);
  }

  /**
   * Generate Excel report for unresolved FBA SKUs
   */
  async generateUnresolvedSkusExcel(unresolvedItems) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Agent5 FBA Inventory Sync';
    workbook.created = new Date();

    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

    const worksheet = workbook.addWorksheet('Unresolved FBA SKUs', {
      views: [{ state: 'frozen', ySplit: 2 }]
    });

    worksheet.addRow(['FBA Inventory Sync - Unresolved SKUs', '', '', '', '', dateStr]);
    worksheet.mergeCells('A1:E1');
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('F1').font = { italic: true, size: 10 };

    worksheet.addRow(['Amazon SKU', 'ASIN', 'Product Name', 'FBA Quantity', 'Reason', 'First Seen']);
    const headerRow = worksheet.getRow(2);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF8C00' } };

    worksheet.columns = [
      { width: 30 }, { width: 15 }, { width: 40 }, { width: 14 }, { width: 25 }, { width: 18 }
    ];

    for (const item of unresolvedItems) {
      worksheet.addRow([
        item.sellerSku,
        item.asin || '-',
        item.productName || '-',
        item.quantity || 0,
        item.reason || 'Not found in Odoo',
        item.createdAt ? new Date(item.createdAt).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '-'
      ]);
    }

    if (unresolvedItems.length === 0) {
      worksheet.addRow(['No unresolved SKUs', '', '', '', '', '']);
    }

    return workbook.xlsx.writeBuffer();
  }

  /**
   * Send Teams notification for unresolved FBA SKUs
   */
  async sendUnresolvedSkusNotification(unresolvedItems) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) {
      console.log('[SellerFbaInventorySync] No Teams webhook configured, skipping notification');
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

    // Generate and upload Excel report
    let reportUrl = null;
    try {
      const excelBuffer = await this.generateUnresolvedSkusExcel(unresolvedItems);
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const fileName = `FBA_Unresolved_SKUs_${timestamp}.xlsx`;

      const uploadResult = await oneDriveService.uploadReport(excelBuffer, fileName, FBA_UNRESOLVED_SKUS_REPORTS_FOLDER);
      reportUrl = uploadResult.url;
      console.log(`[SellerFbaInventorySync] Excel report uploaded: ${reportUrl}`);
    } catch (uploadError) {
      console.error('[SellerFbaInventorySync] Failed to upload Excel report:', uploadError.message);
    }

    try {
      const teams = new TeamsNotificationService({ webhookUrl });

      const skuList = newUnresolved.slice(0, 10).map(item =>
        `- **${item.sellerSku}** (${item.asin || 'no ASIN'}): ${item.quantity} units`
      ).join('\n');

      const moreText = newUnresolved.length > 10
        ? `\n\n...and ${newUnresolved.length - 10} more`
        : '';

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
            text: `⚠️ Amazon FBA Inventory Sync: ${newUnresolved.length} Unresolved SKUs`,
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
            text: 'The following Amazon FBA SKUs could not be resolved to Odoo products. FBA stock for these items was NOT imported.',
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

      if (actions.length > 0) {
        card.body.push({ type: 'ActionSet', actions });
      }

      await teams.sendMessage(card);
      console.log(`[SellerFbaInventorySync] Teams notification sent for ${newUnresolved.length} unresolved FBA SKUs`);

    } catch (error) {
      console.error('[SellerFbaInventorySync] Failed to send Teams notification:', error.message);
    }
  }

  /**
   * Full sync: request report, wait, and process
   */
  async fullSync() {
    await this.init();

    // Request new report
    const requestResult = await this.requestReport();
    if (!requestResult.success) {
      return { success: false, error: requestResult.error };
    }

    return {
      success: true,
      reportId: requestResult.reportId,
      message: 'Report requested. Use processReports() to check status and process when ready.'
    };
  }

  /**
   * Get sync statistics
   */
  async getStats() {
    await this.init();

    const [
      pendingReports,
      processedReports,
      lastProcessed
    ] = await Promise.all([
      this.db.collection(REPORTS_COLLECTION).countDocuments({
        reportType: FBA_INVENTORY_REPORT,
        processed: false
      }),
      this.db.collection(REPORTS_COLLECTION).countDocuments({
        reportType: FBA_INVENTORY_REPORT,
        processed: true
      }),
      this.db.collection(REPORTS_COLLECTION).findOne(
        { reportType: FBA_INVENTORY_REPORT, processed: true },
        { sort: { processedAt: -1 } }
      )
    ]);

    return {
      pendingReports,
      processedReports,
      lastProcessedAt: lastProcessed?.processedAt,
      lastItemCount: lastProcessed?.itemCount
    };
  }
}

// Singleton instance
let fbaInventorySyncInstance = null;

/**
 * Get the singleton SellerFbaInventorySync instance
 */
async function getSellerFbaInventorySync() {
  if (!fbaInventorySyncInstance) {
    fbaInventorySyncInstance = new SellerFbaInventorySync();
    await fbaInventorySyncInstance.init();
  }
  return fbaInventorySyncInstance;
}

module.exports = {
  SellerFbaInventorySync,
  getSellerFbaInventorySync,
  FBA_INVENTORY_REPORT
};
