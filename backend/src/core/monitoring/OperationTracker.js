/**
 * OperationTracker - Track business operations for reliability monitoring
 *
 * Provides detailed tracking of key business operations:
 * - Invoice creation
 * - Tracking push to Amazon
 * - Order imports
 * - SKU resolution
 *
 * Stores recent operations in memory and aggregates statistics.
 * Can persist to MongoDB for historical analysis.
 *
 * @module OperationTracker
 */

const { getMetrics, getLogger } = require('../observability');

// Operation types
const OPERATION_TYPES = {
  INVOICE_CREATION: 'invoice_creation',
  TRACKING_PUSH: 'tracking_push',
  ORDER_IMPORT: 'order_import',
  SKU_RESOLUTION: 'sku_resolution',
  ODOO_API_CALL: 'odoo_api_call',
  AMAZON_API_CALL: 'amazon_api_call',
  VCS_IMPORT: 'vcs_import',
  FBM_IMPORT: 'fbm_import',
};

// Operation statuses
const STATUS = {
  STARTED: 'started',
  SUCCESS: 'success',
  FAILURE: 'failure',
  SKIPPED: 'skipped',
};

class OperationTracker {
  constructor(options = {}) {
    this.logger = getLogger('OperationTracker');
    this.metrics = getMetrics();
    this.maxRecentOperations = options.maxRecentOperations || 1000;
    this.recentOperations = [];
    this.db = null;
    this.persistToDb = options.persistToDb || false;

    // Aggregated stats per operation type
    this.stats = new Map();
    for (const type of Object.values(OPERATION_TYPES)) {
      this.stats.set(type, {
        total: 0,
        success: 0,
        failure: 0,
        skipped: 0,
        totalDurationMs: 0,
        lastSuccess: null,
        lastFailure: null,
        recentErrors: [],
      });
    }
  }

  /**
   * Set database connection for persistence
   */
  setDb(db) {
    this.db = db;
  }

  /**
   * Start tracking an operation
   * @param {string} type - Operation type from OPERATION_TYPES
   * @param {Object} context - Contextual data (orderId, sku, etc.)
   * @returns {Object} Operation handle with complete() and fail() methods
   */
  start(type, context = {}) {
    const operation = {
      id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      type,
      context,
      startedAt: new Date(),
      status: STATUS.STARTED,
      durationMs: null,
      error: null,
    };

    this.logger.debug({ operationId: operation.id, type, context }, 'Operation started');

    // Increment counter
    this.metrics.incCounter('operations_started_total', { type });

    return {
      id: operation.id,

      /**
       * Mark operation as successful
       * @param {Object} result - Optional result data
       */
      complete: (result = {}) => {
        operation.status = STATUS.SUCCESS;
        operation.durationMs = Date.now() - operation.startedAt.getTime();
        operation.result = result;
        this._recordCompletion(operation);
      },

      /**
       * Mark operation as failed
       * @param {Error|string} error - The error that occurred
       */
      fail: (error) => {
        operation.status = STATUS.FAILURE;
        operation.durationMs = Date.now() - operation.startedAt.getTime();
        operation.error = error instanceof Error ? error.message : String(error);
        operation.errorStack = error instanceof Error ? error.stack : null;
        this._recordCompletion(operation);
      },

      /**
       * Mark operation as skipped (e.g., already processed)
       * @param {string} reason - Reason for skipping
       */
      skip: (reason) => {
        operation.status = STATUS.SKIPPED;
        operation.durationMs = Date.now() - operation.startedAt.getTime();
        operation.skipReason = reason;
        this._recordCompletion(operation);
      },
    };
  }

