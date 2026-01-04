/**
 * Inventory Optimization Agent
 *
 * AI agent that monitors and optimizes inventory levels:
 * - Detects slow-moving inventory
 * - Proposes price reductions / CPC increases
 * - Creates Odoo tasks for human action
 * - Tracks experiments after actions are taken
 * - Proposes write-offs for hopeless cases
 *
 * PHASE 1: Agent proposes, human executes, agent monitors
 *
 * @module InventoryOptimizationAgent
 */

const { LLMAgent } = require('../LLMAgent');
const { SlowMoverDetector } = require('../services/SlowMoverDetector');
const { OdooTaskManager } = require('../services/OdooTaskManager');
const { TeamsNotificationService } = require('../services/TeamsNotificationService');
const { AgentActivityLog, ActionTypes, ActivityStatus } = require('../services/AgentActivityLog');

class InventoryOptimizationAgent extends LLMAgent {
  constructor(id, config = {}) {
    super(id, {
      name: config.name || 'Inventory Optimization Agent',
      role: 'inventory_optimization',
      capabilities: [
        'slow_mover_detection',
        'price_recommendation',
        'experiment_tracking',
        'write_off_proposal',
        'task_creation'
      ],
      ...config
    });

    // Initialize services
    this.slowMoverDetector = new SlowMoverDetector(config);
    this.taskManager = new OdooTaskManager(config);
    this.teamsService = new TeamsNotificationService(config);
    this.activityLog = null; // Will be set when DB is available

    // Configuration
    this.config = {
      experimentDaysMax: config.experimentDaysMax || 14,
      experimentEarlyStopDays: config.experimentEarlyStopDays || 7,
      experimentSuccessThreshold: config.experimentSuccessThreshold || 0.5, // 50% sales increase
      maxFailedExperiments: config.maxFailedExperiments || 3,
      ...config
    };

    // State
    this.runningExperiments = new Map();
    this.lastRunTime = null;
  }

  /**
   * Initialize the agent with database and Odoo client
   */
  async init(db, odooClient) {
    this.activityLog = new AgentActivityLog(db);
    await this.activityLog.initIndexes();

    this.slowMoverDetector.setOdooClient(odooClient);
    this.slowMoverDetector.setDb(db);

    this.taskManager.setOdooClient(odooClient);
    await this.taskManager.initialize();

    this.db = db;
    this.odooClient = odooClient;

    console.log('InventoryOptimizationAgent initialized');
  }

  /**
   * Run full inventory analysis
   */
  async runAnalysis() {
    console.log('Starting inventory optimization analysis...');

    const startTime = Date.now();

    // 1. Detect slow-movers
    const analysis = await this.slowMoverDetector.analyzeInventory();

    // 2. Log the analysis run
    await this.activityLog.logAction({
      agentId: 'inventory_optimization',
      actionType: ActionTypes.ANALYSIS_RUN,
      details: {
        totalProducts: analysis.totalProducts,
        slowMovers: analysis.slowMovers,
        redFlags: analysis.redFlags,
        duration: Date.now() - startTime
      },
      status: ActivityStatus.COMPLETED
    });

    // 3. Process products needing attention
    const results = {
      analyzed: analysis.totalProducts,
      slowMovers: analysis.slowMovers,
      redFlags: analysis.redFlags,
      tasksCreated: 0,
      experimentsStarted: 0
    };

    for (const product of analysis.products) {
      try {
        await this._processProduct(product);

        if (product.status === 'red_flag' || product.status === 'slow_mover') {
          // Check if we should create a task
          const shouldCreateTask = await this._shouldCreateTask(product);

          if (shouldCreateTask) {
            await this._createTaskForProduct(product);
            results.tasksCreated++;
          }
        }
      } catch (error) {
        console.error(`Error processing product ${product.productSku}:`, error);
      }
    }

    // 4. Check running experiments
    await this._checkRunningExperiments();

    // 5. Check overdue tasks
    await this._checkOverdueTasks();

    console.log(`Analysis complete: ${results.slowMovers} slow-movers, ${results.redFlags} red flags, ${results.tasksCreated} tasks created`);

    this.lastRunTime = new Date();

    return results;
  }

