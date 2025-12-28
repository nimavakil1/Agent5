/**
 * SellerOrderScheduler - Automated Order Polling Scheduler
 *
 * Runs order polling every 15 minutes:
 * - Polls Amazon SP-API for new/updated orders
 * - Automatically creates Odoo orders for new eligible orders
 * - Tracks polling history and errors
 *
 * @module SellerOrderScheduler
 */

const { getSellerOrderImporter } = require('./SellerOrderImporter');
const { getSellerOrderCreator } = require('./SellerOrderCreator');
const { getSellerShipmentSync } = require('./SellerShipmentSync');
const { getSellerTrackingPusher } = require('./SellerTrackingPusher');
const { getSellerCanceledOrderSync } = require('./SellerCanceledOrderSync');
const { getSellerFbaInventorySync } = require('./SellerFbaInventorySync');
const { getSellerInventoryExport } = require('./SellerInventoryExport');
const { getSellerFbaReportsSync } = require('./SellerFbaReportsSync');
const { getSellerInboundShipmentSync } = require('./SellerInboundShipmentSync');
const { getSellerFulfillmentSync } = require('./SellerFulfillmentSync');

// Default polling interval: 15 minutes
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

// Hours to look back when polling
const DEFAULT_HOURS_BACK = 6;

/**
 * SellerOrderScheduler - Manages automated order polling
 */
class SellerOrderScheduler {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.hoursBack = options.hoursBack || DEFAULT_HOURS_BACK;
    this.autoCreateOdoo = options.autoCreateOdoo !== false;
    this.autoSyncShipments = options.autoSyncShipments !== false;

    this.intervalId = null;
    this.isRunning = false;
    this.lastPollTime = null;
    this.lastPollResult = null;
    this.pollCount = 0;
    this.errorCount = 0;
    this.lastError = null;

