/**
 * Bol.com Scheduler
 *
 * Schedules automatic syncs:
 * - Nightly extended sync (6 months) at 3:00 AM
 * - Order polling every 15 minutes
 * - Stock sync to Bol.com every 15 minutes
 * - Shipment confirmation check every 5 minutes
 * - FBB/FBR fulfillment swap check every hour
 * - Returns sync from Bol.com every hour
 * - Shipments list sync from Bol.com every hour
 */

const BolSyncService = require('./BolSyncService');
const BolInvoiceBooker = require('./BolInvoiceBooker');
const { getBolOrderCreator } = require('./BolOrderCreator');
const { runStockSync } = require('./BolStockSync');
const { runShipmentSync } = require('./BolShipmentSync');
const { runCancellationCheck } = require('./BolCancellationHandler');
const { runFulfillmentSwap } = require('./BolFulfillmentSwapper');
const { runBolSalesInvoicing } = require('./BolSalesInvoicer');
const { runFBBDeliverySync } = require('./BolFBBDeliverySync');
const { runBolInvoiceUpload } = require('./BolInvoiceUploader');
const { processInvoiceRequests } = require('./BolInvoiceRequestService');
const { getModuleLogger } = require('../logging/ModuleLogger');

// Get Bol module logger
const logger = getModuleLogger('bol');

let nightlySyncJob = null;
let orderPollInterval = null;
let stockSyncInterval = null;
let shipmentCheckInterval = null;
let fulfillmentSwapInterval = null;
let returnsSyncInterval = null;
let shipmentsSyncInterval = null;
let fbbDeliverySyncInterval = null;
let invoiceUploadJob = null;
let invoiceRequestJob = null;

// Interval settings (in milliseconds)
const ORDER_POLL_INTERVAL = 15 * 60 * 1000;       // 15 minutes
const STOCK_SYNC_INTERVAL = 15 * 60 * 1000;       // 15 minutes
const SHIPMENT_CHECK_INTERVAL = 5 * 60 * 1000;    // 5 minutes
const FULFILLMENT_SWAP_INTERVAL = 60 * 60 * 1000; // 1 hour
const RETURNS_SYNC_INTERVAL = 60 * 60 * 1000;     // 1 hour
const SHIPMENTS_SYNC_INTERVAL = 60 * 60 * 1000;   // 1 hour
const FBB_DELIVERY_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour

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
 * Calculate milliseconds until a specific hour (Amsterdam timezone)
 */
function getMillisUntilHour(hour, minute = 0) {
  const now = new Date();
  const target = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  target.setHours(hour, minute, 0, 0);

  // Convert back to local time
  const targetLocal = new Date(now);
  targetLocal.setHours(hour, minute, 0, 0);

  // If it's already past the target time today, schedule for tomorrow
  if (now >= targetLocal) {
    targetLocal.setDate(targetLocal.getDate() + 1);
  }

  return targetLocal.getTime() - now.getTime();
}

/**
 * Run the nightly extended sync
 */
