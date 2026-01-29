/**
 * Tracking Alert Service
 *
 * CRITICAL: Ensures NO tracking confirmation is ever missed to any marketplace.
 *
 * Monitors:
 * - Bol.com FBR orders (must confirm shipment with tracking)
 * - Amazon FBM orders (must push tracking to Amazon)
 * - Amazon Vendor orders (ASN must be sent)
 *
 * Alerts when:
 * - Orders are shipped in Odoo but tracking not sent to marketplace
 * - Tracking push failed
 * - Orders are stuck for too long
 * - Sync job hasn't run recently
 *
 * @module TrackingAlertService
 */

const ExcelJS = require('exceljs');
const { getDb } = require('../../db');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const { TeamsNotificationService } = require('../../core/agents/services/TeamsNotificationService');
const oneDriveService = require('../onedriveService');

// Report folder for tracking alerts
const REPORTS_FOLDER = 'Tracking_Alerts';

// Thresholds that trigger alerts
const ALERT_THRESHOLDS = {
  // Alert if tracking not confirmed within N hours after Odoo delivery done
  BOL_MAX_HOURS_BEFORE_ALERT: 2,
  AMAZON_FBM_MAX_HOURS_BEFORE_ALERT: 2,
  AMAZON_VENDOR_MAX_HOURS_BEFORE_ALERT: 4,

  // Alert if sync job hasn't run in N minutes
  SYNC_STALE_MINUTES: 60,

  // Alert if N or more orders are stuck
  CRITICAL_STUCK_COUNT: 3
};

// Sync job last run tracking (loaded from MongoDB on startup)
const SYNC_STATUS = {
  bolShipment: { lastRun: null, lastSuccess: null, errorCount: 0 },
  amazonFbm: { lastRun: null, lastSuccess: null, errorCount: 0 },
  amazonVendor: { lastRun: null, lastSuccess: null, errorCount: 0 }
};

// Track if status has been loaded from database
let syncStatusLoaded = false;

/**
 * Persist SYNC_STATUS to MongoDB for reliability across restarts
 */