  /**
   * Process a single product
   */
  async _processProduct(product) {
    // Log detection
    if (product.status === 'red_flag') {
      await this.activityLog.logAction({
        agentId: 'inventory_optimization',
        actionType: ActionTypes.SLOW_MOVER_DETECTED,
        productId: product.productId,
        productSku: product.productSku,
        details: {
          status: 'red_flag',
          daysOfStock: product.metrics.daysOfStock,
          daysSinceLastSale: product.metrics.daysSinceLastSale,
          stockValue: product.metrics.stockValue,
          monthlyHoldingCost: product.metrics.monthlyHoldingCost,
          recommendations: product.recommendations
        },
        status: ActivityStatus.LOGGED
      });

      // Send Teams notification for red flags
      await this.teamsService.sendSlowMoverAlert(product);
    } else if (product.status === 'slow_mover') {
      await this.activityLog.logAction({
        agentId: 'inventory_optimization',
        actionType: ActionTypes.SLOW_MOVER_DETECTED,
        productId: product.productId,
        productSku: product.productSku,
        details: {
          status: 'slow_mover',
          daysOfStock: product.metrics.daysOfStock,
          stockValue: product.metrics.stockValue,
          recommendations: product.recommendations
        },
        status: ActivityStatus.LOGGED
      });
    }
  }

  /**
   * Check if we should create a task for this product
   * (Avoid duplicate tasks)
   */
  async _shouldCreateTask(product) {
    // Check if there's already a pending task for this product
    const existingTasks = await this.db.collection('agent_activity_log').findOne({
      productId: product.productId,
      actionType: { $in: [ActionTypes.TASK_CREATED, ActionTypes.PRICE_REDUCTION_PROPOSED] },
      status: { $in: [ActivityStatus.PENDING, ActivityStatus.PROPOSED] },
      timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
    });

    return !existingTasks;
  }

