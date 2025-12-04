/**
 * Agent Monitoring API Routes
 *
 * REST API endpoints for the agent monitoring dashboard.
 *
 * @module monitoring.api
 */

const express = require('express');
const router = express.Router();
const { getMonitor } = require('../../core/agents/monitoring/AgentMonitor');

// Get monitor instance
const getMonitorInstance = () => {
  try {
    return getMonitor();
  } catch (error) {
    return null;
  }
};

/**
 * GET /api/monitoring/dashboard
 * Get comprehensive dashboard data
 */
router.get('/dashboard', async (req, res) => {
  try {
    const monitor = getMonitorInstance();
    if (!monitor) {
      return res.status(503).json({ error: 'Monitor not initialized' });
    }

    const data = monitor.getDashboardData();
    res.json(data);
  } catch (error) {
    console.error('Dashboard data error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/monitoring/health
 * Get system health status
 */
router.get('/health', async (req, res) => {
  try {
    const monitor = getMonitorInstance();
    if (!monitor) {
      return res.status(503).json({
        status: 'unknown',
        error: 'Monitor not initialized'
      });
    }

    const health = monitor.getHealth();
    res.json(health);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

/**
 * GET /api/monitoring/agents
 * Get all agents summary
 */
router.get('/agents', async (req, res) => {
  try {
    const monitor = getMonitorInstance();
    if (!monitor) {
      return res.status(503).json({ error: 'Monitor not initialized' });
    }

    const agents = monitor.getAgentsSummary();
    res.json({ agents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/monitoring/agents/:id
 * Get specific agent details
 */
router.get('/agents/:id', async (req, res) => {
  try {
    const monitor = getMonitorInstance();
    if (!monitor) {
      return res.status(503).json({ error: 'Monitor not initialized' });
    }

    const agentId = req.params.id;
    const agents = monitor.getAgentsSummary();
    const agent = agents.find(a => a.id === agentId);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Get detailed metrics
    const metrics = monitor.agentMetrics.get(agentId);
    const detailedMetrics = {};
    if (metrics) {
      for (const [name, metric] of metrics) {
        detailedMetrics[name] = metric.toJSON();
      }
    }

    // Get recent activity
    const activity = monitor.getActivityLog({
      agentId: agentId,
      limit: 50
    });

    res.json({
      ...agent,
      detailedMetrics,
      recentActivity: activity
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/monitoring/metrics
 * Get all metrics
 */
router.get('/metrics', async (req, res) => {
  try {
    const monitor = getMonitorInstance();
    if (!monitor) {
      return res.status(503).json({ error: 'Monitor not initialized' });
    }

    const metrics = monitor.getAllMetrics();
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/monitoring/activity
 * Get activity log
 */
router.get('/activity', async (req, res) => {
  try {
    const monitor = getMonitorInstance();
    if (!monitor) {
      return res.status(503).json({ error: 'Monitor not initialized' });
    }

    const options = {
      agentId: req.query.agentId,
      action: req.query.action,
      since: req.query.since,
      limit: parseInt(req.query.limit) || 100
    };

    const activity = monitor.getActivityLog(options);
    res.json({ activity });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/monitoring/alerts
 * Get alerts
 */
router.get('/alerts', async (req, res) => {
  try {
    const monitor = getMonitorInstance();
    if (!monitor) {
      return res.status(503).json({ error: 'Monitor not initialized' });
    }

    const options = {
      severity: req.query.severity,
      source: req.query.source,
      acknowledged: req.query.acknowledged === 'true' ? true :
        req.query.acknowledged === 'false' ? false : undefined,
      limit: parseInt(req.query.limit) || 50
    };

    const alerts = monitor.getAlerts(options);
    res.json({
      alerts,
      summary: {
        total: alerts.length,
        critical: alerts.filter(a => a.severity === 'critical').length,
        error: alerts.filter(a => a.severity === 'error').length,
        warning: alerts.filter(a => a.severity === 'warning').length,
        info: alerts.filter(a => a.severity === 'info').length,
        unacknowledged: alerts.filter(a => !a.acknowledged).length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/monitoring/alerts/:id/acknowledge
 * Acknowledge an alert
 */
router.post('/alerts/:id/acknowledge', async (req, res) => {
  try {
    const monitor = getMonitorInstance();
    if (!monitor) {
      return res.status(503).json({ error: 'Monitor not initialized' });
    }

    const alertId = req.params.id;
    const acknowledgedBy = req.body.acknowledgedBy || 'user';

    const alert = monitor.acknowledgeAlert(alertId, acknowledgedBy);

    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({ alert });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/monitoring/snapshots
 * Get historical snapshots
 */
router.get('/snapshots', async (req, res) => {
  try {
    const monitor = getMonitorInstance();
    if (!monitor) {
      return res.status(503).json({ error: 'Monitor not initialized' });
    }

    const options = {
      since: req.query.since,
      limit: parseInt(req.query.limit) || 60
    };

    const snapshots = monitor.getSnapshots(options);
    res.json({ snapshots });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * WebSocket endpoint for real-time updates
 * Note: This requires WebSocket setup in main server file
 */
router.get('/ws-info', (req, res) => {
  res.json({
    message: 'WebSocket available at ws://[host]/monitoring',
    events: [
      'agentStateChange',
      'alert',
      'activity',
      'healthCheck',
      'agentRegistered',
      'agentUnregistered',
      'agentOffline',
      'agentRecovered'
    ]
  });
});

module.exports = router;
