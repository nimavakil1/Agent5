/**
 * Monitoring Module
 *
 * Provides business operation tracking and health checks.
 * Works alongside the observability module for comprehensive monitoring.
 *
 * @module monitoring
 */

const { OperationTracker, getOperationTracker, OPERATION_TYPES, STATUS } = require('./OperationTracker');
const {
  registerMongoHealth,
  registerOdooHealth,
  registerAmazonSellerHealth,
  registerAllHealthChecks,
  createHealthRouter,
} = require('./healthChecks');

module.exports = {
  // Operation tracking
  OperationTracker,
  getOperationTracker,
  OPERATION_TYPES,
  STATUS,

  // Health checks
  registerMongoHealth,
  registerOdooHealth,
  registerAmazonSellerHealth,
  registerAllHealthChecks,
  createHealthRouter,
};
