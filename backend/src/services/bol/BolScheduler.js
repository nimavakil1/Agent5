/**
 * Bol.com Scheduler
 *
 * Schedules automatic syncs:
 * - Nightly extended sync (6 months) at 3:00 AM
 * - Order polling every 15 minutes
 * - Stock sync to Bol.com every 15 minutes
 * - Shipment confirmation check every 5 minutes
 * - FBB/FBR fulfillment swap check every hour
 */

const BolSyncService = require('./BolSyncService');
const BolInvoiceBooker = require('./BolInvoiceBooker');
const { getBolOrderCreator } = require('./BolOrderCreator');
const { runStockSync } = require('./BolStockSync');
const { runShipmentSync } = require('./BolShipmentSync');
const { runCancellationCheck } = require('./BolCancellationHandler');
const { runFulfillmentSwap } = require('./BolFulfillmentSwapper');

let nightlySyncJob = null;
let orderPollInterval = null;
let stockSyncInterval = null;
let shipmentCheckInterval = null;
let fulfillmentSwapInterval = null;

// Interval settings (in milliseconds)
const ORDER_POLL_INTERVAL = 15 * 60 * 1000;       // 15 minutes
const STOCK_SYNC_INTERVAL = 15 * 60 * 1000;       // 15 minutes
const SHIPMENT_CHECK_INTERVAL = 5 * 60 * 1000;    // 5 minutes
const FULFILLMENT_SWAP_INTERVAL = 60 * 60 * 1000; // 1 hour

/**
 * Calculate milliseconds until next 3:00 AM
 */
function getMillisUntil3AM() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(3, 0, 0, 0);

  // If it's already past 3 AM today, schedule for tomorrow
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}

/**
 * Run the nightly extended sync
 */
async function runNightlySync() {
  console.log('[BolScheduler] Starting nightly extended sync...');
  const startTime = Date.now();

  try {
    // Step 1: Sync data from Bol.com API (orders + invoices)
    const syncResults = await BolSyncService.syncAll('EXTENDED');
    console.log('[BolScheduler] Sync complete:', syncResults);

    // Step 2: Create Odoo orders for new Bol orders
    console.log('[BolScheduler] Creating Odoo orders for pending Bol orders...');
    const orderCreator = await getBolOrderCreator();
    const orderResults = await orderCreator.createPendingOrders({ limit: 100 });
    console.log('[BolScheduler] Order creation complete:', orderResults);

    // Step 3: Book any new invoices to Odoo
    console.log('[BolScheduler] Booking unbooked invoices to Odoo...');
    const bookingResults = await BolInvoiceBooker.bookAllUnbooked();
    console.log('[BolScheduler] Invoice booking complete:', bookingResults);

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`[BolScheduler] Nightly sync complete in ${duration} minutes:`, {
      sync: syncResults,
      orders: orderResults,
      booking: bookingResults
    });
  } catch (error) {
    console.error('[BolScheduler] Nightly sync failed:', error);
  }

  // Schedule next run
  scheduleNightlySync();
}

/**
 * Poll for new orders and create Odoo orders
 */
async function runOrderPoll() {
  try {
    console.log('[BolScheduler] Polling for new orders...');

    // Sync recent orders from Bol.com
    await BolSyncService.syncOrders('RECENT');

    // Create Odoo orders for any pending
    const orderCreator = await getBolOrderCreator();
    const results = await orderCreator.createPendingOrders({ limit: 20 });

    if (results.created > 0) {
      console.log(`[BolScheduler] Created ${results.created} new Odoo orders`);
    }
  } catch (error) {
    console.error('[BolScheduler] Order poll failed:', error.message);
  }
}

/**
 * Sync stock levels to Bol.com
 */
async function doStockSync() {
  try {
    console.log('[BolScheduler] Syncing stock to Bol.com...');
    const results = await runStockSync();
    if (results && results.updated > 0) {
      console.log(`[BolScheduler] Updated ${results.updated} stock levels on Bol.com`);
    }
  } catch (error) {
    console.error('[BolScheduler] Stock sync failed:', error.message);
  }
}

/**
 * Check for shipments to confirm on Bol.com
 */
