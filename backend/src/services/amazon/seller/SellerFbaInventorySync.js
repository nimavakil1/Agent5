/**
 * SellerFbaInventorySync - Sync FBA inventory from Amazon to Odoo
 *
 * Imports FBA inventory levels:
 * 1. Request GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA report
 * 2. Download and parse the report
 * 3. Update Odoo stock.quant for FBA warehouses
 *
 * @module SellerFbaInventorySync
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { MARKETPLACE_CONFIG, getWarehouseId } = require('./SellerMarketplaceConfig');

// FBA Inventory report type
const FBA_INVENTORY_REPORT = 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA';

// Collection for tracking report requests
const REPORTS_COLLECTION = 'seller_reports';

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
   */
  async updateOdooInventory(inventory) {
    const result = {
      updated: 0,
      skipped: 0,
      errors: []
    };

    // Group by SKU (sum quantities across fulfillment centers)
    const skuQuantities = {};
    for (const item of inventory) {
      if (!skuQuantities[item.sku]) {
        skuQuantities[item.sku] = {
          sku: item.sku,
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

    // Get FBA warehouse location (use first FBA warehouse)
    const fbaWarehouses = await this.odoo.searchRead('stock.warehouse',
      [['name', 'like', 'FBA%']],
      ['id', 'name', 'lot_stock_id']
    );

    if (fbaWarehouses.length === 0) {
      console.error('[SellerFbaInventorySync] No FBA warehouses found in Odoo');
      return result;
    }

    // Use the main FBA warehouse location
    const fbaLocationId = fbaWarehouses[0].lot_stock_id[0];

    for (const [sku, data] of Object.entries(skuQuantities)) {
      try {
        // Find product by SKU
        const products = await this.odoo.searchRead('product.product',
          [['default_code', '=', sku]],
          ['id', 'name']
        );

        if (products.length === 0) {
          result.skipped++;
          continue;
        }

        const productId = products[0].id;

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
            quantity: data.quantity
          });
        } else {
          // Create new quant
          await this.odoo.create('stock.quant', {
            product_id: productId,
            location_id: fbaLocationId,
            quantity: data.quantity
          });
        }

        result.updated++;

      } catch (error) {
        result.errors.push({ sku, error: error.message });
      }
    }

    return result;
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
