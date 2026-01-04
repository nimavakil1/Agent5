/**
 * Odoo Sync Module
 *
 * Provides MongoDB mirror of Odoo data with automatic synchronization.
 */

const { OdooSyncService, getOdooSyncService, MODEL_CONFIGS } = require('./OdooSyncService');
const { OdooSyncScheduler, getOdooSyncScheduler } = require('./OdooSyncScheduler');

module.exports = {
  // Service classes
  OdooSyncService,
  OdooSyncScheduler,

  // Singleton getters
  getOdooSyncService,
  getOdooSyncScheduler,

  // Configuration
  MODEL_CONFIGS
};