  /**
   * Record operation completion and update stats
   * @private
   */
  _recordCompletion(operation) {
    const { type, status, durationMs, error } = operation;

    // Log completion
    const logData = {
      operationId: operation.id,
      type,
      status,
      durationMs,
      context: operation.context,
    };

    if (status === STATUS.FAILURE) {
      this.logger.error({ ...logData, error }, 'Operation failed');
    } else if (status === STATUS.SKIPPED) {
      this.logger.debug({ ...logData, reason: operation.skipReason }, 'Operation skipped');
    } else {
      this.logger.info(logData, 'Operation completed');
    }

    // Update metrics
    this.metrics.incCounter('operations_completed_total', { type, status });
    if (durationMs) {
      this.metrics.observeHistogram('operation_duration_ms', { type }, durationMs);
    }

    // Update stats
    const stat = this.stats.get(type);
    if (stat) {
      stat.total++;
      stat[status]++;
      if (durationMs) {
        stat.totalDurationMs += durationMs;
      }

      if (status === STATUS.SUCCESS) {
        stat.lastSuccess = new Date();
      } else if (status === STATUS.FAILURE) {
        stat.lastFailure = new Date();
        stat.recentErrors.push({
          timestamp: new Date(),
          error,
          context: operation.context,
        });
        // Keep only last 10 errors
        if (stat.recentErrors.length > 10) {
          stat.recentErrors.shift();
        }
      }
    }

    // Store in recent operations
    this.recentOperations.push(operation);
    if (this.recentOperations.length > this.maxRecentOperations) {
      this.recentOperations.shift();
    }

    // Persist to DB if enabled
    if (this.persistToDb && this.db) {
      this._persistOperation(operation).catch(err => {
        this.logger.error({ error: err.message }, 'Failed to persist operation');
      });
    }
  }

  /**
   * Persist operation to MongoDB
   * @private
   */
  async _persistOperation(operation) {
    if (!this.db) return;

    await this.db.collection('operation_log').insertOne({
      ...operation,
      createdAt: new Date(),
    });
  }

  /**
   * Get statistics for all operation types
   */
  getStats() {
    const result = {};
    for (const [type, stat] of this.stats) {
      result[type] = {
        ...stat,
        successRate: stat.total > 0 ? (stat.success / stat.total * 100).toFixed(2) + '%' : 'N/A',
        avgDurationMs: stat.success > 0 ? Math.round(stat.totalDurationMs / stat.success) : null,
      };
    }
    return result;
  }

  /**
   * Get statistics for a specific operation type
   */
  getStatsForType(type) {
    const stat = this.stats.get(type);
    if (!stat) return null;

    return {
      ...stat,
      successRate: stat.total > 0 ? (stat.success / stat.total * 100).toFixed(2) + '%' : 'N/A',
      avgDurationMs: stat.success > 0 ? Math.round(stat.totalDurationMs / stat.success) : null,
    };
  }

  /**
   * Get recent operations, optionally filtered
   */
  getRecentOperations(options = {}) {
    let operations = [...this.recentOperations];

    if (options.type) {
      operations = operations.filter(op => op.type === options.type);
    }
    if (options.status) {
      operations = operations.filter(op => op.status === options.status);
    }
    if (options.limit) {
      operations = operations.slice(-options.limit);
    }

    return operations.reverse(); // Most recent first
  }

  /**
   * Get recent failures for a specific operation type
   */
  getRecentFailures(type, limit = 10) {
    return this.getRecentOperations({ type, status: STATUS.FAILURE, limit });
  }

  /**
   * Get dashboard-friendly summary
   */
  getDashboardSummary() {
    const stats = this.getStats();
    const now = Date.now();
    const oneHourAgo = now - 3600000;

    // Count operations in last hour
    const recentOps = this.recentOperations.filter(
      op => op.startedAt.getTime() > oneHourAgo
    );

    const lastHourByType = {};
    for (const type of Object.values(OPERATION_TYPES)) {
      const typeOps = recentOps.filter(op => op.type === type);
      lastHourByType[type] = {
        total: typeOps.length,
        success: typeOps.filter(op => op.status === STATUS.SUCCESS).length,
        failure: typeOps.filter(op => op.status === STATUS.FAILURE).length,
      };
    }

    return {
      overall: stats,
      lastHour: lastHourByType,
      recentFailures: this.recentOperations
        .filter(op => op.status === STATUS.FAILURE)
        .slice(-5)
        .reverse(),
    };
  }

  /**
   * Reset all statistics (for testing)
   */
  reset() {
    this.recentOperations = [];
    for (const stat of this.stats.values()) {
      stat.total = 0;
      stat.success = 0;
      stat.failure = 0;
      stat.skipped = 0;
      stat.totalDurationMs = 0;
      stat.lastSuccess = null;
      stat.lastFailure = null;
      stat.recentErrors = [];
    }
  }
}

// Singleton instance
let trackerInstance = null;

function getOperationTracker() {
  if (!trackerInstance) {
    trackerInstance = new OperationTracker();
  }
  return trackerInstance;
}

module.exports = {
  OperationTracker,
  getOperationTracker,
  OPERATION_TYPES,
  STATUS,
};
