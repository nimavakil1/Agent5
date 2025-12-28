/**
 * Bol.com Scheduler
 *
 * Schedules automatic syncs:
 * - Nightly extended sync (6 months) at 3:00 AM
 */

const BolSyncService = require('./BolSyncService');
const BolInvoiceBooker = require('./BolInvoiceBooker');

let nightlySyncJob = null;

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
    // Step 1: Sync data from Bol.com API
    const syncResults = await BolSyncService.syncAll('EXTENDED');
    console.log('[BolScheduler] Sync complete:', syncResults);

    // Step 2: Book any new invoices to Odoo
    console.log('[BolScheduler] Booking unbooked invoices to Odoo...');
    const bookingResults = await BolInvoiceBooker.bookAllUnbooked();
    console.log('[BolScheduler] Invoice booking complete:', bookingResults);

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`[BolScheduler] Nightly sync complete in ${duration} minutes:`, {
      sync: syncResults,
      booking: bookingResults
    });
  } catch (error) {
    console.error('[BolScheduler] Nightly sync failed:', error);
  }

  // Schedule next run
  scheduleNightlySync();
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
  scheduleNightlySync();
}

/**
 * Stop the scheduler
 */
function stop() {
  if (nightlySyncJob) {
    clearTimeout(nightlySyncJob);
    nightlySyncJob = null;
    console.log('[BolScheduler] Stopped');
  }
}

/**
 * Get scheduler status
 */
function getStatus() {
  return {
    running: !!nightlySyncJob,
    nextRunAt: nightlySyncJob ? new Date(Date.now() + getMillisUntil3AM()) : null
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  runNightlySync // Expose for manual trigger if needed
};