    this.importer = null;
    this.creator = null;
    this.shipmentSync = null;
    this.trackingPusher = null;
  }

  /**
   * Initialize the scheduler
   */
  async init() {
    if (this.importer && this.creator) return;

    this.importer = await getSellerOrderImporter();

    if (this.autoCreateOdoo) {
      this.creator = await getSellerOrderCreator();
    }

    if (this.autoSyncShipments) {
      this.shipmentSync = await getSellerShipmentSync();
      this.trackingPusher = await getSellerTrackingPusher();
    }

    console.log('[SellerOrderScheduler] Initialized');
  }

  /**
   * Start the scheduler
   */
  start() {
    if (this.intervalId) {
      console.log('[SellerOrderScheduler] Already running');
      return;
    }

    console.log(`[SellerOrderScheduler] Starting with ${this.intervalMs / 60000} minute interval`);

    // Run immediately on start
    this.runPoll().catch(err => {
      console.error('[SellerOrderScheduler] Initial poll error:', err.message);
    });

    // Schedule regular polling
    this.intervalId = setInterval(() => {
      this.runPoll().catch(err => {
        console.error('[SellerOrderScheduler] Scheduled poll error:', err.message);
      });
    }, this.intervalMs);

    this.isRunning = true;
    console.log('[SellerOrderScheduler] Started');
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;
    console.log('[SellerOrderScheduler] Stopped');
  }

  /**
   * Run a single poll cycle
   */
  async runPoll() {
    try {
      await this.init();

      console.log(`[SellerOrderScheduler] Running poll #${this.pollCount + 1}`);

      // Poll for orders
      const pollResult = await this.importer.poll({
        hoursBack: this.hoursBack
      });

      this.pollCount++;
      this.lastPollTime = new Date();
      this.lastPollResult = pollResult;

      console.log(`[SellerOrderScheduler] Poll complete: ${pollResult.ordersFound} orders found, ${pollResult.ordersUpserted} upserted`);

      // Auto-create Odoo orders for new eligible orders
      if (this.autoCreateOdoo && this.creator) {
        try {
          const createResult = await this.creator.createPendingOrders({
            limit: 50,
            autoConfirm: true
          });

          console.log(`[SellerOrderScheduler] Auto-created ${createResult.created} Odoo orders`);

          pollResult.odooCreated = createResult.created;
          pollResult.odooSkipped = createResult.skipped;
          pollResult.odooErrors = createResult.errors;

        } catch (createError) {
          console.error('[SellerOrderScheduler] Auto-create error:', createError.message);
          pollResult.odooCreateError = createError.message;
        }
      }

      // Sync FBA shipments (Amazon → Odoo pickings)
      if (this.autoSyncShipments && this.shipmentSync) {
        try {
          const syncResult = await this.shipmentSync.syncFbaShipments();
          console.log(`[SellerOrderScheduler] FBA shipment sync: ${syncResult.synced} synced, ${syncResult.skipped} skipped`);
          pollResult.fbaShipmentsSynced = syncResult.synced;
          pollResult.fbaShipmentsSkipped = syncResult.skipped;
        } catch (syncError) {
          console.error('[SellerOrderScheduler] FBA shipment sync error:', syncError.message);
          pollResult.fbaShipmentError = syncError.message;
        }
      }

      // Push FBM tracking (Odoo → Amazon)
      if (this.autoSyncShipments && this.trackingPusher) {
        try {
          const pushResult = await this.trackingPusher.pushPendingTracking();
          console.log(`[SellerOrderScheduler] FBM tracking push: ${pushResult.pushed} pushed, ${pushResult.skipped} skipped`);
          pollResult.fbmTrackingPushed = pushResult.pushed;
          pollResult.fbmTrackingSkipped = pushResult.skipped;
        } catch (pushError) {
          console.error('[SellerOrderScheduler] FBM tracking push error:', pushError.message);
          pollResult.fbmTrackingError = pushError.message;
        }
      }

      // Sync canceled orders (Amazon → Odoo)
      try {
        const canceledSync = await getSellerCanceledOrderSync();
        const cancelResult = await canceledSync.syncCanceledOrders();
        console.log(`[SellerOrderScheduler] Canceled orders: ${cancelResult.canceled} canceled`);
        pollResult.ordersCanceled = cancelResult.canceled;
      } catch (cancelError) {
        console.error('[SellerOrderScheduler] Canceled order sync error:', cancelError.message);
        pollResult.canceledOrderError = cancelError.message;
      }

      // Process pending FBA reports (stock adjustments, removals)
      try {
        const fbaReportsSync = await getSellerFbaReportsSync();
        const reportsResult = await fbaReportsSync.processAllPendingReports();
        if (reportsResult.processed > 0) {
          console.log(`[SellerOrderScheduler] FBA reports: ${reportsResult.processed} processed`);
        }
        pollResult.fbaReportsProcessed = reportsResult.processed;
      } catch (reportsError) {
        console.error('[SellerOrderScheduler] FBA reports sync error:', reportsError.message);
        pollResult.fbaReportsError = reportsError.message;
      }

      // Process pending FBA inventory reports
      try {
        const fbaInventorySync = await getSellerFbaInventorySync();
        const invResult = await fbaInventorySync.processReports();
        if (invResult.processed > 0) {
          console.log(`[SellerOrderScheduler] FBA inventory reports: ${invResult.processed} processed`);
        }
        pollResult.fbaInventoryReportsProcessed = invResult.processed;
      } catch (invError) {
        console.error('[SellerOrderScheduler] FBA inventory sync error:', invError.message);
        pollResult.fbaInventoryError = invError.message;
      }

      // Check feed status for inventory exports
      try {
        const inventoryExport = await getSellerInventoryExport();
        const feedResult = await inventoryExport.checkFeedStatus();
        if (feedResult.completed > 0) {
          console.log(`[SellerOrderScheduler] Inventory feeds: ${feedResult.completed} completed`);
        }
        pollResult.inventoryFeedsCompleted = feedResult.completed;
      } catch (feedError) {
        console.error('[SellerOrderScheduler] Inventory feed check error:', feedError.message);
        pollResult.inventoryFeedError = feedError.message;
      }

      // Sync inbound shipments
      try {
        const inboundSync = await getSellerInboundShipmentSync();
        const inboundResult = await inboundSync.syncShipments();
        if (inboundResult.updated > 0 || inboundResult.new > 0) {
          console.log(`[SellerOrderScheduler] Inbound shipments: ${inboundResult.new} new, ${inboundResult.updated} updated`);
        }
        pollResult.inboundShipmentsNew = inboundResult.new;
        pollResult.inboundShipmentsUpdated = inboundResult.updated;
      } catch (inboundError) {
        console.error('[SellerOrderScheduler] Inbound shipment sync error:', inboundError.message);
        pollResult.inboundShipmentError = inboundError.message;
      }

      // Sync MCF order status
      try {
        const fulfillmentSync = await getSellerFulfillmentSync();
        const mcfResult = await fulfillmentSync.syncMcfOrders();
        if (mcfResult.updated > 0) {
          console.log(`[SellerOrderScheduler] MCF orders: ${mcfResult.updated} updated`);
        }
        pollResult.mcfOrdersUpdated = mcfResult.updated;
      } catch (mcfError) {
        console.error('[SellerOrderScheduler] MCF order sync error:', mcfError.message);
        pollResult.mcfOrderError = mcfError.message;
      }

      return pollResult;

    } catch (error) {
      this.errorCount++;
      this.lastError = {
        message: error.message,
        time: new Date()
      };

      console.error('[SellerOrderScheduler] Poll error:', error.message);
      throw error;
    }
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      intervalMs: this.intervalMs,
      intervalMinutes: this.intervalMs / 60000,
      hoursBack: this.hoursBack,
      autoCreateOdoo: this.autoCreateOdoo,
      autoSyncShipments: this.autoSyncShipments,
      lastPollTime: this.lastPollTime,
      lastPollResult: this.lastPollResult,
      pollCount: this.pollCount,
      errorCount: this.errorCount,
      lastError: this.lastError,
      nextPollTime: this.intervalId && this.lastPollTime
        ? new Date(this.lastPollTime.getTime() + this.intervalMs)
        : null
    };
  }

  /**
   * Update scheduler configuration
   * @param {Object} options - New configuration options
   */
  configure(options) {
    if (options.intervalMs !== undefined) {
      this.intervalMs = options.intervalMs;
    }
    if (options.hoursBack !== undefined) {
      this.hoursBack = options.hoursBack;
    }
    if (options.autoCreateOdoo !== undefined) {
      this.autoCreateOdoo = options.autoCreateOdoo;
    }
    if (options.autoSyncShipments !== undefined) {
      this.autoSyncShipments = options.autoSyncShipments;
    }

    // Restart if running to apply new interval
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }
}

// Singleton instance
let schedulerInstance = null;

/**
 * Get the singleton SellerOrderScheduler instance
 */
function getSellerOrderScheduler(options = {}) {
  if (!schedulerInstance) {
    schedulerInstance = new SellerOrderScheduler(options);
  }
  return schedulerInstance;
}

/**
 * Start the seller order scheduler (convenience function)
 * Called from index.js on app startup
 */
async function startSellerScheduler() {
  // Only start if seller token is configured
  if (!process.env.AMAZON_SELLER_REFRESH_TOKEN) {
    console.log('[SellerOrderScheduler] No seller token configured, skipping scheduler');
    return null;
  }

  try {
    const scheduler = getSellerOrderScheduler();
    await scheduler.init();
    scheduler.start();
    return scheduler;
  } catch (error) {
    console.error('[SellerOrderScheduler] Failed to start:', error.message);
    return null;
  }
}

module.exports = {
  SellerOrderScheduler,
  getSellerOrderScheduler,
  startSellerScheduler
};
