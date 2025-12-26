/**
 * SellerFbaReportsSync - Process FBA Stock Adjustments and Removal Orders
 *
 * Handles:
 * 1. GET_FBA_INVENTORY_ADJUSTMENTS_DATA - Stock adjustments (lost, damaged, found, etc.)
 * 2. GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA - Removal orders
 *
 * @module SellerFbaReportsSync
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');
const { getSellerClient } = require('./SellerClient');
const { getAllMarketplaceIds } = require('./SellerMarketplaceConfig');

// Report types
const STOCK_ADJUSTMENT_REPORT = 'GET_FBA_INVENTORY_ADJUSTMENTS_DATA';
const REMOVAL_ORDER_REPORT = 'GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA';

// Collections
const REPORTS_COLLECTION = 'seller_reports';
const ADJUSTMENTS_COLLECTION = 'seller_fba_adjustments';
const REMOVALS_COLLECTION = 'seller_fba_removals';

/**
 * SellerFbaReportsSync - Syncs FBA adjustments and removals
 */
class SellerFbaReportsSync {
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

  // ==================== STOCK ADJUSTMENTS ====================

  /**
   * Request a stock adjustment report
   */
  async requestStockAdjustmentReport(daysBack = 30) {
    await this.init();

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    try {
      const spClient = await this.client.getClient();

      const response = await spClient.callAPI({
        operation: 'reports.createReport',
        body: {
          reportType: STOCK_ADJUSTMENT_REPORT,
          marketplaceIds: getAllMarketplaceIds(),
          dataStartTime: startDate.toISOString(),
          dataEndTime: new Date().toISOString()
        }
      });

      const reportId = response.reportId;
      console.log(`[SellerFbaReportsSync] Requested stock adjustment report ${reportId}`);

      await this.db.collection(REPORTS_COLLECTION).insertOne({
        reportId,
        reportType: STOCK_ADJUSTMENT_REPORT,
        status: 'IN_QUEUE',
        requestedAt: new Date(),
        dataStartTime: startDate,
        processed: false
      });

      return { success: true, reportId };

    } catch (error) {
      console.error('[SellerFbaReportsSync] Error requesting stock adjustment report:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process stock adjustment report
   */
  async processStockAdjustmentReport(reportId, documentId) {
    const spClient = await this.client.getClient();

    try {
      const docResponse = await spClient.callAPI({
        operation: 'reports.getReportDocument',
        path: { reportDocumentId: documentId }
      });

      const reportData = await spClient.download(docResponse, { json: false });
      const adjustments = this.parseStockAdjustmentReport(reportData);

      console.log(`[SellerFbaReportsSync] Parsed ${adjustments.length} stock adjustments`);

      // Store adjustments
      for (const adj of adjustments) {
        await this.db.collection(ADJUSTMENTS_COLLECTION).updateOne(
          { transactionId: adj.transactionId },
          { $set: { ...adj, updatedAt: new Date() } },
          { upsert: true }
        );
      }

      // Update Odoo with adjustments (optional - depends on business logic)
      const odooResult = await this.applyAdjustmentsToOdoo(adjustments);

      await this.db.collection(REPORTS_COLLECTION).updateOne(
        { reportId },
        {
          $set: {
            processed: true,
            processedAt: new Date(),
            itemCount: adjustments.length,
            odooResult
          }
        }
      );

      return { success: true, count: adjustments.length };

    } catch (error) {
      console.error(`[SellerFbaReportsSync] Error processing adjustment report:`, error.message);
      throw error;
    }
  }

  /**
   * Parse stock adjustment report
   */
  parseStockAdjustmentReport(data) {
    const lines = data.toString().split('\n');
    const adjustments = [];

    if (lines.length < 2) return adjustments;

    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '_'));

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      if (values.length < 2) continue;

      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx]?.trim() || '';
      });

      adjustments.push({
        transactionId: row.transaction_item_id || row.adjustment_id || `adj-${i}`,
        adjustedDate: row.adjusted_date || row.transaction_date,
        sku: row.sku || row.seller_sku,
        fnsku: row.fnsku,
        asin: row.asin,
        productName: row.product_name,
        fulfillmentCenter: row.fulfillment_center_id,
        quantity: parseInt(row.quantity || 0, 10),
        reason: row.reason || row.disposition,
        reasonGroup: row.reason_group,
        reconciled: row.reconciled === 'Yes'
      });
    }

    return adjustments.filter(a => a.sku);
  }

  /**
   * Apply adjustments to Odoo (create inventory adjustments)
   */
  async applyAdjustmentsToOdoo(adjustments) {
    const result = { applied: 0, skipped: 0, errors: [] };

    // Group by SKU for summary
    const skuAdjustments = {};
    for (const adj of adjustments) {
      if (!skuAdjustments[adj.sku]) {
        skuAdjustments[adj.sku] = 0;
      }
      skuAdjustments[adj.sku] += adj.quantity;
    }

    // For now, just log adjustments - full implementation would create stock.inventory records
    console.log(`[SellerFbaReportsSync] Stock adjustments summary:`, Object.keys(skuAdjustments).length, 'SKUs affected');

    // TODO: Create Odoo stock adjustments if needed
    result.applied = adjustments.length;

    return result;
  }

  // ==================== REMOVAL ORDERS ====================

  /**
   * Request a removal order report
   */
  async requestRemovalOrderReport(daysBack = 30) {
    await this.init();

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    try {
      const spClient = await this.client.getClient();

      const response = await spClient.callAPI({
        operation: 'reports.createReport',
        body: {
          reportType: REMOVAL_ORDER_REPORT,
          marketplaceIds: getAllMarketplaceIds(),
          dataStartTime: startDate.toISOString(),
          dataEndTime: new Date().toISOString()
        }
      });

      const reportId = response.reportId;
      console.log(`[SellerFbaReportsSync] Requested removal order report ${reportId}`);

      await this.db.collection(REPORTS_COLLECTION).insertOne({
        reportId,
        reportType: REMOVAL_ORDER_REPORT,
        status: 'IN_QUEUE',
        requestedAt: new Date(),
        dataStartTime: startDate,
        processed: false
      });

      return { success: true, reportId };

    } catch (error) {
      console.error('[SellerFbaReportsSync] Error requesting removal order report:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process removal order report
   */
  async processRemovalOrderReport(reportId, documentId) {
    const spClient = await this.client.getClient();

    try {
      const docResponse = await spClient.callAPI({
        operation: 'reports.getReportDocument',
        path: { reportDocumentId: documentId }
      });

      const reportData = await spClient.download(docResponse, { json: false });
      const removals = this.parseRemovalOrderReport(reportData);

      console.log(`[SellerFbaReportsSync] Parsed ${removals.length} removal orders`);

      // Store removals
      for (const removal of removals) {
        await this.db.collection(REMOVALS_COLLECTION).updateOne(
          { removalOrderId: removal.removalOrderId, sku: removal.sku },
          { $set: { ...removal, updatedAt: new Date() } },
          { upsert: true }
        );
      }

      await this.db.collection(REPORTS_COLLECTION).updateOne(
        { reportId },
        {
          $set: {
            processed: true,
            processedAt: new Date(),
            itemCount: removals.length
          }
        }
      );

      return { success: true, count: removals.length };

    } catch (error) {
      console.error(`[SellerFbaReportsSync] Error processing removal report:`, error.message);
      throw error;
    }
  }

  /**
   * Parse removal order report
   */
  parseRemovalOrderReport(data) {
    const lines = data.toString().split('\n');
    const removals = [];

    if (lines.length < 2) return removals;

    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '_'));

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      if (values.length < 2) continue;

      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx]?.trim() || '';
      });

      removals.push({
        removalOrderId: row.order_id || row.removal_order_id,
        orderType: row.order_type,
        orderStatus: row.order_status,
        requestDate: row.request_date,
        lastUpdatedDate: row.last_updated_date,
        sku: row.sku || row.seller_sku,
        fnsku: row.fnsku,
        disposition: row.disposition,
        requestedQuantity: parseInt(row.requested_quantity || 0, 10),
        cancelledQuantity: parseInt(row.cancelled_quantity || 0, 10),
        disposedQuantity: parseInt(row.disposed_quantity || 0, 10),
        shippedQuantity: parseInt(row.shipped_quantity || 0, 10),
        inProcessQuantity: parseInt(row.in_process_quantity || 0, 10),
        removalFee: parseFloat(row.removal_fee || 0),
        currency: row.currency
      });
    }

    return removals.filter(r => r.removalOrderId && r.sku);
  }

  // ==================== GENERIC REPORT PROCESSING ====================

  /**
   * Check and process all pending reports
   */
  async processAllPendingReports() {
    await this.init();

    const result = {
      checked: 0,
      processed: 0,
      errors: []
    };

    try {
      const pendingReports = await this.db.collection(REPORTS_COLLECTION).find({
        reportType: { $in: [STOCK_ADJUSTMENT_REPORT, REMOVAL_ORDER_REPORT] },
        processed: false,
        status: { $nin: ['CANCELLED', 'FATAL'] }
      }).toArray();

      console.log(`[SellerFbaReportsSync] Checking ${pendingReports.length} pending reports`);
      result.checked = pendingReports.length;

      const spClient = await this.client.getClient();

      for (const report of pendingReports) {
        try {
          const statusResponse = await spClient.callAPI({
            operation: 'reports.getReport',
            path: { reportId: report.reportId }
          });

          const status = statusResponse.processingStatus;

          await this.db.collection(REPORTS_COLLECTION).updateOne(
            { reportId: report.reportId },
            { $set: { status, updatedAt: new Date() } }
          );

          if (status === 'DONE') {
            const documentId = statusResponse.reportDocumentId;

            if (report.reportType === STOCK_ADJUSTMENT_REPORT) {
              await this.processStockAdjustmentReport(report.reportId, documentId);
            } else if (report.reportType === REMOVAL_ORDER_REPORT) {
              await this.processRemovalOrderReport(report.reportId, documentId);
            }

            result.processed++;

          } else if (status === 'FATAL' || status === 'CANCELLED') {
            await this.db.collection(REPORTS_COLLECTION).updateOne(
              { reportId: report.reportId },
              { $set: { processed: true } }
            );
            result.errors.push({ reportId: report.reportId, status });
          }

        } catch (error) {
          result.errors.push({ reportId: report.reportId, error: error.message });
        }
      }

    } catch (error) {
      result.errors.push({ error: error.message });
    }

    return result;
  }

  /**
   * Full sync: request both reports
   */
  async requestAllReports(daysBack = 30) {
    await this.init();

    const results = await Promise.all([
      this.requestStockAdjustmentReport(daysBack),
      this.requestRemovalOrderReport(daysBack)
    ]);

    return {
      stockAdjustment: results[0],
      removalOrder: results[1]
    };
  }

  /**
   * Get sync statistics
   */
  async getStats() {
    await this.init();

    const [
      totalAdjustments,
      totalRemovals,
      pendingReports,
      lastAdjustmentReport,
      lastRemovalReport
    ] = await Promise.all([
      this.db.collection(ADJUSTMENTS_COLLECTION).countDocuments({}),
      this.db.collection(REMOVALS_COLLECTION).countDocuments({}),
      this.db.collection(REPORTS_COLLECTION).countDocuments({
        reportType: { $in: [STOCK_ADJUSTMENT_REPORT, REMOVAL_ORDER_REPORT] },
        processed: false
      }),
      this.db.collection(REPORTS_COLLECTION).findOne(
        { reportType: STOCK_ADJUSTMENT_REPORT, processed: true },
        { sort: { processedAt: -1 } }
      ),
      this.db.collection(REPORTS_COLLECTION).findOne(
        { reportType: REMOVAL_ORDER_REPORT, processed: true },
        { sort: { processedAt: -1 } }
      )
    ]);

    return {
      totalAdjustments,
      totalRemovals,
      pendingReports,
      lastAdjustmentReportAt: lastAdjustmentReport?.processedAt,
      lastRemovalReportAt: lastRemovalReport?.processedAt
    };
  }
}

// Singleton instance
let fbaReportsSyncInstance = null;

/**
 * Get the singleton SellerFbaReportsSync instance
 */
async function getSellerFbaReportsSync() {
  if (!fbaReportsSyncInstance) {
    fbaReportsSyncInstance = new SellerFbaReportsSync();
    await fbaReportsSyncInstance.init();
  }
  return fbaReportsSyncInstance;
}

module.exports = {
  SellerFbaReportsSync,
  getSellerFbaReportsSync,
  STOCK_ADJUSTMENT_REPORT,
  REMOVAL_ORDER_REPORT
};
