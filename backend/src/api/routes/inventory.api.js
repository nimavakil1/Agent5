/**
 * Inventory Optimization API Routes
 *
 * Provides REST endpoints for the Inventory Optimization Agent
 * - Slow-mover detection
 * - Experiment tracking
 * - Task management
 * - Activity logs
 * - Teams notifications
 */

const express = require('express');
const router = express.Router();

const { InventoryOptimizationAgent } = require('../../core/agents/specialized/InventoryOptimizationAgent');
const { AgentActivityLog, ActionTypes, ActivityStatus } = require('../../core/agents/services/AgentActivityLog');
const { SlowMoverDetector } = require('../../core/agents/services/SlowMoverDetector');
const { OdooTaskManager } = require('../../core/agents/services/OdooTaskManager');
const { TeamsNotificationService } = require('../../core/agents/services/TeamsNotificationService');

// Singleton agent instance
let inventoryAgent = null;
let activityLog = null;
let slowMoverDetector = null;
let odooTaskManager = null;
let teamsNotification = null;

/**
 * Initialize the inventory optimization agent
 */
async function initAgent(odooClient, db) {
  if (!inventoryAgent) {
    inventoryAgent = new InventoryOptimizationAgent({
      odooClient,
      db,
    });
    await inventoryAgent.init();
  }

  // Initialize services
  if (!activityLog && db) {
    activityLog = new AgentActivityLog(db);
    await activityLog.initIndexes();
  }

  if (!slowMoverDetector) {
    slowMoverDetector = new SlowMoverDetector({ odooClient, db });
  }

  if (!odooTaskManager) {
    odooTaskManager = new OdooTaskManager({ odooClient });
    try {
      await odooTaskManager.initialize();
    } catch (err) {
      console.warn('OdooTaskManager init warning:', err.message);
    }
  }

  if (!teamsNotification) {
    teamsNotification = new TeamsNotificationService({
      webhookUrl: process.env.TEAMS_WEBHOOK_URL,
    });
  }

  return inventoryAgent;
}

/**
 * Middleware to ensure agent is initialized
 */
function requireAgent(req, res, next) {
  if (!inventoryAgent) {
    return res.status(503).json({
      error: 'Inventory optimization agent not initialized',
      message: 'Please configure Odoo connection first',
    });
  }
  next();
}

// ==================== DASHBOARD ====================

/**
 * GET /api/inventory/dashboard
 * Get comprehensive inventory optimization dashboard data
 */