async function runNightlySync() {
  console.log('[BolScheduler] Starting nightly extended sync...');
  const timer = logger.startTimer('NIGHTLY_SYNC', 'scheduler');

  try {
    // Step 1: Sync data from Bol.com API (orders + invoices)
    const syncResults = await BolSyncService.syncAll('EXTENDED');
    console.log('[BolScheduler] Sync complete:', syncResults);

    // Step 2: Create Odoo orders for new Bol orders
    console.log('[BolScheduler] Creating Odoo orders for pending Bol orders...');
    const orderCreator = await getBolOrderCreator();
    const orderResults = await orderCreator.createPendingOrders({ limit: 500 }); // Increased from 100
    console.log('[BolScheduler] Order creation complete:', orderResults);

    // Step 3: Book any new vendor bills (Bol charges to us) to Odoo
    console.log('[BolScheduler] Booking unbooked vendor bills to Odoo...');
    const bookingResults = await BolInvoiceBooker.bookAllUnbooked();
    console.log('[BolScheduler] Vendor bill booking complete:', bookingResults);

    // Step 4: Sync FBB delivery status (mark shipped FBB orders as delivered in Odoo)
    console.log('[BolScheduler] Syncing FBB delivery status to Odoo...');
    const fbbDeliveryResults = await runFBBDeliverySync({ limit: 1000 }); // Increased from 200
    console.log('[BolScheduler] FBB delivery sync complete:', fbbDeliveryResults);

    // Step 5: Create and post customer invoices for fully delivered orders
    // Process ALL ready invoices in batches of 500 until done
    console.log('[BolScheduler] Creating sales invoices for delivered orders...');
    let totalPosted = 0;
    let totalProcessed = 0;
    let batchNum = 0;
    let invoicingResults;

    do {
      batchNum++;
      console.log(`[BolScheduler] Invoice batch ${batchNum}...`);
      invoicingResults = await runBolSalesInvoicing({ limit: 500 });
      totalPosted += invoicingResults.posted || 0;
      totalProcessed += invoicingResults.processed || 0;
      console.log(`[BolScheduler] Batch ${batchNum}: ${invoicingResults.posted || 0} posted (total: ${totalPosted})`);
    } while (invoicingResults.posted > 0 && batchNum < 20); // Max 20 batches = 10,000 invoices

    invoicingResults = { processed: totalProcessed, posted: totalPosted, batches: batchNum };
    console.log('[BolScheduler] Sales invoicing complete:', invoicingResults);

    await timer.success(
      `Nightly sync complete: ${syncResults.orders || 0} orders, ${orderResults.created || 0} Odoo orders, ${fbbDeliveryResults.delivered || 0} FBB delivered, ${bookingResults.booked || 0} vendor bills, ${invoicingResults.posted || 0} invoices posted`,
      {
        details: { sync: syncResults, orders: orderResults, fbbDelivery: fbbDeliveryResults, booking: bookingResults, invoicing: invoicingResults }
      }
    );
  } catch (error) {
    console.error('[BolScheduler] Nightly sync failed:', error);
    await timer.error('Nightly sync failed', error);
  }

  // Schedule next run
  scheduleNightlySync();
}

/**
 * Poll for new orders and create Odoo orders
 */
async function runOrderPoll() {
  const timer = logger.startTimer('ORDER_POLL', 'scheduler');
  try {
    console.log('[BolScheduler] Polling for new orders...');

    // Sync recent orders from Bol.com
    const syncResult = await BolSyncService.syncOrders('RECENT');

    // Create Odoo orders for any pending
    const orderCreator = await getBolOrderCreator();
    const results = await orderCreator.createPendingOrders({ limit: 20 });

    if (results.created > 0) {
      console.log(`[BolScheduler] Created ${results.created} new Odoo orders`);
      await timer.success(`Polled orders: ${results.created} new Odoo orders created`, {
        details: { synced: syncResult?.synced || 0, created: results.created }
      });
    } else {
      await timer.info('Order poll complete, no new orders', {
        details: { synced: syncResult?.synced || 0, created: 0 }
      });
    }
  } catch (error) {
    console.error('[BolScheduler] Order poll failed:', error.message);
    await timer.error('Order poll failed', error);
  }
}

/**
 * Sync stock levels to Bol.com
 */
async function doStockSync() {
  const timer = logger.startTimer('STOCK_SYNC', 'scheduler');
  try {
    console.log('[BolScheduler] Syncing stock to Bol.com...');
    const results = await runStockSync();
    if (results && results.updated > 0) {
      console.log(`[BolScheduler] Updated ${results.updated} stock levels on Bol.com`);
      await timer.success(`Stock sync: ${results.updated} products updated`, {
        details: results
      });
    } else {
      await timer.info('Stock sync complete, no changes', { details: results });
    }
  } catch (error) {
    console.error('[BolScheduler] Stock sync failed:', error.message);
    await timer.error('Stock sync failed', error);
  }
}

/**
 * Check for shipments to confirm on Bol.com
 */