  /**
   * Create an Odoo task for a product
   */
  async _createTaskForProduct(product) {
    // Determine task type and description based on recommendations
    const primaryRec = product.recommendations[0];
    let taskType = 'general';
    let title = '';
    let description = '';

    if (product.status === 'red_flag') {
      taskType = 'investigation';
      title = `Investigate: No sales in ${product.metrics.daysSinceLastSale} days`;
      description = `
**Product has had no sales for ${product.metrics.daysSinceLastSale} days.**

This requires immediate investigation:
1. Check if product is listed correctly on Amazon/Bol.com
2. Check competitor prices
3. Check if there are any content issues

**Current Metrics:**
- Stock on hand: ${product.metrics.qtyOnHand} units
- Stock value: €${product.metrics.stockValue}
- Monthly holding cost: €${product.metrics.monthlyHoldingCost}

**Recommendations:**
${product.recommendations.map(r => `- ${r.message}`).join('\n')}

Please investigate and then either:
- Fix any listing issues, OR
- Approve a price reduction experiment
      `;
    } else if (primaryRec?.type === 'price_reduction') {
      taskType = 'price_reduction';
      title = `Reduce price by 15-20%`;
      description = `
**Slow-moving inventory detected.**

**Current Metrics:**
- Days of stock: ${product.metrics.daysOfStock} days
- Average daily sales: ${product.metrics.avgDailySales} units
- Stock value: €${product.metrics.stockValue}
- Monthly holding cost: €${product.metrics.monthlyHoldingCost}

**Recommendation:**
Reduce price by 15-20% on Amazon/Bol.com to accelerate sales.

**Justification:**
At current sales rate, we have ${product.metrics.daysOfStock} days of stock. The holding cost is €${product.metrics.monthlyHoldingCost}/month. A price reduction will cost less than continued holding.

**Action Required:**
1. Reduce price by 15-20% on relevant marketplaces
2. Add a note to this task with the new price
3. Mark task complete

The agent will monitor sales for 14 days after the change.
      `;
    } else if (primaryRec?.type === 'cpc_increase') {
      taskType = 'cpc_increase';
      title = `Increase advertising CPC`;
      description = `
**Consider increasing advertising to boost sales.**

**Current Metrics:**
- Days of stock: ${product.metrics.daysOfStock} days
- Stock value: €${product.metrics.stockValue}
- Monthly holding cost: €${product.metrics.monthlyHoldingCost}

**Recommendation:**
Before reducing price, try increasing CPC (cost per click) to drive more traffic.

**Action Required:**
1. Increase CPC by 20-30%
2. Add a note with the new CPC value
3. Mark task complete

The agent will monitor sales for 14 days.
      `;
    } else if (primaryRec?.type === 'write_off_review') {
      taskType = 'write_off';
      title = `Review for write-off: ${product.metrics.daysOfStock}+ days stock`;
      description = `
**This product may be a candidate for write-off or liquidation.**

**Current Metrics:**
- Days of stock: ${product.metrics.daysOfStock} days
- Days since last sale: ${product.metrics.daysSinceLastSale} days
- Stock value: €${product.metrics.stockValue}
- Monthly holding cost: €${product.metrics.monthlyHoldingCost}

**Options:**
1. Deep discount (50%+) for liquidation
2. Bundle with other products
3. Donate or discard
4. Partial write-off

**Action Required:**
Review and decide on the best course of action.
      `;
    }

    // Create the task
    const task = await this.taskManager.createTask({
      type: taskType,
      title,
      description,
      productSku: product.productSku,
      productName: product.productName,
      priority: product.status === 'red_flag' ? '2' : '1',
      agentId: 'inventory_optimization'
    });

    // Log task creation
    await this.activityLog.logAction({
      agentId: 'inventory_optimization',
      actionType: ActionTypes.TASK_CREATED,
      productId: product.productId,
      productSku: product.productSku,
      odooTaskId: task.taskId,
      details: {
        taskType,
        title,
        deadline: task.deadline
      },
      status: ActivityStatus.PROPOSED
    });

    // Notify via Teams
    await this.teamsService.sendTaskCreated({
      name: `${product.productSku}: ${title}`,
      productSku: product.productSku,
      deadline: task.deadline,
      priority: product.status === 'red_flag' ? '2' : '1',
      description
    });

    return task;
  }

  /**
   * Check running experiments for results
   */
  async _checkRunningExperiments() {
    // Get all running experiments from activity log
    const experiments = await this.db.collection('agent_activity_log').find({
      actionType: ActionTypes.EXPERIMENT_STARTED,
      status: ActivityStatus.EXECUTED
    }).toArray();

    for (const experiment of experiments) {
      try {
        await this._evaluateExperiment(experiment);
      } catch (error) {
        console.error(`Error evaluating experiment ${experiment._id}:`, error);
      }
    }
  }

