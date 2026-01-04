/**
 * OdooSyncScheduler - Manages scheduled synchronization of Odoo data
 *
 * Schedules:
 * - Incremental sync: Every 10 minutes (configurable)
 * - Full sync: Daily at 3 AM (configurable)
 */

const { getOdooSyncService } = require('./OdooSyncService');

class OdooSyncScheduler {
  constructor(options = {}) {
    this.syncService = null;
    this.incrementalInterval = null;
    this.fullSyncTimeout = null;
    this.isRunning = false;
    this.lastIncrementalSync = null;
    this.lastFullSync = null;

    // Configuration
    this.config = {
      incrementalIntervalMinutes: options.incrementalIntervalMinutes || 10,
      fullSyncHour: options.fullSyncHour || 3, // 3 AM
      enabled: options.enabled !== false
    };
  }

  /**
   * Start the scheduler
   */
  async start() {
    if (this.isRunning) {
      console.log('[OdooSyncScheduler] Already running');
      return;
    }

    if (!this.config.enabled) {
      console.log('[OdooSyncScheduler] Disabled by configuration');
      return;
    }

    console.log('[OdooSyncScheduler] Starting...');
    console.log(`[OdooSyncScheduler] Incremental sync every ${this.config.incrementalIntervalMinutes} minutes`);
    console.log(`[OdooSyncScheduler] Full sync daily at ${this.config.fullSyncHour}:00`);

    this.syncService = getOdooSyncService();
    this.isRunning = true;

    // Run initial incremental sync after 30 seconds (let app start up first)
    setTimeout(() => this.runIncrementalSync(), 30 * 1000);

    // Schedule recurring incremental sync
    this.incrementalInterval = setInterval(
      () => this.runIncrementalSync(),
      this.config.incrementalIntervalMinutes * 60 * 1000
    );

    // Schedule next full sync
    this.scheduleNextFullSync();

    console.log('[OdooSyncScheduler] Started');
  }

  /**
   * Stop the scheduler
   */
  stop() {
    console.log('[OdooSyncScheduler] Stopping...');

    if (this.incrementalInterval) {
      clearInterval(this.incrementalInterval);
      this.incrementalInterval = null;
    }

    if (this.fullSyncTimeout) {
      clearTimeout(this.fullSyncTimeout);
      this.fullSyncTimeout = null;
    }

    this.isRunning = false;
    console.log('[OdooSyncScheduler] Stopped');
  }

  /**
   * Run incremental sync
   */
  async runIncrementalSync() {
    if (!this.isRunning) return;

    try {
      console.log('[OdooSyncScheduler] Running incremental sync...');
      const result = await this.syncService.incrementalSync();
      this.lastIncrementalSync = {
        timestamp: new Date(),
        result
      };

      const totalRecords = result.results.reduce((sum, r) => sum + (r.synced || 0), 0);
      console.log(`[OdooSyncScheduler] Incremental sync complete: ${totalRecords} records in ${result.duration}s`);
    } catch (err) {
      console.error('[OdooSyncScheduler] Incremental sync error:', err.message);
    }
  }

  /**
   * Run full sync
   */
  async runFullSync() {
    if (!this.isRunning) return;

    try {
      console.log('[OdooSyncScheduler] Running FULL sync...');
      const result = await this.syncService.fullSync();
      this.lastFullSync = {
        timestamp: new Date(),
        result
      };

      const totalRecords = result.results.reduce((sum, r) => sum + (r.synced || 0), 0);
      console.log(`[OdooSyncScheduler] Full sync complete: ${totalRecords} records in ${result.duration}s`);
    } catch (err) {
      console.error('[OdooSyncScheduler] Full sync error:', err.message);
    }

    // Schedule next full sync
    this.scheduleNextFullSync();
  }

  /**
   * Schedule the next full sync at the configured hour
   */
  scheduleNextFullSync() {
    const now = new Date();
    const nextSync = new Date();

    // Set to today at the configured hour
    nextSync.setHours(this.config.fullSyncHour, 0, 0, 0);

    // If that time has passed today, schedule for tomorrow
    if (nextSync <= now) {
      nextSync.setDate(nextSync.getDate() + 1);
    }

    const msUntilSync = nextSync.getTime() - now.getTime();
    const hoursUntilSync = (msUntilSync / (1000 * 60 * 60)).toFixed(1);

    console.log(`[OdooSyncScheduler] Next full sync scheduled in ${hoursUntilSync} hours (${nextSync.toISOString()})`);

    this.fullSyncTimeout = setTimeout(() => this.runFullSync(), msUntilSync);
  }

  /**
   * Manually trigger a sync
   */
  async triggerSync(type = 'incremental') {
    if (type === 'full') {
      return this.runFullSync();
    } else {
      return this.runIncrementalSync();
    }
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      lastIncrementalSync: this.lastIncrementalSync,
      lastFullSync: this.lastFullSync
    };
  }
}

// Singleton instance
let scheduler = null;

function getOdooSyncScheduler(options = {}) {
  if (!scheduler) {
    scheduler = new OdooSyncScheduler(options);
  }
  return scheduler;
}

module.exports = {
  OdooSyncScheduler,
  getOdooSyncScheduler
};