async function doShipmentCheck() {
  const timer = logger.startTimer('SHIPMENT_CHECK', 'scheduler');
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

    const confirmed = shipResults?.confirmed || 0;
    const canceled = cancelResults?.processed || 0;
    if (confirmed > 0 || canceled > 0) {
      await timer.success(`Shipments: ${confirmed} confirmed, ${canceled} canceled`, {
        details: { shipments: shipResults, cancellations: cancelResults }
      });
    } else {
      await timer.info('Shipment check complete, no changes', {
        details: { shipments: shipResults, cancellations: cancelResults }
      });
    }
  } catch (error) {
    console.error('[BolScheduler] Shipment/cancellation check failed:', error.message);
    await timer.error('Shipment/cancellation check failed', error);
  }
}

/**
 * Check and swap FBB/FBR fulfillment based on stock levels
 */
async function doFulfillmentSwap() {
  const timer = logger.startTimer('FULFILLMENT_SWAP', 'scheduler');
  try {
    console.log('[BolScheduler] Checking FBB/FBR fulfillment swap...');
    const results = await runFulfillmentSwap();
    const totalSwaps = (results.swappedToFbr || 0) + (results.swappedToFbb || 0);
    if (totalSwaps > 0) {
      console.log(`[BolScheduler] Swapped ${results.swappedToFbr} to FBR, ${results.swappedToFbb} to FBB`);
      await timer.success(`Fulfillment swap: ${results.swappedToFbr} to FBR, ${results.swappedToFbb} to FBB`, {
        details: results
      });
    } else {
      await timer.info('Fulfillment swap check complete, no changes', { details: results });
    }
  } catch (error) {
    console.error('[BolScheduler] Fulfillment swap check failed:', error.message);
    await timer.error('Fulfillment swap check failed', error);
  }
}

/**
 * Sync returns from Bol.com API to MongoDB
 */
async function doReturnsSync() {
  const timer = logger.startTimer('RETURNS_SYNC', 'scheduler');
  try {
    console.log('[BolScheduler] Syncing returns from Bol.com...');
    const results = await BolSyncService.syncReturns('RECENT');
    if (results && results.synced > 0) {
      console.log(`[BolScheduler] Synced ${results.synced} returns from Bol.com`);
      await timer.success(`Returns sync: ${results.synced} returns synced`, { details: results });
    } else {
      await timer.info('Returns sync complete, no new returns', { details: results });
    }
  } catch (error) {
    console.error('[BolScheduler] Returns sync failed:', error.message);
    await timer.error('Returns sync failed', error);
  }
}

/**
 * Sync shipments list from Bol.com API to MongoDB
 */
async function doShipmentsSync() {
  const timer = logger.startTimer('SHIPMENTS_SYNC', 'scheduler');
  try {
    console.log('[BolScheduler] Syncing shipments from Bol.com...');
    const results = await BolSyncService.syncShipments('RECENT');
    if (results && results.synced > 0) {
      console.log(`[BolScheduler] Synced ${results.synced} shipments from Bol.com`);
      await timer.success(`Shipments sync: ${results.synced} shipments synced`, { details: results });
    } else {
      await timer.info('Shipments sync complete, no new shipments', { details: results });
    }
  } catch (error) {
    console.error('[BolScheduler] Shipments sync failed:', error.message);
    await timer.error('Shipments sync failed', error);
  }
}

/**
 * Sync FBB (Fulfillment by Bol) delivery status to Odoo
 * Updates Odoo pickings/qty_delivered when Bol confirms shipment
 */
async function doFBBDeliverySync() {
  const timer = logger.startTimer('FBB_DELIVERY_SYNC', 'scheduler');
  try {
    console.log('[BolScheduler] Syncing FBB delivery status to Odoo...');
    const results = await runFBBDeliverySync();
    if (results && results.delivered > 0) {
      console.log(`[BolScheduler] Marked ${results.delivered} FBB orders as delivered in Odoo`);
      await timer.success(`FBB delivery sync: ${results.delivered} orders marked delivered`, { details: results });
    } else {
      await timer.info('FBB delivery sync complete, no orders to update', { details: results });
    }
  } catch (error) {
    console.error('[BolScheduler] FBB delivery sync failed:', error.message);
    await timer.error('FBB delivery sync failed', error);
  }
}