async function doShipmentCheck() {
  try {
    // Check shipments
    const shipResults = await runShipmentSync();
    if (shipResults && shipResults.confirmed > 0) {
      console.log(`[BolScheduler] Confirmed ${shipResults.confirmed} shipments on Bol.com`);
    }

    // Also check cancellations
    const cancelResults = await runCancellationCheck();
    if (cancelResults && cancelResults.processed > 0) {
      console.log(`[BolScheduler] Processed ${cancelResults.processed} cancellations`);
    }
  } catch (error) {
    console.error('[BolScheduler] Shipment/cancellation check failed:', error.message);
  }
}

/**
 * Check and swap FBB/FBR fulfillment based on stock levels
 */
async function doFulfillmentSwap() {
  try {
    console.log('[BolScheduler] Checking FBB/FBR fulfillment swap...');
    const results = await runFulfillmentSwap();
    const totalSwaps = (results.swappedToFbr || 0) + (results.swappedToFbb || 0);
    if (totalSwaps > 0) {
      console.log(`[BolScheduler] Swapped ${results.swappedToFbr} to FBR, ${results.swappedToFbb} to FBB`);
    }
  } catch (error) {
    console.error('[BolScheduler] Fulfillment swap check failed:', error.message);
  }
}

/**
 * Schedule the nightly sync job
 */
function scheduleNightlySync() {
  const msUntil3AM = getMillisUntil3AM();
  const hoursUntil = (msUntil3AM / 1000 / 60 / 60).toFixed(1);

  console.log(`[BolScheduler] Next nightly sync in ${hoursUntil} hours`);

  nightlySyncJob = setTimeout(runNightlySync, msUntil3AM);
}

/**
 * Start the scheduler
 */
function start() {
  console.log('[BolScheduler] Starting Bol.com sync scheduler...');

  // Schedule nightly sync
  scheduleNightlySync();

  // Start interval jobs (with staggered initial delays)
  console.log('[BolScheduler] Starting interval jobs...');

  // Order polling every 15 minutes (start after 1 minute)
  setTimeout(() => {
    runOrderPoll();
    orderPollInterval = setInterval(runOrderPoll, ORDER_POLL_INTERVAL);
  }, 60 * 1000);

  // Stock sync every 15 minutes (start after 2 minutes)
  setTimeout(() => {
    doStockSync();
    stockSyncInterval = setInterval(doStockSync, STOCK_SYNC_INTERVAL);
  }, 2 * 60 * 1000);

  // Shipment check every 5 minutes (start after 3 minutes)
  setTimeout(() => {
    doShipmentCheck();
    shipmentCheckInterval = setInterval(doShipmentCheck, SHIPMENT_CHECK_INTERVAL);
  }, 3 * 60 * 1000);

  // FBB/FBR fulfillment swap check every hour (start after 5 minutes)
  setTimeout(() => {
    doFulfillmentSwap();
    fulfillmentSwapInterval = setInterval(doFulfillmentSwap, FULFILLMENT_SWAP_INTERVAL);
  }, 5 * 60 * 1000);

  console.log('[BolScheduler] All jobs scheduled');
}

/**
 * Stop the scheduler
 */
function stop() {
  if (nightlySyncJob) {
    clearTimeout(nightlySyncJob);
    nightlySyncJob = null;
  }
  if (orderPollInterval) {
    clearInterval(orderPollInterval);
    orderPollInterval = null;
  }
  if (stockSyncInterval) {
    clearInterval(stockSyncInterval);
    stockSyncInterval = null;
  }
  if (shipmentCheckInterval) {
    clearInterval(shipmentCheckInterval);
    shipmentCheckInterval = null;
  }
  if (fulfillmentSwapInterval) {
    clearInterval(fulfillmentSwapInterval);
    fulfillmentSwapInterval = null;
  }
  console.log('[BolScheduler] All jobs stopped');
}

/**
 * Get scheduler status
 */
function getStatus() {
  return {
    running: !!(nightlySyncJob || orderPollInterval || stockSyncInterval || shipmentCheckInterval || fulfillmentSwapInterval),
    nightlySync: {
      scheduled: !!nightlySyncJob,
      nextRunAt: nightlySyncJob ? new Date(Date.now() + getMillisUntil3AM()) : null
    },
    intervals: {
      orderPoll: !!orderPollInterval,
      stockSync: !!stockSyncInterval,
      shipmentCheck: !!shipmentCheckInterval,
      fulfillmentSwap: !!fulfillmentSwapInterval
    }
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  runNightlySync,
  runOrderPoll,
  doStockSync,
  doShipmentCheck,
  doFulfillmentSwap
};