  /**
   * Evaluate a running experiment
   */
  async _evaluateExperiment(experiment) {
    const daysSinceStart = Math.floor(
      (Date.now() - new Date(experiment.timestamp).getTime()) / (1000 * 60 * 60 * 24)
    );

    // Get current sales data
    const currentSales = await this._getRecentSales(experiment.productId, daysSinceStart);
    const beforeSales = experiment.details.avgDailySalesBefore || 0;

    const salesChange = beforeSales > 0
      ? ((currentSales - beforeSales) / beforeSales) * 100
      : (currentSales > 0 ? 100 : 0);

    // Log daily check
    await this.activityLog.logAction({
      agentId: 'inventory_optimization',
      actionType: ActionTypes.EXPERIMENT_DAILY_CHECK,
      productId: experiment.productId,
      productSku: experiment.productSku,
      experimentId: experiment._id.toString(),
      details: {
        day: daysSinceStart,
        salesBefore: beforeSales,
        salesNow: currentSales,
        salesChange
      },
      status: ActivityStatus.LOGGED
    });

    // Check if experiment should be stopped early (clear trend after 7 days)
    const shouldStopEarly = daysSinceStart >= this.config.experimentEarlyStopDays &&
      Math.abs(salesChange) > 50; // Clear trend

    // Check if experiment is complete
    const isComplete = daysSinceStart >= this.config.experimentDaysMax || shouldStopEarly;

    if (isComplete) {
      const success = salesChange >= this.config.experimentSuccessThreshold * 100;

      // Mark experiment as complete
      await this.activityLog.updateEntry(experiment._id, {
        status: ActivityStatus.COMPLETED
      });

      // Log completion
      await this.activityLog.logAction({
        agentId: 'inventory_optimization',
        actionType: shouldStopEarly ? ActionTypes.EXPERIMENT_STOPPED_EARLY : ActionTypes.EXPERIMENT_COMPLETED,
        productId: experiment.productId,
        productSku: experiment.productSku,
        experimentId: experiment._id.toString(),
        details: {
          success,
          daysSinceStart,
          salesBefore: beforeSales,
          salesAfter: currentSales,
          salesChange,
          stoppedEarly: shouldStopEarly
        },
        status: ActivityStatus.COMPLETED
      });

      // Send Teams notification
      await this.teamsService.sendExperimentUpdate({
        productSku: experiment.productSku,
        action: experiment.details.action,
        status: 'completed',
        success,
        currentDay: daysSinceStart,
        maxDays: this.config.experimentDaysMax,
        salesBefore: beforeSales,
        salesNow: currentSales,
        salesChange: Math.round(salesChange)
      });

      // If failed, increment failure count and maybe propose more action
      if (!success) {
        await this._handleFailedExperiment(experiment);
      }
    }
  }

  /**
   * Handle failed experiment - maybe propose further action
   */
  async _handleFailedExperiment(experiment) {
    // Count failed experiments for this product
    const failedCount = await this.db.collection('agent_activity_log').countDocuments({
      productId: experiment.productId,
      actionType: ActionTypes.EXPERIMENT_COMPLETED,
      'details.success': false
    });

    if (failedCount >= this.config.maxFailedExperiments) {
      // Product is a hopeless case - propose write-off
      await this.activityLog.logAction({
        agentId: 'inventory_optimization',
        actionType: ActionTypes.WRITE_OFF_PROPOSED,
        productId: experiment.productId,
        productSku: experiment.productSku,
        details: {
          reason: `${failedCount} failed experiments`,
          experiments: failedCount
        },
        status: ActivityStatus.PROPOSED
      });

      // Create write-off task
      await this.taskManager.createTask({
        type: 'write_off',
        title: 'Product marked as hopeless case - review for write-off',
        description: `
This product has had ${failedCount} failed price/CPC experiments and is still not selling.

Consider:
1. Deep discount liquidation
2. Bundle sale
3. Donation
4. Write-off

This is an automated recommendation based on ${failedCount} unsuccessful attempts to improve sales.
        `,
        productSku: experiment.productSku,
        productName: '',
        priority: '1'
      });
    }
  }

  /**
   * Check for overdue tasks and send reminders
   */
  async _checkOverdueTasks() {
    const overdueTasks = await this.taskManager.getOverdueTasks();

    for (const task of overdueTasks) {
      // Check if we already sent a reminder recently
      const recentReminder = await this.db.collection('agent_activity_log').findOne({
        odooTaskId: task.id,
        actionType: ActionTypes.TASK_REMINDER_SENT,
        timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
      });

      if (!recentReminder) {
        // Send reminder
        await this.teamsService.sendTaskReminder(task);

        // Log reminder
        await this.activityLog.logAction({
          agentId: 'inventory_optimization',
          actionType: ActionTypes.TASK_REMINDER_SENT,
          odooTaskId: task.id,
          details: {
            taskName: task.name,
            deadline: task.deadline
          },
          status: ActivityStatus.LOGGED
        });
      }
    }
  }

