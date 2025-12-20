/**
 * Odoo Task Manager Service
 *
 * Creates and monitors tasks in Odoo for agent actions.
 * Workflow:
 * 1. Agent creates task (assigned to Nima by default)
 * 2. Human receives notification
 * 3. Human executes action and marks task complete
 * 4. Agent reads task notes and starts monitoring
 *
 * @module OdooTaskManager
 */

class OdooTaskManager {
  constructor(config = {}) {
    this.odooClient = config.odooClient || null;

    // Default settings
    this.defaultAssigneeId = config.defaultAssigneeId || null; // Nima's user ID
    this.defaultDeadlineHours = config.defaultDeadlineHours || 48;
    this.projectId = config.projectId || null; // AI Agent Tasks project

    // Task type prefixes for easy identification
    this.taskPrefixes = {
      price_reduction: '[PRICE]',
      cpc_increase: '[CPC]',
      write_off: '[WRITE-OFF]',
      investigation: '[INVESTIGATE]',
      general: '[AGENT]'
    };
  }

  setOdooClient(client) {
    this.odooClient = client;
  }

  /**
   * Initialize - find or create the AI Agent Tasks project
   */
  async initialize() {
    if (!this.odooClient) {
      throw new Error('Odoo client not configured');
    }

    // Find or create project for AI Agent Tasks
    const projects = await this.odooClient.executeKw(
      'project.project',
      'search_read',
      [[['name', '=', 'AI Agent Tasks']]],
      { fields: ['id', 'name'] }
    );

    if (projects.length > 0) {
      this.projectId = projects[0].id;
    } else {
      // Create the project
      this.projectId = await this.odooClient.executeKw(
        'project.project',
        'create',
        [{
          name: 'AI Agent Tasks',
          description: 'Tasks created by AI Agents for human action'
        }]
      );
    }

    // Find default assignee (you can update this with actual user ID)
    if (!this.defaultAssigneeId) {
      const users = await this.odooClient.executeKw(
        'res.users',
        'search_read',
        [[['login', 'ilike', 'nima']]],
        { fields: ['id', 'name', 'login'], limit: 1 }
      );

      if (users.length > 0) {
        this.defaultAssigneeId = users[0].id;
      }
    }

    console.log(`OdooTaskManager initialized: Project ID ${this.projectId}, Assignee ID ${this.defaultAssigneeId}`);

    return {
      projectId: this.projectId,
      defaultAssigneeId: this.defaultAssigneeId
    };
  }

  /**
   * Create a task for human action
   *
   * @param {Object} params
   * @param {string} params.type - Task type (price_reduction, cpc_increase, etc.)
   * @param {string} params.title - Task title
   * @param {string} params.description - Detailed description with context
   * @param {string} params.productSku - Related product SKU
   * @param {string} params.productName - Product name
   * @param {string} params.priority - 0=Low, 1=Medium, 2=High, 3=Urgent
   * @param {number} params.deadlineHours - Hours until deadline
   * @param {number} params.assigneeId - Override default assignee
   */
  async createTask(params) {
    if (!this.projectId) {
      await this.initialize();
    }

    const {
      type = 'general',
      title,
      description,
      productSku = '',
      productName = '',
      priority = '1', // Medium by default
      deadlineHours = this.defaultDeadlineHours,
      assigneeId = this.defaultAssigneeId,
      agentId = 'inventory_optimization',
      experimentId = null
    } = params;

    // Calculate deadline
    const deadline = new Date();
    deadline.setHours(deadline.getHours() + deadlineHours);

    // Format task name with prefix
    const prefix = this.taskPrefixes[type] || this.taskPrefixes.general;
    const taskName = `${prefix} ${productSku ? `[${productSku}] ` : ''}${title}`;

    // Build description with context
    const fullDescription = `
## Task Created by AI Agent

**Agent:** ${agentId}
**Product:** ${productSku} - ${productName}
**Created:** ${new Date().toISOString()}
**Deadline:** ${deadline.toISOString()}

---

## Action Required

${description}

---

## Instructions

1. Review the recommendation above
2. If approved, execute the action (change price, increase CPC, etc.)
3. Add a note to this task with what was done (e.g., "Reduced price to €15.99 on Amazon.de")
4. Mark the task as complete

**Note:** The AI Agent will monitor this task. Once completed, it will start tracking sales to evaluate the effectiveness of the action.

---

_This task was automatically created by the Inventory Optimization Agent._
${experimentId ? `\n_Experiment ID: ${experimentId}_` : ''}
    `.trim();

    // Create the task
    const taskId = await this.odooClient.executeKw(
      'project.task',
      'create',
      [{
        name: taskName,
        project_id: this.projectId,
        user_ids: assigneeId ? [[6, 0, [assigneeId]]] : false,
        description: fullDescription,
        priority: priority,
        date_deadline: deadline.toISOString().split('T')[0],
        tag_ids: [[6, 0, []]] // Can add tags later
      }]
    );

    return {
      taskId,
      taskName,
      deadline,
      projectId: this.projectId,
      assigneeId
    };
  }