router.get('/dashboard', requireAgent, async (req, res) => {
  try {
    const [
      analysis,
      experiments,
      pendingTasks,
      dailySummary,
    ] = await Promise.all([
      inventoryAgent.getAnalysisSummary(),
      inventoryAgent.getActiveExperiments(),
      inventoryAgent.getPendingTasks(),
      activityLog?.getDailySummary() || null,
    ]);

    res.json({
      success: true,
      data: {
        summary: analysis,
        activeExperiments: experiments,
        pendingTasks,
        todayStats: dailySummary,
        lastRunTime: inventoryAgent.lastRunTime,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SLOW-MOVER ANALYSIS ====================

/**
 * GET /api/inventory/slow-movers
 * Get slow-moving inventory analysis
 */
router.get('/slow-movers', requireAgent, async (req, res) => {
  try {
    const { status, limit } = req.query;

    const analysis = await slowMoverDetector.analyzeInventory();

    let products = analysis.products;

    // Filter by status if specified
    if (status) {
      products = products.filter(p => p.status === status);
    }

    // Apply limit
    if (limit) {
      products = products.slice(0, parseInt(limit));
    }

    res.json({
      success: true,
      data: {
        timestamp: analysis.timestamp,
        totalProducts: analysis.totalProducts,
        slowMovers: analysis.slowMovers,
        redFlags: analysis.redFlags,
        products,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/inventory/products/:productId/analysis
 * Get detailed analysis for a specific product
 */
router.get('/products/:productId/analysis', requireAgent, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const analysis = await slowMoverDetector.checkProduct(productId);

    res.json({ success: true, data: analysis });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/inventory/run-analysis
 * Manually trigger inventory analysis
 */
router.post('/run-analysis', requireAgent, async (req, res) => {
  try {
    const { dry_run } = req.body;

    // Log that analysis is starting
    if (activityLog) {
      await activityLog.logAction({
        agentId: 'inventory_optimization',
        actionType: ActionTypes.ANALYSIS_RUN,
        details: { manual: true, dryRun: dry_run },
        status: ActivityStatus.PENDING,
      });
    }

    // Run analysis
    const result = await inventoryAgent.runAnalysis({ dryRun: dry_run });

    res.json({
      success: true,
      data: result,
      message: dry_run
        ? 'Dry run complete - no tasks created'
        : `Analysis complete: ${result.tasksCreated || 0} tasks created`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== EXPERIMENTS ====================

/**
 * GET /api/inventory/experiments
 * Get all experiments
 */
router.get('/experiments', requireAgent, async (req, res) => {
  try {
    const { status, product_id, limit } = req.query;

    let experiments = await inventoryAgent.getExperiments({
      status,
      productId: product_id ? parseInt(product_id) : null,
      limit: limit ? parseInt(limit) : 50,
    });

    res.json({
      success: true,
      data: experiments,
      count: experiments.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/inventory/experiments/:experimentId
 * Get experiment details
 */
router.get('/experiments/:experimentId', requireAgent, async (req, res) => {
  try {
    const experiment = await inventoryAgent.getExperiment(req.params.experimentId);

    if (!experiment) {
      return res.status(404).json({
        success: false,
        error: 'Experiment not found',
      });
    }

    res.json({ success: true, data: experiment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/inventory/experiments
 * Create a new experiment (usually done automatically by agent)
 */
router.post('/experiments', requireAgent, async (req, res) => {
  try {
    const {
      product_id,
      product_sku,
      action_type,
      action_details,
      odoo_task_id,
    } = req.body;

    if (!product_id || !action_type) {
      return res.status(400).json({
        error: 'product_id and action_type are required',
      });
    }

    const experiment = await inventoryAgent.createExperiment({
      productId: product_id,
      productSku: product_sku,
      actionType: action_type,
      actionDetails: action_details,
      odooTaskId: odoo_task_id,
    });

    res.json({
      success: true,
      data: experiment,
      message: `Experiment created for product ${product_sku || product_id}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/inventory/experiments/:experimentId/complete
 * Mark experiment as complete with results
 */
router.post('/experiments/:experimentId/complete', requireAgent, async (req, res) => {
  try {
    const { success, notes } = req.body;

    const result = await inventoryAgent.completeExperiment(
      req.params.experimentId,
      { success, notes }
    );

    res.json({
      success: true,
      data: result,
      message: `Experiment marked as ${success ? 'successful' : 'unsuccessful'}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/inventory/experiments/:experimentId/stop
 * Stop an experiment early
 */
router.post('/experiments/:experimentId/stop', requireAgent, async (req, res) => {
  try {
    const { reason } = req.body;

    const result = await inventoryAgent.stopExperiment(
      req.params.experimentId,
      reason
    );

    res.json({
      success: true,
      data: result,
      message: 'Experiment stopped',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== TASKS ====================

/**
 * GET /api/inventory/tasks
 * Get agent-created tasks from Odoo
 */
router.get('/tasks', requireAgent, async (req, res) => {
  try {
    const { status } = req.query;

    let tasks;
    if (status === 'overdue') {
      tasks = await odooTaskManager.getOverdueTasks();
    } else if (status === 'pending') {
      tasks = await odooTaskManager.getPendingTasks();
    } else {
      tasks = await odooTaskManager.getPendingTasks();
    }

    res.json({
      success: true,
      data: tasks,
      count: tasks.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/inventory/tasks/:taskId
 * Get task details including messages/notes
 */
router.get('/tasks/:taskId', requireAgent, async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const task = await odooTaskManager.getTask(taskId);

    if (!task) {
      return res.status(404).json({
        success: false,
        error: 'Task not found',
      });
    }

    res.json({ success: true, data: task });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/inventory/tasks/:taskId/check-completion
 * Check if task was completed and extract action taken
 */
router.post('/tasks/:taskId/check-completion', requireAgent, async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const result = await odooTaskManager.checkTaskCompletion(taskId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/inventory/tasks/:taskId/note
 * Add a note to a task
 */
router.post('/tasks/:taskId/note', requireAgent, async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const { note } = req.body;

    if (!note) {
      return res.status(400).json({ error: 'note is required' });
    }

    await odooTaskManager.addTaskNote(taskId, note);

    res.json({
      success: true,
      message: 'Note added to task',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/inventory/tasks/stats
 * Get task statistics
 */
router.get('/tasks/stats', requireAgent, async (req, res) => {
  try {
    const { date } = req.query;
    const stats = await odooTaskManager.getTaskStats(date);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ACTIVITY LOG ====================

/**
 * GET /api/inventory/activity
 * Get agent activity log
 */
router.get('/activity', requireAgent, async (req, res) => {
  try {
    const { agent_id, action_type, status, start_date, end_date, limit } = req.query;

    const activities = await activityLog.getActivities({
      agentId: agent_id,
      actionType: action_type,
      status,
      startDate: start_date,
      endDate: end_date,
      limit: limit ? parseInt(limit) : 100,
    });

    res.json({
      success: true,
      data: activities,
      count: activities.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/inventory/activity/pending-approvals
 * Get pending approval items
 */
router.get('/activity/pending-approvals', requireAgent, async (req, res) => {
  try {
    const pending = await activityLog.getPendingApprovals();

    res.json({
      success: true,
      data: pending,
      count: pending.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/inventory/activity/daily-summary
 * Get daily activity summary
 */
router.get('/activity/daily-summary', requireAgent, async (req, res) => {
  try {
    const { date } = req.query;
    const summary = await activityLog.getDailySummary(date);

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== NOTIFICATIONS ====================

/**
 * POST /api/inventory/notify/test
 * Send a test notification to Teams
 */
router.post('/notify/test', async (req, res) => {
  try {
    const { message } = req.body;

    const result = await teamsNotification.sendSimple(
      'Test Notification',
      message || 'This is a test notification from the Inventory Optimization Agent.',
      'info'
    );

    res.json({
      success: result.success,
      data: result,
      message: result.success ? 'Test notification sent to Teams' : 'Failed to send notification',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/inventory/notify/daily-summary
 * Send daily summary notification to Teams
 */
router.post('/notify/daily-summary', requireAgent, async (req, res) => {
  try {
    const summary = await inventoryAgent.generateDailySummary();
    const result = await teamsNotification.sendDailySummary(summary);

    res.json({
      success: result.success,
      data: { summary, notificationResult: result },
      message: result.success ? 'Daily summary sent to Teams' : 'Failed to send summary',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CONFIGURATION ====================

/**
 * GET /api/inventory/status
 * Get agent status and configuration
 */
router.get('/status', (req, res) => {
  res.json({
    success: true,
    data: {
      agentInitialized: !!inventoryAgent,
      services: {
        activityLog: !!activityLog,
        slowMoverDetector: !!slowMoverDetector,
        odooTaskManager: !!odooTaskManager,
        teamsNotification: !!teamsNotification,
        teamsWebhookConfigured: !!process.env.TEAMS_WEBHOOK_URL,
      },
      config: {
        slowMoverDays: slowMoverDetector?.thresholds?.slowMoverDays || 180,
        redFlagDays: slowMoverDetector?.thresholds?.redFlagDays || 30,
        newListingDays: slowMoverDetector?.thresholds?.newListingDays || 30,
      },
      lastRunTime: inventoryAgent?.lastRunTime || null,
    },
  });
});

/**
 * POST /api/inventory/init
 * Initialize the inventory optimization agent
 */
router.post('/init', async (req, res) => {
  try {
    const odooClient = req.app.get('odooClient');
    const db = req.app.get('db');

    if (!odooClient) {
      return res.status(400).json({
        error: 'Odoo client not configured',
        message: 'Please configure Odoo connection in environment variables',
      });
    }

    await initAgent(odooClient, db);

    res.json({
      success: true,
      message: 'Inventory optimization agent initialized successfully',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/inventory/config
 * Update agent configuration
 */
router.post('/config', requireAgent, async (req, res) => {
  try {
    const {
      slow_mover_days,
      red_flag_days,
      new_listing_days,
      cost_of_capital,
    } = req.body;

    if (slow_mover_days) slowMoverDetector.thresholds.slowMoverDays = slow_mover_days;
    if (red_flag_days) slowMoverDetector.thresholds.redFlagDays = red_flag_days;
    if (new_listing_days) slowMoverDetector.thresholds.newListingDays = new_listing_days;
    if (cost_of_capital) slowMoverDetector.thresholds.costOfCapital = cost_of_capital;

    res.json({
      success: true,
      message: 'Configuration updated',
      data: slowMoverDetector.thresholds,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export router and init function
module.exports = router;
module.exports.initAgent = initAgent;