/**
 * Upload invoices to Bol.com for all orders (runs at 6:00 AM)
 */
async function doInvoiceUpload() {
  const timer = logger.startTimer('BOL_INVOICE_UPLOAD', 'scheduler');
  try {
    console.log('[BolScheduler] Uploading invoices to Bol.com...');
    const results = await runBolInvoiceUpload({ limit: 500 });
    if (results.uploaded > 0) {
      console.log(`[BolScheduler] Uploaded ${results.uploaded} invoices to Bol.com`);
      await timer.success(`Invoice upload: ${results.uploaded} uploaded`, { details: results });
    } else {
      await timer.info('Invoice upload complete, no invoices to upload', { details: results });
    }
    return results;
  } catch (error) {
    console.error('[BolScheduler] Invoice upload failed:', error.message);
    await timer.error('Invoice upload failed', error);
    throw error;
  } finally {
    // Schedule next run at 6:00 AM tomorrow
    scheduleInvoiceUpload();
  }
}

/**
 * Process invoice requests from Bol.com (runs at 6:30 AM)
 */
async function doInvoiceRequests() {
  const timer = logger.startTimer('BOL_INVOICE_REQUESTS', 'scheduler');
  try {
    console.log('[BolScheduler] Processing Bol.com invoice requests...');
    const results = await processInvoiceRequests();
    if (results.success > 0) {
      console.log(`[BolScheduler] Processed ${results.success} invoice requests`);
      await timer.success(`Invoice requests: ${results.success} processed`, { details: results });
    } else {
      await timer.info('Invoice requests complete, no requests to process', { details: results });
    }
    return results;
  } catch (error) {
    console.error('[BolScheduler] Invoice requests failed:', error.message);
    await timer.error('Invoice requests failed', error);
    throw error;
  } finally {
    // Schedule next run at 6:30 AM tomorrow
    scheduleInvoiceRequests();
  }
}

/**
 * Schedule invoice upload job for 6:00 AM
 */
function scheduleInvoiceUpload() {
  const msUntil6AM = getMillisUntilHour(6, 0);
  const hoursUntil = (msUntil6AM / 1000 / 60 / 60).toFixed(1);

  console.log(`[BolScheduler] Next invoice upload in ${hoursUntil} hours (6:00 AM)`);

  invoiceUploadJob = setTimeout(doInvoiceUpload, msUntil6AM);
}

/**
 * Schedule invoice requests job for 6:30 AM
 */
function scheduleInvoiceRequests() {
  const msUntil630AM = getMillisUntilHour(6, 30);
  const hoursUntil = (msUntil630AM / 1000 / 60 / 60).toFixed(1);

  console.log(`[BolScheduler] Next invoice requests in ${hoursUntil} hours (6:30 AM)`);

  invoiceRequestJob = setTimeout(doInvoiceRequests, msUntil630AM);
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

  // Log scheduler start
  logger.info('SCHEDULER_START', 'Bol scheduler started', {
    details: {
      jobs: ['ORDER_POLL', 'STOCK_SYNC', 'SHIPMENT_CHECK', 'FULFILLMENT_SWAP', 'RETURNS_SYNC', 'SHIPMENTS_SYNC', 'FBB_DELIVERY_SYNC', 'NIGHTLY_SYNC', 'INVOICE_UPLOAD', 'INVOICE_REQUESTS'],
      intervals: {
        orderPoll: '15 min',
        stockSync: '15 min',
        shipmentCheck: '5 min',
        fulfillmentSwap: '1 hour',
        returnsSync: '1 hour',
        shipmentsSync: '1 hour',
        fbbDeliverySync: '1 hour',
        nightlySync: '3:00 AM daily',
        invoiceUpload: '6:00 AM daily',
        invoiceRequests: '6:30 AM daily'
      }
    }
  });

  // Schedule nightly sync
  scheduleNightlySync();

  // Schedule invoice upload at 6:00 AM
  scheduleInvoiceUpload();

  // Schedule invoice requests at 6:30 AM
  scheduleInvoiceRequests();

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

  // Returns sync every hour (start after 6 minutes)
  setTimeout(() => {
    doReturnsSync();
    returnsSyncInterval = setInterval(doReturnsSync, RETURNS_SYNC_INTERVAL);
  }, 6 * 60 * 1000);

  // Shipments sync every hour (start after 7 minutes)
  setTimeout(() => {
    doShipmentsSync();
    shipmentsSyncInterval = setInterval(doShipmentsSync, SHIPMENTS_SYNC_INTERVAL);
  }, 7 * 60 * 1000);

  // FBB delivery sync every hour (start after 8 minutes)
  setTimeout(() => {
    doFBBDeliverySync();
    fbbDeliverySyncInterval = setInterval(doFBBDeliverySync, FBB_DELIVERY_SYNC_INTERVAL);
  }, 8 * 60 * 1000);

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
  if (returnsSyncInterval) {
    clearInterval(returnsSyncInterval);
    returnsSyncInterval = null;
  }
  if (shipmentsSyncInterval) {
    clearInterval(shipmentsSyncInterval);
    shipmentsSyncInterval = null;
  }
  if (fbbDeliverySyncInterval) {
    clearInterval(fbbDeliverySyncInterval);
    fbbDeliverySyncInterval = null;
  }
  if (invoiceUploadJob) {
    clearTimeout(invoiceUploadJob);
    invoiceUploadJob = null;
  }
  if (invoiceRequestJob) {
    clearTimeout(invoiceRequestJob);
    invoiceRequestJob = null;
  }
  console.log('[BolScheduler] All jobs stopped');
}

