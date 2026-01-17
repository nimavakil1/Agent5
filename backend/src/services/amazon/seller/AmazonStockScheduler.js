/**
 * Amazon Stock Scheduler
 *
 * Replicates Emipro module stock sync functionality:
 * - FBM Stock Export: Odoo CW → Amazon (every 30 minutes)
 * - FBA Inventory Sync: Amazon → Odoo (every 1 hour)
 *
 * Intervals match the original Emipro configuration.
 *
 * @module AmazonStockScheduler
 */

const { getSellerInventoryExport } = require('./SellerInventoryExport');
const { getSellerFbaInventorySync } = require('./SellerFbaInventorySync');
const { getModuleLogger } = require('../../logging/ModuleLogger');

// Get Amazon module logger
const logger = getModuleLogger('amazon');

// Interval handles
let fbmStockInterval = null;
let fbaInventoryInterval = null;
let fbaReportCheckInterval = null;

// Interval settings (in milliseconds) - matching Emipro
const FBM_STOCK_SYNC_INTERVAL = 30 * 60 * 1000;      // 30 minutes
const FBA_INVENTORY_SYNC_INTERVAL = 60 * 60 * 1000;  // 1 hour
const FBA_REPORT_CHECK_INTERVAL = 15 * 60 * 1000;    // 15 minutes (check pending reports)

// Track last sync times
let lastFbmSync = null;
let lastFbaSync = null;
let lastFbaReportRequest = null;

/**
 * Run FBM Stock Export (Odoo CW → Amazon)
 * Reads stock from Central Warehouse and submits inventory feed to Amazon
 */
async function doFbmStockSync() {
  const timer = logger.startTimer('FBM_STOCK_SYNC', 'scheduler');
  try {
    console.log('[AmazonStockScheduler] Starting FBM stock sync (Odoo → Amazon)...');

    const exporter = await getSellerInventoryExport();
    const inventory = await exporter.getOdooStock();

    console.log(`[AmazonStockScheduler] Found ${inventory.length} products with CW stock`);

    if (inventory.length === 0) {
      await timer.info('FBM stock sync: No products with CW stock to sync');
      lastFbmSync = new Date();
      return { success: true, message: 'No products with CW stock', itemCount: 0 };
    }

    // Submit feed to Amazon
    const result = await exporter.submitFeed(inventory);

    lastFbmSync = new Date();

    if (result.success) {
      console.log(`[AmazonStockScheduler] FBM stock feed submitted: ${result.feedId} (${result.itemCount} items)`);
      await timer.success(`FBM stock sync: ${result.itemCount} products sent to Amazon`, {
        details: { feedId: result.feedId, itemCount: result.itemCount }
      });
    } else {
      console.error(`[AmazonStockScheduler] FBM stock sync failed: ${result.error}`);
      await timer.error('FBM stock sync failed', new Error(result.error));
    }

    return result;

  } catch (error) {
    console.error('[AmazonStockScheduler] FBM stock sync error:', error.message);
    await timer.error('FBM stock sync failed', error);
    return { success: false, error: error.message };
  }
}

/**
 * Request FBA Inventory Report from Amazon
 * This is step 1 of the FBA sync - request the report
 */
async function requestFbaInventoryReport() {
  const timer = logger.startTimer('FBA_REPORT_REQUEST', 'scheduler');
  try {
    console.log('[AmazonStockScheduler] Requesting FBA inventory report from Amazon...');

    const fbaSync = await getSellerFbaInventorySync();
    const result = await fbaSync.requestReport();

    lastFbaReportRequest = new Date();

    if (result.success) {
      console.log(`[AmazonStockScheduler] FBA inventory report requested: ${result.reportId}`);
      await timer.success(`FBA report requested: ${result.reportId}`, {
        details: { reportId: result.reportId }
      });
    } else {
      console.error(`[AmazonStockScheduler] FBA report request failed: ${result.error}`);
      await timer.error('FBA report request failed', new Error(result.error));
    }

    return result;

  } catch (error) {
    console.error('[AmazonStockScheduler] FBA report request error:', error.message);
    await timer.error('FBA report request failed', error);
    return { success: false, error: error.message };
  }
}

/**
 * Process pending FBA inventory reports
 * This is step 2 of the FBA sync - check and process completed reports
 */
async function processFbaReports() {
  const timer = logger.startTimer('FBA_REPORT_PROCESS', 'scheduler');
  try {
    console.log('[AmazonStockScheduler] Checking for completed FBA inventory reports...');

    const fbaSync = await getSellerFbaInventorySync();
    const result = await fbaSync.processReports();

    if (result.processed > 0) {
      lastFbaSync = new Date();
      console.log(`[AmazonStockScheduler] Processed ${result.processed} FBA inventory reports`);
      await timer.success(`FBA inventory sync: ${result.processed} reports processed`, {
        details: result
      });
    } else if (result.checked > 0) {
      await timer.info(`FBA report check: ${result.checked} pending reports, none ready yet`, {
        details: result
      });
    } else {
      await timer.info('FBA report check: No pending reports');
    }

    return result;

  } catch (error) {
    console.error('[AmazonStockScheduler] FBA report processing error:', error.message);
    await timer.error('FBA report processing failed', error);
    return { success: false, error: error.message };
  }
}

/**
 * Full FBA Inventory Sync cycle
 * Request new report and process any completed ones
 */
