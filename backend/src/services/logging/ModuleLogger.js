/**
 * ModuleLogger - Centralized logging service for all modules
 *
 * Features:
 * - Logs to MongoDB with automatic 60-day TTL
 * - Real-time SSE streaming to connected clients
 * - Event emitter for internal subscriptions
 *
 * Usage:
 *   const logger = getModuleLogger('bol');
 *   await logger.log('ORDER_SYNC', 'success', 'Synced 12 orders', { synced: 12 });
 *   await logger.info('Scheduler started');
 *   await logger.error('API call failed', error);
 */

const EventEmitter = require('events');
const ModuleLog = require('../../models/ModuleLog');

// Global event emitter for SSE streaming
const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100); // Allow many SSE connections

// Valid modules
const VALID_MODULES = ['bol', 'amazon_seller', 'amazon_vendor', 'odoo', 'purchasing'];

class ModuleLogger {
  constructor(module) {
    if (!VALID_MODULES.includes(module)) {
      throw new Error(`Invalid module: ${module}. Must be one of: ${VALID_MODULES.join(', ')}`);
    }
    this.module = module;
  }

  /**
   * Log an action
   * @param {string} action - Action name (e.g., 'ORDER_SYNC', 'FBB_INVENTORY')
   * @param {string} status - 'success' | 'warning' | 'error' | 'info'
   * @param {string} summary - Human-readable summary
   * @param {object} options - Additional options
   */
  async log(action, status, summary, options = {}) {
    const {
      details = {},
      duration = null,
      triggeredBy = 'system',
      relatedIds = {},
      error = null
    } = options;

    const logEntry = {
      module: this.module,
      action,
      status,
      summary,
      details,
      duration,
      triggeredBy,
      relatedIds,
      timestamp: new Date()
    };

    // Add error details if present
    if (error) {
      logEntry.error = {
        message: error.message || String(error),
        stack: error.stack,
        code: error.code
      };
    }

    try {
      // Save to MongoDB
      const saved = await ModuleLog.create(logEntry);

      // Emit for SSE streaming
      logEmitter.emit('log', {
        ...logEntry,
        _id: saved._id
      });

      // Also emit module-specific event
      logEmitter.emit(`log:${this.module}`, {
        ...logEntry,
        _id: saved._id
      });

      return saved;
    } catch (err) {
      console.error(`[ModuleLogger] Failed to save log:`, err.message);
      // Still emit even if save fails
      logEmitter.emit('log', logEntry);
      return null;
    }
  }

  /**
   * Log a success message
   */
  async success(action, summary, options = {}) {
    return this.log(action, 'success', summary, options);
  }

  /**
   * Log an info message
   */
  async info(action, summary, options = {}) {
    return this.log(action, 'info', summary, options);
  }

  /**
   * Log a warning message
   */
  async warning(action, summary, options = {}) {
    return this.log(action, 'warning', summary, options);
  }

  /**
   * Log an error message
   */
  async error(action, summary, errorObj, options = {}) {
    return this.log(action, 'error', summary, {
      ...options,
      error: errorObj
    });
  }

  /**
   * Create a timed action logger
   * Usage:
   *   const timer = logger.startTimer('ORDER_SYNC');
   *   // ... do work ...
   *   await timer.success('Synced 12 orders', { synced: 12 });
   */
  startTimer(action, triggeredBy = 'system') {
    const startTime = Date.now();
    const self = this;

    return {
      async success(summary, options = {}) {
        return self.log(action, 'success', summary, {
          ...options,
          duration: Date.now() - startTime,
          triggeredBy
        });
      },
      async warning(summary, options = {}) {
        return self.log(action, 'warning', summary, {
          ...options,
          duration: Date.now() - startTime,
          triggeredBy
        });
      },
      async error(summary, errorObj, options = {}) {
        return self.log(action, 'error', summary, {
          ...options,
          duration: Date.now() - startTime,
          triggeredBy,
          error: errorObj
        });
      },
      async info(summary, options = {}) {
        return self.log(action, 'info', summary, {
          ...options,
          duration: Date.now() - startTime,
          triggeredBy
        });
      }
    };
  }
}

// Logger instances cache
const loggerInstances = {};

/**
 * Get a logger instance for a module
 * @param {string} module - Module name
 * @returns {ModuleLogger}
 */
function getModuleLogger(module) {
  if (!loggerInstances[module]) {
    loggerInstances[module] = new ModuleLogger(module);
  }
  return loggerInstances[module];
}

/**
 * Get the log event emitter (for SSE streaming)
 */
function getLogEmitter() {
  return logEmitter;
}

/**
 * Get logs from database
 */
async function getLogs(options = {}) {
  return ModuleLog.getLogs(options);
}

/**
 * Get statistics for a module
 */
async function getStats(module, hours = 24) {
  return ModuleLog.getStats(module, hours);
}

module.exports = {
  ModuleLogger,
  getModuleLogger,
  getLogEmitter,
  getLogs,
  getStats,
  VALID_MODULES
};