  /**
   * Get task status and notes
   */
  async getTask(taskId) {
    const tasks = await this.odooClient.executeKw(
      'project.task',
      'search_read',
      [[['id', '=', taskId]]],
      {
        fields: [
          'id', 'name', 'stage_id', 'user_ids', 'date_deadline',
          'description', 'priority', 'create_date', 'write_date',
          'message_ids'
        ]
      }
    );

    if (tasks.length === 0) {
      return null;
    }

    const task = tasks[0];

    // Get messages/notes on the task
    const messages = await this.odooClient.executeKw(
      'mail.message',
      'search_read',
      [[['model', '=', 'project.task'], ['res_id', '=', taskId], ['message_type', '!=', 'notification']]],
      { fields: ['body', 'date', 'author_id'], order: 'date desc', limit: 10 }
    );

    // Determine if task is done based on stage
    const stages = await this.odooClient.executeKw(
      'project.task.type',
      'search_read',
      [[['id', '=', task.stage_id?.[0]]]],
      { fields: ['name', 'fold'] }
    );

    const stageName = stages.length > 0 ? stages[0].name : 'Unknown';
    const isCompleted = stages.length > 0 && (stages[0].fold || stageName.toLowerCase().includes('done'));

    return {
      id: task.id,
      name: task.name,
      stage: stageName,
      isCompleted,
      deadline: task.date_deadline,
      priority: task.priority,
      createdAt: task.create_date,
      updatedAt: task.write_date,
      messages: messages.map(m => ({
        body: m.body?.replace(/<[^>]*>/g, '') || '', // Strip HTML
        date: m.date,
        author: m.author_id?.[1] || 'Unknown'
      }))
    };
  }

  /**
   * Get all pending/overdue tasks
   */
  async getPendingTasks() {
    if (!this.projectId) {
      await this.initialize();
    }

    // Get all non-completed tasks
    const tasks = await this.odooClient.executeKw(
      'project.task',
      'search_read',
      [[
        ['project_id', '=', this.projectId],
        ['stage_id.fold', '=', false] // Not in a folded (done) stage
      ]],
      {
        fields: [
          'id', 'name', 'stage_id', 'user_ids', 'date_deadline',
          'priority', 'create_date'
        ],
        order: 'date_deadline asc'
      }
    );

    const now = new Date();

    return tasks.map(task => {
      const deadline = task.date_deadline ? new Date(task.date_deadline) : null;
      const isOverdue = deadline && deadline < now;

      return {
        id: task.id,
        name: task.name,
        stage: task.stage_id?.[1] || 'Unknown',
        deadline: task.date_deadline,
        isOverdue,
        priority: task.priority,
        createdAt: task.create_date,
        assignees: task.user_ids
      };
    });
  }

  /**
   * Get overdue tasks
   */
  async getOverdueTasks() {
    const pending = await this.getPendingTasks();
    return pending.filter(t => t.isOverdue);
  }

  /**
   * Add a note to a task
   */
  async addTaskNote(taskId, note) {
    await this.odooClient.executeKw(
      'project.task',
      'message_post',
      [[taskId]],
      {
        body: note,
        message_type: 'comment'
      }
    );
  }

  /**
   * Check if task was completed and extract action taken
   */
  async checkTaskCompletion(taskId) {
    const task = await this.getTask(taskId);

    if (!task) {
      return { found: false };
    }

    if (!task.isCompleted) {
      return {
        found: true,
        completed: false,
        task
      };
    }

    // Try to extract what action was taken from messages
    let actionTaken = null;
    for (const message of task.messages) {
      // Look for price changes, CPC changes, etc.
      const body = message.body.toLowerCase();

      if (body.includes('reduced') || body.includes('changed') || body.includes('updated')) {
        actionTaken = {
          description: message.body,
          date: message.date,
          author: message.author
        };
        break;
      }
    }

    return {
      found: true,
      completed: true,
      task,
      actionTaken
    };
  }

  /**
   * Get task statistics for daily summary
   */
  async getTaskStats(date = null) {
    if (!this.projectId) {
      await this.initialize();
    }

    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    // Get all tasks from this project
    const allTasks = await this.odooClient.executeKw(
      'project.task',
      'search_read',
      [[['project_id', '=', this.projectId]]],
      {
        fields: ['id', 'name', 'stage_id', 'date_deadline', 'create_date', 'write_date']
      }
    );

    // Get stages to identify completed tasks
    const stageIds = [...new Set(allTasks.map(t => t.stage_id?.[0]).filter(Boolean))];
    const stages = await this.odooClient.executeKw(
      'project.task.type',
      'search_read',
      [[['id', 'in', stageIds]]],
      { fields: ['id', 'name', 'fold'] }
    );
    const completedStageIds = stages.filter(s => s.fold).map(s => s.id);

    const now = new Date();

    const stats = {
      total: allTasks.length,
      pending: 0,
      completed: 0,
      overdue: 0,
      createdToday: 0,
      completedToday: 0
    };

    for (const task of allTasks) {
      const isCompleted = completedStageIds.includes(task.stage_id?.[0]);
      const deadline = task.date_deadline ? new Date(task.date_deadline) : null;
      const createdAt = new Date(task.create_date);
      const updatedAt = new Date(task.write_date);

      if (isCompleted) {
        stats.completed++;
        if (updatedAt >= targetDate && updatedAt < nextDay) {
          stats.completedToday++;
        }
      } else {
        stats.pending++;
        if (deadline && deadline < now) {
          stats.overdue++;
        }
      }

      if (createdAt >= targetDate && createdAt < nextDay) {
        stats.createdToday++;
      }
    }

    return stats;
  }
}

module.exports = { OdooTaskManager };
