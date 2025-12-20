/**
 * Agent Activity Log Service
 *
 * Tracks all agent decisions, actions, and experiments for:
 * - Audit trail
 * - Manager Agent daily summaries
 * - Experiment tracking
 * - Task monitoring
 *
 * @module AgentActivityLog
 */

class AgentActivityLog {
  constructor(db) {
    this.db = db;
    this.collectionName = 'agent_activity_log';
  }

  /**
   * Initialize indexes for the collection
   */
  async initIndexes() {
    const collection = this.db.collection(this.collectionName);

    await collection.createIndex({ agentId: 1, timestamp: -1 });
    await collection.createIndex({ actionType: 1, timestamp: -1 });
    await collection.createIndex({ status: 1 });
    await collection.createIndex({ productId: 1 });
    await collection.createIndex({ experimentId: 1 });
    await collection.createIndex({ odooTaskId: 1 });
    await collection.createIndex({ timestamp: -1 });

    console.log('AgentActivityLog indexes created');
  }

  /**
   * Log an agent action
   *
   * @param {Object} params
   * @param {string} params.agentId - Which agent (purchasing, inventory, manager)
   * @param {string} params.actionType - Type of action
   * @param {Object} params.details - Action-specific details
   * @param {string} params.productId - Related product (if applicable)
   * @param {string} params.status - pending, approved, rejected, executed, completed
   */
  async logAction(params) {
    const {
      agentId,
      actionType,
      details = {},
      productId = null,
      productSku = null,
      status = 'logged',
      odooTaskId = null,
      experimentId = null
    } = params;

    const entry = {
      agentId,
      actionType,
      details,
      productId,
      productSku,
      status,
      odooTaskId,
      experimentId,
      timestamp: new Date(),
      updatedAt: new Date()
    };

    const collection = this.db.collection(this.collectionName);
    const result = await collection.insertOne(entry);

    return { ...entry, _id: result.insertedId };
  }

  /**
   * Update an existing log entry
   */
  async updateEntry(entryId, updates) {
    const collection = this.db.collection(this.collectionName);

    await collection.updateOne(
      { _id: entryId },
      {
        $set: {
          ...updates,
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Get activities for a date range
   */
  async getActivities(params = {}) {
    const {
      agentId = null,
      actionType = null,
      status = null,
      startDate = null,
      endDate = null,
      productId = null,
      limit = 100
    } = params;

    const query = {};

    if (agentId) query.agentId = agentId;
    if (actionType) query.actionType = actionType;
    if (status) query.status = status;
    if (productId) query.productId = productId;

    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    const collection = this.db.collection(this.collectionName);
    return collection
      .find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Get yesterday's activities for daily summary
   */
  async getYesterdayActivities() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    return this.getActivities({
      startDate: yesterday,
      endDate: today,
      limit: 1000
    });
  }

  /**
   * Get pending approvals
   */
  async getPendingApprovals() {
    const collection = this.db.collection(this.collectionName);
    return collection
      .find({ status: { $in: ['pending', 'proposed'] } })
      .sort({ timestamp: -1 })
      .toArray();
  }

  /**
   * Generate daily summary stats
   */
  async getDailySummary(date = null) {
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const collection = this.db.collection(this.collectionName);

    const activities = await collection.find({
      timestamp: { $gte: targetDate, $lt: nextDay }
    }).toArray();

    // Aggregate stats
    const stats = {
      date: targetDate.toISOString().split('T')[0],
      totalActions: activities.length,
      byAgent: {},
      byActionType: {},
      byStatus: {},
      experiments: {
        started: 0,
        completed: 0,
        successful: 0,
        failed: 0
      },
      tasks: {
        created: 0,
        completed: 0,
        overdue: 0
      }
    };

    for (const activity of activities) {
      // By agent
      stats.byAgent[activity.agentId] = (stats.byAgent[activity.agentId] || 0) + 1;

      // By action type
      stats.byActionType[activity.actionType] = (stats.byActionType[activity.actionType] || 0) + 1;

      // By status
      stats.byStatus[activity.status] = (stats.byStatus[activity.status] || 0) + 1;

      // Experiments
      if (activity.actionType === 'experiment_started') stats.experiments.started++;
      if (activity.actionType === 'experiment_completed') {
        stats.experiments.completed++;
        if (activity.details?.success) stats.experiments.successful++;
        else stats.experiments.failed++;
      }

      // Tasks
      if (activity.actionType === 'task_created') stats.tasks.created++;
      if (activity.actionType === 'task_completed') stats.tasks.completed++;
      if (activity.actionType === 'task_overdue') stats.tasks.overdue++;
    }

    return stats;
  }
}

// Action types enum
const ActionTypes = {
  // Inventory Optimization Agent
  SLOW_MOVER_DETECTED: 'slow_mover_detected',
  PRICE_REDUCTION_PROPOSED: 'price_reduction_proposed',
  CPC_INCREASE_PROPOSED: 'cpc_increase_proposed',
  WRITE_OFF_PROPOSED: 'write_off_proposed',
  EXPERIMENT_STARTED: 'experiment_started',
  EXPERIMENT_DAILY_CHECK: 'experiment_daily_check',
  EXPERIMENT_COMPLETED: 'experiment_completed',
  EXPERIMENT_STOPPED_EARLY: 'experiment_stopped_early',

  // Task management
  TASK_CREATED: 'task_created',
  TASK_REMINDER_SENT: 'task_reminder_sent',
  TASK_COMPLETED: 'task_completed',
  TASK_OVERDUE: 'task_overdue',
  TASK_ESCALATED: 'task_escalated',

  // Purchasing Agent
  REORDER_RECOMMENDED: 'reorder_recommended',
  CNY_ALERT: 'cny_alert',
  STOCKOUT_WARNING: 'stockout_warning',

  // General
  ANALYSIS_RUN: 'analysis_run',
  NOTIFICATION_SENT: 'notification_sent',
  HUMAN_INPUT_RECEIVED: 'human_input_received'
};

// Status enum
const ActivityStatus = {
  LOGGED: 'logged',
  PENDING: 'pending',
  PROPOSED: 'proposed',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTED: 'executed',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

module.exports = {
  AgentActivityLog,
  ActionTypes,
  ActivityStatus
};