async function persistSyncStatus() {
  try {
    const db = getDb();
    await db.collection('system_status').updateOne(
      { _id: 'tracking_sync_status' },
      {
        $set: {
          syncStatus: SYNC_STATUS,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  } catch (error) {
    console.error('[TrackingAlert] Failed to persist sync status:', error.message);
  }
}

/**
 * Load SYNC_STATUS from MongoDB (called on startup)
 */
async function loadSyncStatus() {
  if (syncStatusLoaded) return;

  try {
    const db = getDb();
    const stored = await db.collection('system_status').findOne({ _id: 'tracking_sync_status' });

    if (stored && stored.syncStatus) {
      // Restore saved status
      for (const channel of Object.keys(SYNC_STATUS)) {
        if (stored.syncStatus[channel]) {
          SYNC_STATUS[channel] = {
            ...SYNC_STATUS[channel],
            ...stored.syncStatus[channel],
            // Convert date strings back to Date objects
            lastRun: stored.syncStatus[channel].lastRun ? new Date(stored.syncStatus[channel].lastRun) : null,
            lastSuccess: stored.syncStatus[channel].lastSuccess ? new Date(stored.syncStatus[channel].lastSuccess) : null
          };
        }
      }
      console.log('[TrackingAlert] Loaded sync status from database');
    }
    syncStatusLoaded = true;
  } catch (error) {
    console.error('[TrackingAlert] Failed to load sync status:', error.message);
  }
}

class TrackingAlertService {
  constructor() {
    this.odoo = null;
    this.db = null;
    this.teamsWebhook = null;
  }

  async init() {
    if (this.odoo) return;

    this.odoo = new OdooDirectClient();
    await this.odoo.authenticate();
    this.db = getDb();

    // Load saved sync status from MongoDB (survives restarts)
    await loadSyncStatus();

    const webhookUrl = process.env.TEAMS_TRACKING_WEBHOOK_URL ||
                      process.env.TEAMS_ALERTS_WEBHOOK_URL ||
                      process.env.TEAMS_WEBHOOK_URL;
    if (webhookUrl) {
      this.teamsWebhook = new TeamsNotificationService({ webhookUrl });
    }
  }

  /**
   * Record sync job execution (called by sync services)
   */
  static recordSyncRun(channel, success = true, details = {}) {
    const status = SYNC_STATUS[channel];
    if (!status) return;

    status.lastRun = new Date();
    if (success) {
      status.lastSuccess = new Date();
      status.errorCount = 0;
    } else {
      status.errorCount++;
    }
    status.lastDetails = details;

    console.log(`[TrackingAlert] Recorded sync run for ${channel}: ${success ? 'SUCCESS' : 'FAILED'}`);

    // Persist to MongoDB for reliability across restarts (fire-and-forget)
    persistSyncStatus().catch(err => {
      console.error('[TrackingAlert] Failed to persist sync status:', err.message);
    });
  }

  /**
   * Get all Bol FBR orders that are stuck (shipped in Odoo but tracking not confirmed)
   */
  async getStuckBolOrders() {
    await this.init();

    const cutoffTime = new Date(Date.now() - ALERT_THRESHOLDS.BOL_MAX_HOURS_BEFORE_ALERT * 60 * 60 * 1000);

    // Find orders where:
    // 1. Odoo order is linked and has picking done
    // 2. Tracking not confirmed to Bol
    // 3. It's been more than threshold hours
    const stuckOrders = await this.db.collection('unified_orders').find({
      channel: 'bol',
      subChannel: 'FBR',
      'sourceIds.odooSaleOrderId': { $exists: true, $ne: null },
      $or: [
        { 'bol.shipmentConfirmedAt': null },
        { 'bol.shipmentConfirmedAt': { $exists: false } }
      ],
      'status.source': { $nin: ['CANCELLED', 'SHIPPED'] }
    }).toArray();

    // For each order, check if Odoo picking is done
    const result = [];

    for (const order of stuckOrders) {
      const odooId = order.sourceIds.odooSaleOrderId;

      // Get picking status from Odoo
      const pickings = await this.odoo.searchRead('stock.picking',
        [
          ['sale_id', '=', odooId],
          ['picking_type_code', '=', 'outgoing'],
          ['state', '=', 'done']
        ],
        ['id', 'name', 'date_done', 'carrier_tracking_ref'],
        { limit: 1 }
      );

      if (pickings.length > 0) {
        const picking = pickings[0];
        const dateDone = new Date(picking.date_done);

        // If picking is done and it's been more than threshold, it's stuck
        if (dateDone < cutoffTime) {
          result.push({
            channel: 'bol',
            orderId: order.sourceIds.bolOrderId,
            odooOrderId: odooId,
            odooOrderName: order.sourceIds.odooSaleOrderName,
            pickingName: picking.name,
            pickingDone: picking.date_done,
            trackingRef: picking.carrier_tracking_ref,
            hoursStuck: Math.round((Date.now() - dateDone.getTime()) / (1000 * 60 * 60)),
            reason: order.bol?.lastError || 'Not attempted'
          });
        }
      }
    }

    return result;
  }

  /**
   * Get all Amazon FBM orders that are stuck
   */
  async getStuckAmazonFbmOrders() {
    await this.init();

    const cutoffTime = new Date(Date.now() - ALERT_THRESHOLDS.AMAZON_FBM_MAX_HOURS_BEFORE_ALERT * 60 * 60 * 1000);

    const stuckOrders = await this.db.collection('unified_orders').find({
      channel: 'amazon-seller',
      subChannel: 'FBM',
      'sourceIds.odooSaleOrderId': { $exists: true, $ne: null },
      $or: [
        { 'amazonSeller.trackingPushed': null },
        { 'amazonSeller.trackingPushed': { $exists: false } },
        { 'amazonSeller.trackingPushed': false }
      ],
      'status.source': { $nin: ['Cancelled', 'Shipped'] }
    }).toArray();

    const result = [];

    for (const order of stuckOrders) {
      const odooId = order.sourceIds.odooSaleOrderId;

      const pickings = await this.odoo.searchRead('stock.picking',
        [
          ['sale_id', '=', odooId],
          ['picking_type_code', '=', 'outgoing'],
          ['state', '=', 'done']
        ],
        ['id', 'name', 'date_done', 'carrier_tracking_ref'],
        { limit: 1 }
      );

      if (pickings.length > 0) {
        const picking = pickings[0];
        const dateDone = new Date(picking.date_done);

        if (dateDone < cutoffTime) {
          result.push({
            channel: 'amazon-fbm',
            orderId: order.sourceIds.amazonOrderId,
            odooOrderId: odooId,
            odooOrderName: order.sourceIds.odooSaleOrderName,
            pickingName: picking.name,
            pickingDone: picking.date_done,
            trackingRef: picking.carrier_tracking_ref,
            hoursStuck: Math.round((Date.now() - dateDone.getTime()) / (1000 * 60 * 60)),
            reason: order.amazonSeller?.trackingPushError || 'Not attempted'
          });
        }
      }
    }

    return result;
  }

  /**
   * Get all Amazon Vendor orders with missing ASN
   *
   * DISABLED (2026-01-17): Amazon Vendor tracking alerts disabled to reduce noise.
   * The Fulfilment status channel was being spammed with these alerts.
   * Re-enable by removing the early return below.
   */
  async getStuckVendorOrders() {
    // DISABLED: Return empty array to stop Vendor tracking alerts
    // Remove this line to re-enable Vendor tracking alerts
    return [];

    /* Original implementation - kept for reference
    await this.init();

    const cutoffTime = new Date(Date.now() - ALERT_THRESHOLDS.AMAZON_VENDOR_MAX_HOURS_BEFORE_ALERT * 60 * 60 * 1000);

    const stuckOrders = await this.db.collection('vendor_orders').find({
      'odoo.saleOrderId': { $exists: true, $ne: null },
      $or: [
        { asnSent: false },
        { asnSent: { $exists: false } }
      ],
      purchaseOrderState: { $nin: ['Closed', 'Cancelled'] }
    }).toArray();

    const result = [];

    for (const order of stuckOrders) {
      const odooId = order.odoo?.saleOrderId;
      if (!odooId) continue;

      const pickings = await this.odoo.searchRead('stock.picking',
        [
          ['sale_id', '=', odooId],
          ['picking_type_code', '=', 'outgoing'],
          ['state', '=', 'done']
        ],
        ['id', 'name', 'date_done'],
        { limit: 1 }
      );

      if (pickings.length > 0) {
        const picking = pickings[0];
        const dateDone = new Date(picking.date_done);

        if (dateDone < cutoffTime) {
          result.push({
            channel: 'amazon-vendor',
            orderId: order.purchaseOrderNumber,
            odooOrderId: odooId,
            odooOrderName: order.odoo?.saleOrderName,
            pickingName: picking.name,
            pickingDone: picking.date_done,
            hoursStuck: Math.round((Date.now() - dateDone.getTime()) / (1000 * 60 * 60)),
            reason: order.asnError || 'Not attempted'
          });
        }
      }
    }

    return result;
    */
  }

  /**
   * Get failed tracking pushes that need retry
   */
  async getFailedTrackingPushes() {
    await this.init();

    const results = {
      bol: [],
      amazonFbm: [],
      amazonVendor: []
    };

    // Bol failures
    const bolFailed = await this.db.collection('unified_orders').find({
      channel: 'bol',
      subChannel: 'FBR',
      'bol.lastError': { $exists: true, $ne: null }
    }).limit(20).toArray();

    results.bol = bolFailed.map(o => ({
      orderId: o.sourceIds?.bolOrderId,
      odooOrderName: o.sourceIds?.odooSaleOrderName,
      error: o.bol?.lastError,
      lastAttempt: o.bol?.lastSyncAttempt
    }));

    // Amazon FBM failures
    const fbmFailed = await this.db.collection('unified_orders').find({
      channel: 'amazon-seller',
      subChannel: 'FBM',
      'amazon.trackingPushError': { $exists: true, $ne: null }
    }).limit(20).toArray();

    results.amazonFbm = fbmFailed.map(o => ({
      orderId: o.sourceIds?.amazonOrderId,
      odooOrderName: o.sourceIds?.odooSaleOrderName,
      error: o.amazon?.trackingPushError,
      lastAttempt: o.amazon?.trackingPushAttempt
    }));

    // Vendor failures - DISABLED (2026-01-17)
    // const vendorFailed = await this.db.collection('vendor_orders').find({
    //   asnError: { $exists: true, $ne: null }
    // }).limit(20).toArray();
    //
    // results.amazonVendor = vendorFailed.map(o => ({
    //   orderId: o.purchaseOrderNumber,
    //   odooOrderName: o.odoo?.saleOrderName,
    //   error: o.asnError,
    //   lastAttempt: o.asnAttemptedAt
    // }));
    results.amazonVendor = []; // Disabled

    return results;
  }

  /**
   * Get comprehensive tracking health status
   */
  async getTrackingHealth() {
    await this.init();

    const [stuckBol, stuckFbm, stuckVendor, failures] = await Promise.all([
      this.getStuckBolOrders(),
      this.getStuckAmazonFbmOrders(),
      this.getStuckVendorOrders(),
      this.getFailedTrackingPushes()
    ]);

    const health = {
      timestamp: new Date().toISOString(),
      status: 'OK',
      alerts: [],

      summary: {
        bol: {
          stuckCount: stuckBol.length,
          failedCount: failures.bol.length,
          lastSync: SYNC_STATUS.bolShipment.lastSuccess,
          syncStale: this.isSyncStale('bolShipment')
        },
        amazonFbm: {
          stuckCount: stuckFbm.length,
          failedCount: failures.amazonFbm.length,
          lastSync: SYNC_STATUS.amazonFbm.lastSuccess,
          syncStale: this.isSyncStale('amazonFbm')
        },
        amazonVendor: {
          stuckCount: stuckVendor.length,
          failedCount: failures.amazonVendor.length,
          lastSync: SYNC_STATUS.amazonVendor.lastSuccess,
          syncStale: this.isSyncStale('amazonVendor')
        }
      },

      stuckOrders: {
        bol: stuckBol,
        amazonFbm: stuckFbm,
        amazonVendor: stuckVendor
      },

      failures: failures
    };

    // Determine overall status and build alerts
    const totalStuck = stuckBol.length + stuckFbm.length + stuckVendor.length;

    if (totalStuck >= ALERT_THRESHOLDS.CRITICAL_STUCK_COUNT) {
      health.status = 'CRITICAL';
      health.alerts.push({
        level: 'critical',
        message: `${totalStuck} orders are stuck without tracking confirmation!`,
        channels: {
          bol: stuckBol.length,
          amazonFbm: stuckFbm.length,
          amazonVendor: stuckVendor.length
        }
      });
    } else if (totalStuck > 0) {
      health.status = 'WARNING';
      health.alerts.push({
        level: 'warning',
        message: `${totalStuck} orders pending tracking confirmation`,
        channels: {
          bol: stuckBol.length,
          amazonFbm: stuckFbm.length,
          amazonVendor: stuckVendor.length
        }
      });
    }

    // Check for stale syncs
    // Note: amazonVendor removed (2026-01-17) - Vendor tracking alerts disabled
    for (const [channel, name] of [['bolShipment', 'Bol.com'], ['amazonFbm', 'Amazon FBM']]) {
      if (this.isSyncStale(channel)) {
        health.status = health.status === 'OK' ? 'WARNING' : health.status;
        health.alerts.push({
          level: 'warning',
          message: `${name} tracking sync hasn't run in over ${ALERT_THRESHOLDS.SYNC_STALE_MINUTES} minutes`,
          lastRun: SYNC_STATUS[channel].lastRun
        });
      }
    }

    return health;
  }

  /**
   * Check if a sync is stale (hasn't run recently)
   */
  isSyncStale(channel) {
    const status = SYNC_STATUS[channel];
    if (!status || !status.lastRun) return true;

    const minutesSinceRun = (Date.now() - new Date(status.lastRun).getTime()) / (1000 * 60);
    return minutesSinceRun > ALERT_THRESHOLDS.SYNC_STALE_MINUTES;
  }

  /**
   * Generate Excel report with tracking health details
   */
  async generateExcel(health) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Agent5 Tracking Alert';
    workbook.created = new Date();

    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

    // Stuck Orders sheet
    const stuckSheet = workbook.addWorksheet('Stuck Orders', {
      views: [{ state: 'frozen', ySplit: 2 }]
    });

    stuckSheet.addRow(['Tracking Alert Report - Stuck Orders', '', '', '', '', '', dateStr]);
    stuckSheet.mergeCells('A1:F1');
    stuckSheet.getCell('A1').font = { bold: true, size: 14 };
    stuckSheet.getCell('G1').font = { italic: true, size: 10 };

    stuckSheet.addRow(['Channel', 'Order ID', 'Odoo Order', 'Picking', 'Hours Stuck', 'Tracking Ref', 'Reason']);
    const headerRow = stuckSheet.getRow(2);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

    stuckSheet.columns = [
      { width: 15 }, { width: 20 }, { width: 18 }, { width: 15 }, { width: 12 }, { width: 25 }, { width: 40 }
    ];

    // Combine all stuck orders
    const allStuck = [
      ...health.stuckOrders.bol.map(o => ({ ...o, channelName: 'Bol.com' })),
      ...health.stuckOrders.amazonFbm.map(o => ({ ...o, channelName: 'Amazon FBM' })),
      ...health.stuckOrders.amazonVendor.map(o => ({ ...o, channelName: 'Amazon Vendor' }))
    ];

    for (const order of allStuck) {
      const row = stuckSheet.addRow([
        order.channelName,
        order.orderId,
        order.odooOrderName || '-',
        order.pickingName || '-',
        order.hoursStuck,
        order.trackingRef || '-',
        order.reason || '-'
      ]);

      // Highlight critical (>4 hours)
      if (order.hoursStuck > 4) {
        row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
      }
    }

    if (allStuck.length === 0) {
      stuckSheet.addRow(['No stuck orders', '', '', '', '', '', '']);
    }

    // Failed Pushes sheet
    const failedSheet = workbook.addWorksheet('Failed Pushes', {
      views: [{ state: 'frozen', ySplit: 2 }]
    });

    failedSheet.addRow(['Tracking Alert Report - Failed Pushes', '', '', '', dateStr]);
    failedSheet.mergeCells('A1:D1');
    failedSheet.getCell('A1').font = { bold: true, size: 14 };
    failedSheet.getCell('E1').font = { italic: true, size: 10 };

    failedSheet.addRow(['Channel', 'Order ID', 'Odoo Order', 'Error', 'Last Attempt']);
    const failedHeader = failedSheet.getRow(2);
    failedHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    failedHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC00000' } };

    failedSheet.columns = [
      { width: 15 }, { width: 20 }, { width: 18 }, { width: 50 }, { width: 20 }
    ];

    const allFailed = [
      ...health.failures.bol.map(f => ({ ...f, channelName: 'Bol.com' })),
      ...health.failures.amazonFbm.map(f => ({ ...f, channelName: 'Amazon FBM' })),
      ...health.failures.amazonVendor.map(f => ({ ...f, channelName: 'Amazon Vendor' }))
    ];

    for (const failure of allFailed) {
      failedSheet.addRow([
        failure.channelName,
        failure.orderId || '-',
        failure.odooOrderName || '-',
        failure.error || '-',
        failure.lastAttempt ? new Date(failure.lastAttempt).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '-'
      ]);
    }

    if (allFailed.length === 0) {
      failedSheet.addRow(['No failed pushes', '', '', '', '']);
    }

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.addRow(['Tracking Health Summary', '', dateStr]);
    summarySheet.mergeCells('A1:B1');
    summarySheet.getCell('A1').font = { bold: true, size: 14 };
    summarySheet.getCell('C1').font = { italic: true, size: 10 };

    summarySheet.addRow([]);
    summarySheet.addRow(['Overall Status', health.status]);
    summarySheet.getCell('B3').font = { bold: true, color: { argb: health.status === 'CRITICAL' ? 'FFFF0000' : 'FFFF8C00' } };

    summarySheet.addRow([]);
    summarySheet.addRow(['Channel', 'Stuck Orders', 'Failed Pushes', 'Last Sync', 'Sync Status']);
    const sumHeader = summarySheet.getRow(5);
    sumHeader.font = { bold: true };

    const channels = [
      { name: 'Bol.com', key: 'bol' },
      { name: 'Amazon FBM', key: 'amazonFbm' },
      { name: 'Amazon Vendor', key: 'amazonVendor' }
    ];

    for (const ch of channels) {
      const sum = health.summary[ch.key];
      summarySheet.addRow([
        ch.name,
        sum.stuckCount,
        sum.failedCount,
        sum.lastSync ? new Date(sum.lastSync).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : 'Never',
        sum.syncStale ? 'STALE' : 'OK'
      ]);
    }

    summarySheet.columns = [{ width: 18 }, { width: 14 }, { width: 14 }, { width: 22 }, { width: 12 }];

    return workbook.xlsx.writeBuffer();
  }

  /**
   * Send alert to Teams if there are issues
   */
  async sendAlertIfNeeded() {
    await this.init();

    if (!this.teamsWebhook) {
      console.log('[TrackingAlert] No Teams webhook configured, skipping alert');
      return { sent: false, reason: 'No webhook configured' };
    }

    const health = await this.getTrackingHealth();

    if (health.status === 'OK') {
      return { sent: false, reason: 'All tracking systems healthy', health };
    }

    // Generate and upload Excel report
    let reportUrl = null;
    try {
      const excelBuffer = await this.generateExcel(health);
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const fileName = `TrackingAlert_${timestamp}.xlsx`;

      const uploadResult = await oneDriveService.uploadReport(excelBuffer, fileName, REPORTS_FOLDER);
      reportUrl = uploadResult.url;
      console.log(`[TrackingAlert] Excel report uploaded: ${reportUrl}`);
    } catch (uploadError) {
      console.error('[TrackingAlert] Failed to upload Excel report:', uploadError.message);
    }

    // Build Teams alert card with report link
    const card = this.buildAlertCard(health, reportUrl);

    try {
      await this.teamsWebhook.sendMessage(card);
      console.log(`[TrackingAlert] Sent ${health.status} alert to Teams`);
      return { sent: true, status: health.status, alertCount: health.alerts.length, reportUrl };
    } catch (error) {
      console.error('[TrackingAlert] Failed to send Teams alert:', error.message);
      return { sent: false, error: error.message };
    }
  }

  /**
   * Build Teams Adaptive Card for alert
   */
  buildAlertCard(health, reportUrl = null) {
    const isNow = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });
    const statusEmoji = health.status === 'CRITICAL' ? '🚨' : '⚠️';
    const statusColor = health.status === 'CRITICAL' ? 'attention' : 'warning';

    const body = [
      {
        type: 'TextBlock',
        text: `${statusEmoji} Tracking Alert - ${health.status}`,
        weight: 'bolder',
        size: 'large',
        color: statusColor
      },
      {
        type: 'TextBlock',
        text: `Generated: ${isNow}`,
        size: 'small',
        isSubtle: true
      }
    ];

    // Add alert messages
    for (const alert of health.alerts) {
      body.push({
        type: 'TextBlock',
        text: `• ${alert.message}`,
        wrap: true,
        color: alert.level === 'critical' ? 'attention' : 'warning'
      });
    }

    // Add stuck orders table if any
    const allStuck = [
      ...health.stuckOrders.bol.map(o => ({ ...o, channel: 'Bol.com' })),
      ...health.stuckOrders.amazonFbm.map(o => ({ ...o, channel: 'Amazon FBM' })),
      ...health.stuckOrders.amazonVendor.map(o => ({ ...o, channel: 'Amazon Vendor' }))
    ];

    if (allStuck.length > 0) {
      body.push({
        type: 'TextBlock',
        text: 'Stuck Orders:',
        weight: 'bolder',
        spacing: 'medium'
      });

      const rows = [
        {
          type: 'TableRow',
          style: 'accent',
          cells: [
            { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Channel', weight: 'bolder' }] },
            { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Order', weight: 'bolder' }] },
            { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Stuck', weight: 'bolder' }] },
            { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Tracking', weight: 'bolder' }] }
          ]
        }
      ];

      for (const order of allStuck.slice(0, 10)) {
        rows.push({
          type: 'TableRow',
          cells: [
            { type: 'TableCell', items: [{ type: 'TextBlock', text: order.channel }] },
            { type: 'TableCell', items: [{ type: 'TextBlock', text: order.odooOrderName || order.orderId }] },
            { type: 'TableCell', items: [{ type: 'TextBlock', text: String(order.hoursStuck) + 'h', color: order.hoursStuck > 4 ? 'attention' : 'default' }] },
            { type: 'TableCell', items: [{ type: 'TextBlock', text: order.trackingRef || '-' }] }
          ]
        });
      }

      if (allStuck.length > 10) {
        body.push({
          type: 'TextBlock',
          text: `... and ${allStuck.length - 10} more`,
          isSubtle: true
        });
      }

      body.push({
        type: 'Table',
        gridStyle: 'accent',
        firstRowAsHeader: true,
        columns: [{ width: 2 }, { width: 3 }, { width: 1 }, { width: 2 }],
        rows
      });
    }

    // Add action buttons
    const actions = [
      {
        type: 'Action.OpenUrl',
        title: '🔍 View Dashboard',
        url: `${process.env.APP_BASE_URL || 'https://ai.acropaq.com'}/warehouse`,
        style: 'positive'
      }
    ];

    if (reportUrl) {
      actions.push({
        type: 'Action.OpenUrl',
        title: '📊 Download Excel Report',
        url: reportUrl
      });
    }

    body.push({
      type: 'ActionSet',
      actions
    });

    return {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body
    };
  }

  /**
   * Get sync status for all channels
   */
  getSyncStatus() {
    return {
      ...SYNC_STATUS,
      thresholds: ALERT_THRESHOLDS
    };
  }
}

// Singleton
let instance = null;

function getTrackingAlertService() {
  if (!instance) {
    instance = new TrackingAlertService();
  }
  return instance;
}

/**
 * Check tracking health and send alert if needed (for scheduler)
 */
async function runTrackingHealthCheck() {
  const service = getTrackingAlertService();
  const health = await service.getTrackingHealth();

  if (health.status !== 'OK') {
    await service.sendAlertIfNeeded();
  }

  return health;
}

/**
 * Record sync run (standalone function for external use)
 * CRITICAL: Must load existing sync status before modifying to prevent data loss on restart
 * @param {string} channel - 'bolShipment', 'amazonFbm', or 'amazonVendor'
 * @param {boolean} success - Whether the sync was successful
 * @param {object} details - Additional details about the sync
 */
async function recordSyncRun(channel, success = true, details = {}) {
  // CRITICAL: Load saved sync status first to prevent race condition on server restart
  // Without this, sync jobs running immediately after restart would overwrite saved data
  await loadSyncStatus();
  return TrackingAlertService.recordSyncRun(channel, success, details);
}

module.exports = {
  TrackingAlertService,
  getTrackingAlertService,
  runTrackingHealthCheck,
  recordSyncRun,  // Now properly exported!
  ALERT_THRESHOLDS,
  SYNC_STATUS
};