  /**
   * Get recent sales for a product
   */
  async _getRecentSales(productId, days) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const salesLines = await this.odooClient.executeKw(
      'sale.order.line',
      'search_read',
      [[
        ['product_id', '=', productId],
        ['order_id.state', 'in', ['sale', 'done']],
        ['order_id.date_order', '>=', startDate.toISOString().split('T')[0]]
      ]],
      { fields: ['product_uom_qty'] }
    );

    const totalQty = salesLines.reduce((sum, line) => sum + line.product_uom_qty, 0);
    return days > 0 ? totalQty / days : totalQty;
  }

  /**
   * Handle human input via UI
   */
  async handleHumanInput(input) {
    const { message, productSku, context } = input;

    // Log the input
    await this.activityLog.logAction({
      agentId: 'inventory_optimization',
      actionType: ActionTypes.HUMAN_INPUT_RECEIVED,
      productSku,
      details: {
        message,
        context
      },
      status: ActivityStatus.LOGGED
    });

    // Use LLM to understand and respond
    const response = await this._analyzeHumanInput(message, productSku, context);

    return response;
  }

  /**
   * Analyze human input with LLM
   */
  async _analyzeHumanInput(_message, productSku, _context) {
    // This will use the LLM to understand the question and provide recommendations
    // For now, return a placeholder - will integrate with Claude API

    return {
      understood: true,
      response: `I'll analyze your question about ${productSku || 'the product'}. Let me gather the relevant data...`,
      recommendations: []
    };
  }

  /**
   * Get summary for Manager Agent
   */
  async getSummary(date = null) {
    const stats = await this.activityLog.getDailySummary(date);
    const taskStats = await this.taskManager.getTaskStats(date);
    const pendingTasks = await this.taskManager.getPendingTasks();

    return {
      date: stats.date,
      inventory: {
        slowMovers: stats.byActionType[ActionTypes.SLOW_MOVER_DETECTED] || 0,
        redFlags: 0, // Calculate from details
        experimentsRunning: (await this.db.collection('agent_activity_log').countDocuments({
          actionType: ActionTypes.EXPERIMENT_STARTED,
          status: ActivityStatus.EXECUTED
        })),
        experimentsCompleted: stats.byActionType[ActionTypes.EXPERIMENT_COMPLETED] || 0
      },
      tasks: {
        created: taskStats.createdToday,
        completed: taskStats.completedToday,
        overdue: taskStats.overdue
      },
      pendingApprovals: pendingTasks.filter(t => t.name.includes('[PRICE]') || t.name.includes('[CPC]'))
    };
  }

  // ==================== API HELPER METHODS ====================

  /**
   * Get analysis summary for dashboard
   */
  async getAnalysisSummary() {
    const analysis = await this.slowMoverDetector.analyzeInventory();
    return {
      timestamp: analysis.timestamp,
      totalProducts: analysis.totalProducts,
      slowMovers: analysis.slowMovers,
      redFlags: analysis.redFlags,
      newListings: analysis.newListings,
      awaitingStock: analysis.awaitingStock
    };
  }

  /**
   * Get active experiments
   */
  async getActiveExperiments() {
    return this.db.collection('agent_activity_log').find({
      actionType: ActionTypes.EXPERIMENT_STARTED,
      status: ActivityStatus.EXECUTED
    }).sort({ timestamp: -1 }).toArray();
  }

  /**
   * Get pending tasks from Odoo
   */
  async getPendingTasks() {
    return this.taskManager.getPendingTasks();
  }

  /**
   * Get experiments with filters
   */
  async getExperiments(filters = {}) {
    const query = {
      actionType: { $in: [ActionTypes.EXPERIMENT_STARTED, ActionTypes.EXPERIMENT_COMPLETED] }
    };

    if (filters.status === 'running') {
      query.status = ActivityStatus.EXECUTED;
      query.actionType = ActionTypes.EXPERIMENT_STARTED;
    } else if (filters.status === 'completed') {
      query.actionType = ActionTypes.EXPERIMENT_COMPLETED;
    }

    if (filters.productId) {
      query.productId = filters.productId;
    }

    return this.db.collection('agent_activity_log')
      .find(query)
      .sort({ timestamp: -1 })
      .limit(filters.limit || 50)
      .toArray();
  }

  /**
   * Get single experiment by ID
   */
  async getExperiment(experimentId) {
    const { ObjectId } = require('mongodb');
    return this.db.collection('agent_activity_log').findOne({
      _id: new ObjectId(experimentId)
    });
  }

  /**
   * Create a new experiment
   */
  async createExperiment(params) {
    const { productId, productSku, actionType, actionDetails, odooTaskId } = params;

    // Get baseline sales
    const avgDailySalesBefore = await this._getRecentSales(productId, 30);

    const entry = await this.activityLog.logAction({
      agentId: 'inventory_optimization',
      actionType: ActionTypes.EXPERIMENT_STARTED,
      productId,
      productSku,
      odooTaskId,
      details: {
        action: actionType,
        actionDetails,
        avgDailySalesBefore,
        startDate: new Date()
      },
      status: ActivityStatus.EXECUTED
    });

    return entry;
  }

  /**
   * Complete an experiment
   */
  async completeExperiment(experimentId, result) {
    const { ObjectId } = require('mongodb');
    const experiment = await this.getExperiment(experimentId);

    if (!experiment) {
      throw new Error('Experiment not found');
    }

    // Update experiment status
    await this.activityLog.updateEntry(new ObjectId(experimentId), {
      status: ActivityStatus.COMPLETED
    });

    // Log completion
    const completion = await this.activityLog.logAction({
      agentId: 'inventory_optimization',
      actionType: ActionTypes.EXPERIMENT_COMPLETED,
      productId: experiment.productId,
      productSku: experiment.productSku,
      experimentId,
      details: {
        success: result.success,
        notes: result.notes,
        manualCompletion: true
      },
      status: ActivityStatus.COMPLETED
    });

    return completion;
  }

  /**
   * Stop an experiment early
   */
  async stopExperiment(experimentId, reason) {
    const { ObjectId } = require('mongodb');
    const experiment = await this.getExperiment(experimentId);

    if (!experiment) {
      throw new Error('Experiment not found');
    }

    // Update experiment status
    await this.activityLog.updateEntry(new ObjectId(experimentId), {
      status: ActivityStatus.CANCELLED
    });

    // Log stop
    const stop = await this.activityLog.logAction({
      agentId: 'inventory_optimization',
      actionType: ActionTypes.EXPERIMENT_STOPPED_EARLY,
      productId: experiment.productId,
      productSku: experiment.productSku,
      experimentId,
      details: {
        reason,
        stoppedManually: true
      },
      status: ActivityStatus.CANCELLED
    });

    return stop;
  }

  /**
   * Generate daily summary for Teams notification
   */
  async generateDailySummary() {
    const summary = await this.getSummary();
    const pendingApprovals = await this.activityLog.getPendingApprovals();

    return {
      date: new Date().toISOString().split('T')[0],
      purchasing: {
        analyzed: 0,
        reorders: 0,
        cnyAlerts: 0
      },
      inventory: summary.inventory,
      tasks: summary.tasks,
      pendingApprovals: pendingApprovals.map(p => ({
        name: `${p.productSku || 'Unknown'}: ${p.actionType}`
      })),
      metrics: {
        holdingCostImpact: 0,
        experimentSuccessRate: 0
      }
    };
  }
}

module.exports = { InventoryOptimizationAgent };