/**
 * Get scheduler status
 */
function getStatus() {
  return {
    running: !!(nightlySyncJob || orderPollInterval || stockSyncInterval || shipmentCheckInterval || fulfillmentSwapInterval || returnsSyncInterval || shipmentsSyncInterval || fbbDeliverySyncInterval || invoiceUploadJob || invoiceRequestJob),
    nightlySync: {
      scheduled: !!nightlySyncJob,
      nextRunAt: nightlySyncJob ? new Date(Date.now() + getMillisUntil3AM()) : null
    },
    invoiceUpload: {
      scheduled: !!invoiceUploadJob,
      nextRunAt: invoiceUploadJob ? new Date(Date.now() + getMillisUntilHour(6, 0)) : null
    },
    invoiceRequests: {
      scheduled: !!invoiceRequestJob,
      nextRunAt: invoiceRequestJob ? new Date(Date.now() + getMillisUntilHour(6, 30)) : null
    },
    intervals: {
      orderPoll: !!orderPollInterval,
      stockSync: !!stockSyncInterval,
      shipmentCheck: !!shipmentCheckInterval,
      fulfillmentSwap: !!fulfillmentSwapInterval,
      returnsSync: !!returnsSyncInterval,
      shipmentsSync: !!shipmentsSyncInterval,
      fbbDeliverySync: !!fbbDeliverySyncInterval
    }
  };
}

/**
 * Run sales invoicing manually (for API trigger)
 */
async function doSalesInvoicing(options = {}) {
  const timer = logger.startTimer('SALES_INVOICING', 'scheduler');
  try {
    console.log('[BolScheduler] Running sales invoicing...');
    const results = await runBolSalesInvoicing(options);
    if (results.posted > 0) {
      console.log(`[BolScheduler] Created and posted ${results.posted} invoices`);
      await timer.success(`Sales invoicing: ${results.posted} invoices posted`, { details: results });
    } else {
      await timer.info('Sales invoicing complete, no new invoices', { details: results });
    }
    return results;
  } catch (error) {
    console.error('[BolScheduler] Sales invoicing failed:', error.message);
    await timer.error('Sales invoicing failed', error);
    throw error;
  }
}

module.exports = {
  start,
  stop,
  getStatus,
  runNightlySync,
  runOrderPoll,
  doStockSync,
  doShipmentCheck,
  doFulfillmentSwap,
  doReturnsSync,
  doShipmentsSync,
  doFBBDeliverySync,
  doSalesInvoicing,
  doInvoiceUpload,
  doInvoiceRequests
};
