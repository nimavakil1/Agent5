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

      // Simple read to verify connectivity
      const result = await client.searchRead('res.users', [['id', '=', client.uid]], ['id', 'name'], { limit: 1 });

      if (result && result.length > 0) {
        return { status: 'healthy', details: { user: result[0].name, uid: client.uid } };
      }
      return { status: 'degraded', details: 'Authenticated but user lookup failed' };
    } catch (error) {
      return { status: 'unhealthy', details: error.message };
    }
  }, { critical: true, timeout: 10000 });

  logger.info('Registered Odoo health check');
}

/**
 * Register Amazon Seller API health check
 */
function registerAmazonSellerHealth(AmazonSellerClient) {
  const health = getHealth();

  health.register('amazon_seller', async () => {
    try {
      const client = new AmazonSellerClient();

      // Check token status
      const tokenValid = client.isTokenValid();
      if (!tokenValid) {
        // Try to refresh
        await client.refreshToken();
      }

      // Simple API call to verify connectivity
      // Use getMarketplaceParticipations which is lightweight
      const participations = await client.getMarketplaceParticipations();

      if (participations && participations.length > 0) {
        return {
          status: 'healthy',
          details: {
            marketplaces: participations.length,
            tokenExpiresIn: client.getTokenExpiresIn(),
          },
        };
      }
      return { status: 'degraded', details: 'No marketplace participations found' };
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
 * Register all health checks
 * Call this during application startup
 */
async function registerAllHealthChecks(dependencies = {}) {
  const {
    getDb,
    OdooDirectClient,
    AmazonSellerClient,
  } = dependencies;

  if (getDb) {
    registerMongoHealth(getDb);
  }

  if (OdooDirectClient) {
    registerOdooHealth(OdooDirectClient);
  }

  if (AmazonSellerClient) {
    registerAmazonSellerHealth(AmazonSellerClient);
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

  // Operation statistics
  router.get('/operations/stats', (req, res) => {
    const tracker = getOperationTracker();
    res.json(tracker.getStats());
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
  registerAllHealthChecks,
  createHealthRouter,
};