async function doFbaInventorySync() {
  const timer = logger.startTimer('FBA_INVENTORY_SYNC', 'scheduler');
  try {
    console.log('[AmazonStockScheduler] Starting FBA inventory sync (Amazon → Odoo)...');

    // Step 1: Process any pending reports first
    const processResult = await processFbaReports();

    // Step 2: Request a new report
    const requestResult = await requestFbaInventoryReport();

    const result = {
      reportsProcessed: processResult.processed || 0,
      newReportRequested: requestResult.success,
      newReportId: requestResult.reportId
    };

    if (result.reportsProcessed > 0) {
      await timer.success(`FBA inventory sync: ${result.reportsProcessed} reports processed, new report requested`, {
        details: result
      });
    } else {
      await timer.info('FBA inventory sync: New report requested', { details: result });
    }

    return result;

  } catch (error) {
    console.error('[AmazonStockScheduler] FBA inventory sync error:', error.message);
    await timer.error('FBA inventory sync failed', error);
    return { success: false, error: error.message };
  }
}

/**
 * Check FBM feed status (optional - for monitoring)
 */
async function checkFbmFeedStatus() {
  try {
    const exporter = await getSellerInventoryExport();
    const result = await exporter.checkFeedStatus();

    if (result.completed > 0) {
      console.log(`[AmazonStockScheduler] ${result.completed} FBM feeds completed`);
    }
    if (result.errors.length > 0) {
      console.warn(`[AmazonStockScheduler] ${result.errors.length} FBM feeds with errors`);
    }

    return result;
  } catch (error) {
    console.error('[AmazonStockScheduler] FBM feed status check error:', error.message);
    return { error: error.message };
  }
}

/**
 * Start the Amazon stock scheduler
 */
function start() {
  console.log('[AmazonStockScheduler] Starting Amazon stock sync scheduler...');

  // Log scheduler start
  logger.info('SCHEDULER_START', 'Amazon stock scheduler started', {
    details: {
      jobs: ['FBM_STOCK_SYNC', 'FBA_INVENTORY_SYNC', 'FBA_REPORT_CHECK'],
      intervals: {
        fbmStockSync: '30 min',
        fbaInventorySync: '1 hour',
        fbaReportCheck: '15 min'
      }
    }
  });

  // FBM Stock Sync every 30 minutes (start after 2 minutes)
  setTimeout(() => {
    console.log('[AmazonStockScheduler] Starting FBM stock sync interval (every 30 min)');
    doFbmStockSync();
    fbmStockInterval = setInterval(doFbmStockSync, FBM_STOCK_SYNC_INTERVAL);
  }, 2 * 60 * 1000);

  // FBA Inventory Sync every 1 hour (start after 5 minutes)
  setTimeout(() => {
    console.log('[AmazonStockScheduler] Starting FBA inventory sync interval (every 1 hour)');
    doFbaInventorySync();
    fbaInventoryInterval = setInterval(doFbaInventorySync, FBA_INVENTORY_SYNC_INTERVAL);
  }, 5 * 60 * 1000);

  // FBA Report Check every 15 minutes (start after 10 minutes)
  // This processes any pending reports between the hourly sync cycles
  setTimeout(() => {
    console.log('[AmazonStockScheduler] Starting FBA report check interval (every 15 min)');
    processFbaReports();
    fbaReportCheckInterval = setInterval(processFbaReports, FBA_REPORT_CHECK_INTERVAL);
  }, 10 * 60 * 1000);

  console.log('[AmazonStockScheduler] All jobs scheduled');
}

/**
 * Stop the scheduler
 */
function stop() {
  if (fbmStockInterval) {
    clearInterval(fbmStockInterval);
    fbmStockInterval = null;
  }
  if (fbaInventoryInterval) {
    clearInterval(fbaInventoryInterval);
    fbaInventoryInterval = null;
  }
  if (fbaReportCheckInterval) {
    clearInterval(fbaReportCheckInterval);
    fbaReportCheckInterval = null;
  }

  logger.info('SCHEDULER_STOP', 'Amazon stock scheduler stopped');
  console.log('[AmazonStockScheduler] All jobs stopped');
}

/**
 * Get scheduler status
 */
function getStatus() {
  return {
    running: !!(fbmStockInterval || fbaInventoryInterval || fbaReportCheckInterval),
    intervals: {
      fbmStockSync: {
        active: !!fbmStockInterval,
        intervalMs: FBM_STOCK_SYNC_INTERVAL,
        lastRun: lastFbmSync
      },
      fbaInventorySync: {
        active: !!fbaInventoryInterval,
        intervalMs: FBA_INVENTORY_SYNC_INTERVAL,
        lastRun: lastFbaSync
      },
      fbaReportCheck: {
        active: !!fbaReportCheckInterval,
        intervalMs: FBA_REPORT_CHECK_INTERVAL,
        lastReportRequest: lastFbaReportRequest
      }
    }
  };
}

/**
 * Get sync statistics
 */
async function getStats() {
  try {
    const [exporterStats, fbaStats] = await Promise.all([
      getSellerInventoryExport().then(e => e.getStats()),
      getSellerFbaInventorySync().then(s => s.getStats())
    ]);

    return {
      fbmExport: exporterStats,
      fbaImport: fbaStats,
      scheduler: getStatus()
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Run FBM stock sync manually (for API trigger)
 */
async function runFbmStockSync() {
  return doFbmStockSync();
}

/**
 * Run FBA inventory sync manually (for API trigger)
 */
async function runFbaInventorySync() {
  return doFbaInventorySync();
}

module.exports = {
  start,
  stop,
  getStatus,
  getStats,
  // Manual triggers
  runFbmStockSync,
  runFbaInventorySync,
  doFbmStockSync,
  doFbaInventorySync,
  processFbaReports,
  checkFbmFeedStatus
};
