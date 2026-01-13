/**
 * Health Check Registration
 *
 * Registers health checks for all critical integrations:
 * - MongoDB
 * - Odoo API
 * - Amazon Seller API
 *
 * @module healthChecks
 */

const { getHealth, getLogger } = require('../observability');

const logger = getLogger('HealthChecks');

/**
 * Register MongoDB health check
 */
function registerMongoHealth(getDb) {
  const health = getHealth();

  health.register('mongodb', async () => {
    try {
      const db = getDb();
      if (!db) {
        return { status: 'unhealthy', details: 'Database not initialized' };
      }

      // Ping the database
      const result = await db.command({ ping: 1 });
      if (result.ok === 1) {
        return { status: 'healthy', details: { ping: 'ok' } };
      }
      return { status: 'unhealthy', details: 'Ping failed' };
    } catch (error) {
      return { status: 'unhealthy', details: error.message };
    }
  }, { critical: true, timeout: 5000 });

  logger.info('Registered MongoDB health check');
}

/**
 * Register Odoo API health check
 */
function registerOdooHealth(OdooDirectClient) {
  const health = getHealth();

  health.register('odoo', async () => {
    try {
      const client = new OdooDirectClient();
      await client.authenticate();

      if (!client.authenticated) {
        return { status: 'unhealthy', details: 'Authentication failed' };
      }

      // Simple read to verify connectivity - just check if we can read partners
      const result = await client.searchRead('res.partner', [], ['id', 'name'], { limit: 1 });

      if (result && result.length > 0) {
        return { status: 'healthy', details: { connected: true, partners: result.length } };
      }
      return { status: 'degraded', details: 'Authenticated but no partners found' };
    } catch (error) {
      return { status: 'unhealthy', details: error.message };
    }
  }, { critical: true, timeout: 10000 });

  logger.info('Registered Odoo health check');
}

/**
 * Register Amazon Seller API health check
 */
function registerAmazonSellerHealth(SellerClient) {
  const health = getHealth();

  health.register('amazon_seller', async () => {
    try {
      const client = new SellerClient();
      await client.init();

      // Use testConnection which does a minimal API call
      const result = await client.testConnection();

      if (result.success) {
        return {
          status: 'healthy',
          details: {
            ordersFound: result.ordersFound || 0,
          },
        };
      }
      return { status: 'degraded', details: result.error || 'Connection test failed' };
    } catch (error) {
      // Check for specific error types
      if (error.message?.includes('rate limit') || error.message?.includes('throttl')) {
        return { status: 'degraded', details: 'Rate limited: ' + error.message };
      }
      return { status: 'unhealthy', details: error.message };
    }
  }, { critical: false, timeout: 15000 });

  logger.info('Registered Amazon Seller API health check');
}

/**
 * Register Bol.com API health check
 */
function registerBolHealth(BolClient) {
  const health = getHealth();

  health.register('bol', async () => {
    try {
      const client = new BolClient();
      await client.authenticate();

      // Simple API call to verify connectivity - get recent orders
      const result = await client.getOrders({ page: 1 });

      return {
        status: 'healthy',
        details: {
          authenticated: true,
          ordersAccessible: result !== null,
        },
      };
    } catch (error) {
      if (error.message?.includes('rate limit') || error.message?.includes('429')) {
        return { status: 'degraded', details: 'Rate limited: ' + error.message };
      }
      return { status: 'unhealthy', details: error.message };
    }
  }, { critical: false, timeout: 15000 });

  logger.info('Registered Bol.com API health check');
}

/**
 * Register all health checks
 * Call this during application startup
 */
async function registerAllHealthChecks(dependencies = {}) {
  const {
    getDb,
    OdooDirectClient,
    SellerClient,
    BolClient,
  } = dependencies;

  if (getDb) {
    registerMongoHealth(getDb);
  }

  if (OdooDirectClient) {
    registerOdooHealth(OdooDirectClient);
  }

  if (SellerClient) {
    registerAmazonSellerHealth(SellerClient);
  }

  if (BolClient) {
    registerBolHealth(BolClient);
  }

  logger.info('All health checks registered');
}

/**
 * Create Express router for health endpoints
 */
function createHealthRouter() {
  const express = require('express');
  const router = express.Router();
  const health = getHealth();
  const { getMetrics } = require('../observability');
  const { getOperationTracker } = require('./OperationTracker');

  // Liveness probe - simple alive check
  router.get('/live', async (req, res) => {
    const result = await health.liveness();
    res.json(result);
  });

  // Readiness probe - all critical checks must pass
  router.get('/ready', async (req, res) => {
    const result = await health.readiness();
    res.status(result.ready ? 200 : 503).json(result);
  });

  // Full health check - detailed status of all integrations
  router.get('/health', async (req, res) => {
    const result = await health.check();
    const statusCode = result.status === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json(result);
  });

  // Prometheus metrics endpoint
  router.get('/metrics', (req, res) => {
    const metrics = getMetrics();
    res.set('Content-Type', 'text/plain');
    res.send(metrics.getPrometheusMetrics());
  });

  // JSON metrics endpoint
  router.get('/metrics/json', (req, res) => {
    const metrics = getMetrics();
    res.json(metrics.getJsonMetrics());
  });

  // Operation statistics (with failure counts for shell badge)
  router.get('/operations/stats', async (req, res) => {
    const tracker = getOperationTracker();
    const stats = tracker.getStats();

    // Count recent failures (last hour)
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const recentOps = tracker.getRecentOperations({ limit: 200 });
    const recentFailures = recentOps.filter(
      op => op.status === 'failure' && new Date(op.startedAt).getTime() > oneHourAgo
    ).length;

    // Count unhealthy checks
    let unhealthyChecks = 0;
    try {
      const healthResult = await health.check();
      if (healthResult.checks) {
        unhealthyChecks = Object.values(healthResult.checks).filter(
          c => c.status === 'unhealthy'
        ).length;
      }
    } catch (e) {
      // Ignore health check errors
    }

    res.json({
      ...stats,
      recentFailures,
      unhealthyChecks,
    });
  });

  // Operation dashboard summary
  router.get('/operations/dashboard', (req, res) => {
    const tracker = getOperationTracker();
    res.json(tracker.getDashboardSummary());
  });

  // Recent operations (with optional filters)
  router.get('/operations/recent', (req, res) => {
    const tracker = getOperationTracker();
    const { type, status, limit } = req.query;
    const operations = tracker.getRecentOperations({
      type,
      status,
      limit: limit ? parseInt(limit) : 50,
    });
    res.json(operations);
  });

  // Recent failures
  router.get('/operations/failures', (req, res) => {
    const tracker = getOperationTracker();
    const { type, limit } = req.query;
    const failures = type
      ? tracker.getRecentFailures(type, limit ? parseInt(limit) : 10)
      : tracker.getRecentOperations({ status: 'failure', limit: limit ? parseInt(limit) : 20 });
    res.json(failures);
  });

  return router;
}

module.exports = {
  registerMongoHealth,
  registerOdooHealth,
  registerAmazonSellerHealth,
  registerBolHealth,
  registerAllHealthChecks,
  createHealthRouter,
};
