/**
 * Module Logs API
 *
 * Endpoints:
 * - GET /api/logs - Get paginated logs
 * - GET /api/logs/stream - SSE stream for real-time logs
 * - GET /api/logs/stats - Get statistics for a module
 * - GET /api/logs/modules - Get list of available modules
 */

const express = require('express');
const router = express.Router();
const { getLogs, getStats, getLogEmitter, VALID_MODULES } = require('../../services/logging/ModuleLogger');

/**
 * GET /api/logs
 * Get paginated logs with filtering
 *
 * Query params:
 * - module: Filter by module (bol, amazon_seller, etc.)
 * - status: Filter by status (success, warning, error, info)
 * - action: Filter by action name
 * - triggeredBy: Filter by trigger source
 * - startDate: Filter from date (ISO string)
 * - endDate: Filter to date (ISO string)
 * - limit: Number of logs per page (default 50, max 200)
 * - offset: Pagination offset
 */
router.get('/', async (req, res) => {
  try {
    const {
      module,
      status,
      action,
      triggeredBy,
      startDate,
      endDate,
      limit = 50,
      offset = 0
    } = req.query;

    // Validate module if provided
    if (module && !VALID_MODULES.includes(module)) {
      return res.status(400).json({
        error: `Invalid module. Must be one of: ${VALID_MODULES.join(', ')}`
      });
    }

    // Limit max page size
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offsetNum = parseInt(offset) || 0;

    const result = await getLogs({
      module,
      status,
      action,
      triggeredBy,
      startDate,
      endDate,
      limit: limitNum,
      offset: offsetNum
    });

    res.json(result);
  } catch (error) {
    console.error('[Logs API] Error fetching logs:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/logs/stream
 * Server-Sent Events stream for real-time logs
 *
 * Query params:
 * - module: Filter by module (optional, receives all if not specified)
 */
router.get('/stream', (req, res) => {
  const { module } = req.query;

  // Validate module if provided
  if (module && !VALID_MODULES.includes(module)) {
    return res.status(400).json({
      error: `Invalid module. Must be one of: ${VALID_MODULES.join(', ')}`
    });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // For nginx

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', module: module || 'all' })}\n\n`);

  // Keep connection alive with heartbeat
  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 30000);

  // Log event handler
  const logEmitter = getLogEmitter();
  const eventName = module ? `log:${module}` : 'log';

  const onLog = (log) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'log', log })}\n\n`);
    } catch (e) {
      // Connection might be closed
    }
  };

  logEmitter.on(eventName, onLog);

  // Cleanup on close
  req.on('close', () => {
    clearInterval(heartbeat);
    logEmitter.off(eventName, onLog);
  });
});

/**
 * GET /api/logs/stats
 * Get statistics for a module
 *
 * Query params:
 * - module: Module name (required)
 * - hours: Number of hours to look back (default 24)
 */
router.get('/stats', async (req, res) => {
  try {
    const { module, hours = 24 } = req.query;

    if (!module) {
      return res.status(400).json({ error: 'Module parameter is required' });
    }

    if (!VALID_MODULES.includes(module)) {
      return res.status(400).json({
        error: `Invalid module. Must be one of: ${VALID_MODULES.join(', ')}`
      });
    }

    const stats = await getStats(module, parseInt(hours) || 24);
    res.json(stats);
  } catch (error) {
    console.error('[Logs API] Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/logs/stats/all
 * Get statistics for all modules
 *
 * Query params:
 * - hours: Number of hours to look back (default 24)
 */
router.get('/stats/all', async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const hoursNum = parseInt(hours) || 24;

    const allStats = {};
    for (const module of VALID_MODULES) {
      allStats[module] = await getStats(module, hoursNum);
    }

    res.json(allStats);
  } catch (error) {
    console.error('[Logs API] Error fetching all stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/logs/modules
 * Get list of available modules with descriptions
 */
router.get('/modules', (req, res) => {
  const modules = [
    { id: 'bol', name: 'Bol.com', description: 'Bol.com marketplace integration' },
    { id: 'amazon_seller', name: 'Amazon Seller', description: 'Amazon Seller Central integration' },
    { id: 'amazon_vendor', name: 'Amazon Vendor', description: 'Amazon Vendor Central integration' },
    { id: 'odoo', name: 'Odoo', description: 'Odoo ERP integration' },
    { id: 'purchasing', name: 'Purchasing', description: 'Purchasing intelligence module' }
  ];

  res.json({ modules });
});

/**
 * GET /api/logs/actions/:module
 * Get list of unique actions for a module
 */
router.get('/actions/:module', async (req, res) => {
  try {
    const { module } = req.params;

    if (!VALID_MODULES.includes(module)) {
      return res.status(400).json({
        error: `Invalid module. Must be one of: ${VALID_MODULES.join(', ')}`
      });
    }

    const ModuleLog = require('../../models/ModuleLog');
    const actions = await ModuleLog.distinct('action', { module });

    res.json({ module, actions });
  } catch (error) {
    console.error('[Logs API] Error fetching actions:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
