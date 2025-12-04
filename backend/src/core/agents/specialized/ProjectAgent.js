/**
 * Project Management Agent
 *
 * Monitors and manages projects, tasks, and team performance:
 * - Track project progress across all systems
 * - Monitor task completion and deadlines
 * - Identify blockers and delays
 * - Follow up on overdue items
 * - Analyze team workload and performance
 * - Generate status reports
 *
 * Integrates with:
 * - Odoo Projects/Tasks
 * - Microsoft Planner
 * - Communication data (emails, Teams)
 * - SharePoint documents
 *
 * @module ProjectAgent
 */

const LLMAgent = require('../LLMAgent');

/**
 * Task status
 */
const TaskStatus = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  ON_HOLD: 'on_hold',
  COMPLETED: 'completed',
  OVERDUE: 'overdue',
  BLOCKED: 'blocked'
};

/**
 * Priority levels
 */
const Priority = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

class ProjectAgent extends LLMAgent {
  constructor(id, config = {}) {
    super(id, {
      name: config.name || 'Project Management Agent',
      role: 'project_management',
      capabilities: [
        'project_tracking',
        'task_management',
        'deadline_monitoring',
        'workload_analysis',
        'performance_tracking',
        'blocker_detection',
        'status_reporting',
        'followup_automation'
      ],
      ...config
    });

    // Odoo client
    this.odooClient = config.odooClient || null;

    // Microsoft Graph config (for Planner)
    this.graphConfig = {
      tenantId: config.tenantId || process.env.MICROSOFT_TENANT_ID,
      clientId: config.clientId || process.env.MICROSOFT_CLIENT_ID,
      clientSecret: config.clientSecret || process.env.MICROSOFT_CLIENT_SECRET
    };

    // Access token
    this.accessToken = null;
    this.tokenExpiry = null;

    // Project state tracking
    this.projectCache = new Map();
    this.taskCache = new Map();
    this.followUps = [];
    this.blockers = [];

    // Settings
    this.settings = {
      overdueThresholdHours: config.overdueThresholdHours || 24,
      followUpIntervalHours: config.followUpIntervalHours || 48,
      workloadWarningThreshold: config.workloadWarningThreshold || 10  // tasks per person
    };

    // Define tools
    this._initializeTools();
  }

  _initializeTools() {
    this.tools = [
      // ==================== PROJECT OVERVIEW ====================
      {
        name: 'get_all_projects',
        description: 'Get all active projects from Odoo and Planner',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              enum: ['all', 'odoo', 'planner'],
              default: 'all'
            },
            status: {
              type: 'string',
              enum: ['active', 'completed', 'all'],
              default: 'active'
            }
          }
        },
        handler: this._getAllProjects.bind(this)
      },
      {
        name: 'get_project_status',
        description: 'Get detailed status of a specific project',
        parameters: {
          type: 'object',
          properties: {
            project_id: {
              type: 'string',
              description: 'Project ID'
            },
            source: {
              type: 'string',
              enum: ['odoo', 'planner'],
              default: 'odoo'
            }
          },
          required: ['project_id']
        },
        handler: this._getProjectStatus.bind(this)
      },

      // ==================== TASK MANAGEMENT ====================
      {
        name: 'get_all_tasks',
        description: 'Get all tasks, optionally filtered',
        parameters: {
          type: 'object',
          properties: {
            assignee: {
              type: 'string',
              description: 'Filter by assignee name or email'
            },
            status: {
              type: 'string',
              enum: ['open', 'completed', 'overdue', 'all'],
              default: 'open'
            },
            priority: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low', 'all'],
              default: 'all'
            },
            project_id: {
              type: 'string',
              description: 'Filter by project'
            }
          }
        },
        handler: this._getAllTasks.bind(this)
      },
      {
        name: 'get_overdue_tasks',
        description: 'Get all overdue tasks that need attention',
        parameters: {
          type: 'object',
          properties: {
            days_overdue: {
              type: 'number',
              description: 'Minimum days overdue',
              default: 0
            }
          }
        },
        handler: this._getOverdueTasks.bind(this)
      },
      {
        name: 'get_upcoming_deadlines',
        description: 'Get tasks with upcoming deadlines',
        parameters: {
          type: 'object',
          properties: {
            days_ahead: {
              type: 'number',
              default: 7
            }
          }
        },
        handler: this._getUpcomingDeadlines.bind(this)
      },
      {
        name: 'create_task',
        description: 'Create a new task (requires approval)',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            assignee: { type: 'string' },
            deadline: { type: 'string', description: 'ISO date string' },
            priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            project_id: { type: 'string' },
            source: { type: 'string', enum: ['odoo', 'planner'], default: 'odoo' }
          },
          required: ['title', 'assignee']
        },
        handler: this._createTask.bind(this)
      },
      {
        name: 'update_task_status',
        description: 'Update the status of a task',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            status: { type: 'string', enum: ['not_started', 'in_progress', 'on_hold', 'completed'] },
            notes: { type: 'string' },
            source: { type: 'string', enum: ['odoo', 'planner'], default: 'odoo' }
          },
          required: ['task_id', 'status']
        },
        handler: this._updateTaskStatus.bind(this)
      },

      // ==================== TEAM ANALYSIS ====================
      {
        name: 'get_team_workload',
        description: 'Analyze workload distribution across team members',
        parameters: {
          type: 'object',
          properties: {
            team: {
              type: 'string',
              description: 'Optional: filter by team/department'
            }
          }
        },
        handler: this._getTeamWorkload.bind(this)
      },
      {
        name: 'get_employee_tasks',
        description: 'Get all tasks assigned to a specific employee',
        parameters: {
          type: 'object',
          properties: {
            employee: {
              type: 'string',
              description: 'Employee name or email'
            },
            include_completed: {
              type: 'boolean',
              default: false
            }
          },
          required: ['employee']
        },
        handler: this._getEmployeeTasks.bind(this)
      },
      {
        name: 'get_performance_metrics',
        description: 'Get task completion metrics for employees',
        parameters: {
          type: 'object',
          properties: {
            period_days: {
              type: 'number',
              default: 30
            },
            employee: {
              type: 'string',
              description: 'Optional: specific employee'
            }
          }
        },
        handler: this._getPerformanceMetrics.bind(this)
      },

      // ==================== BLOCKERS & ISSUES ====================
      {
        name: 'detect_blockers',
        description: 'Detect tasks that appear to be blocked or stalled',
        parameters: {
          type: 'object',
          properties: {
            stalled_days: {
              type: 'number',
              description: 'Days without progress to consider stalled',
              default: 3
            }
          }
        },
        handler: this._detectBlockers.bind(this)
      },
      {
        name: 'get_at_risk_projects',
        description: 'Identify projects at risk of missing deadlines',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getAtRiskProjects.bind(this)
      },
      {
        name: 'analyze_project_health',
        description: 'Comprehensive health analysis of a project',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' }
          },
          required: ['project_id']
        },
        handler: this._analyzeProjectHealth.bind(this)
      },

      // ==================== FOLLOW-UPS ====================
      {
        name: 'get_pending_followups',
        description: 'Get tasks/items that need follow-up',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getPendingFollowups.bind(this)
      },
      {
        name: 'create_followup',
        description: 'Create a follow-up reminder for a task or person',
        parameters: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            target: { type: 'string', description: 'Person or task to follow up on' },
            due_date: { type: 'string' },
            notes: { type: 'string' }
          },
          required: ['subject', 'target']
        },
        handler: this._createFollowup.bind(this)
      },
      {
        name: 'generate_followup_message',
        description: 'Generate a follow-up message for overdue/stalled items',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            tone: { type: 'string', enum: ['friendly', 'formal', 'urgent'], default: 'friendly' }
          },
          required: ['task_id']
        },
        handler: this._generateFollowupMessage.bind(this)
      },

      // ==================== REPORTING ====================
      {
        name: 'generate_daily_standup',
        description: 'Generate a daily standup report for team/project',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'Optional: specific project' },
            team: { type: 'string', description: 'Optional: specific team' }
          }
        },
        handler: this._generateDailyStandup.bind(this)
      },
      {
        name: 'generate_weekly_report',
        description: 'Generate a weekly project status report',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' }
          }
        },
        handler: this._generateWeeklyReport.bind(this)
      },
      {
        name: 'get_completion_trends',
        description: 'Analyze task completion trends over time',
        parameters: {
          type: 'object',
          properties: {
            weeks: { type: 'number', default: 4 }
          }
        },
        handler: this._getCompletionTrends.bind(this)
      }
    ];
  }

  // ==================== AUTHENTICATION ====================

  async _getAccessToken() {
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    const fetch = (await import('node-fetch')).default;

    const tokenUrl = `https://login.microsoftonline.com/${this.graphConfig.tenantId}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      client_id: this.graphConfig.clientId,
      client_secret: this.graphConfig.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${await response.text()}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = new Date(Date.now() + (data.expires_in - 300) * 1000);

    return this.accessToken;
  }

  async _graphRequest(endpoint, options = {}) {
    const fetch = (await import('node-fetch')).default;
    const token = await this._getAccessToken();

    const url = endpoint.startsWith('http')
      ? endpoint
      : `https://graph.microsoft.com/v1.0${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!response.ok) {
      throw new Error(`Graph API error: ${response.status}`);
    }

    return response.json();
  }

  // ==================== PROJECT OPERATIONS ====================

  async _getAllProjects(params = {}) {
    const { source = 'all', status = 'active' } = params;
    const projects = [];

    // Get from Odoo
    if ((source === 'all' || source === 'odoo') && this.odooClient) {
      try {
        const domain = status === 'active'
          ? [['active', '=', true]]
          : [];

        const odooProjects = await this.odooClient.searchRead('project.project', domain, [
          'name', 'user_id', 'partner_id', 'date_start', 'date',
          'task_count', 'task_ids', 'description', 'active'
        ]);

        for (const p of odooProjects) {
          projects.push({
            id: `odoo_${p.id}`,
            source: 'odoo',
            name: p.name,
            manager: p.user_id?.[1],
            client: p.partner_id?.[1],
            startDate: p.date_start,
            endDate: p.date,
            taskCount: p.task_count,
            active: p.active
          });
        }
      } catch (error) {
        console.error('Error fetching Odoo projects:', error.message);
      }
    }

    // Get from Planner
    if ((source === 'all' || source === 'planner')) {
      try {
        const plans = await this._graphRequest('/planner/plans');

        for (const plan of plans.value || []) {
          projects.push({
            id: `planner_${plan.id}`,
            source: 'planner',
            name: plan.title,
            createdAt: plan.createdDateTime,
            owner: plan.owner
          });
        }
      } catch (error) {
        console.error('Error fetching Planner plans:', error.message);
      }
    }

    return {
      projects,
      count: projects.length,
      source
    };
  }

  async _getProjectStatus(params) {
    const { project_id, source = 'odoo' } = params;

    if (source === 'odoo' && this.odooClient) {
      const id = project_id.replace('odoo_', '');

      const project = await this.odooClient.read('project.project', [parseInt(id)], [
        'name', 'user_id', 'task_count', 'date_start', 'date'
      ]);

      const tasks = await this.odooClient.searchRead('project.task', [
        ['project_id', '=', parseInt(id)]
      ], [
        'name', 'user_ids', 'stage_id', 'date_deadline', 'priority', 'kanban_state'
      ]);

      const completed = tasks.filter(t => t.kanban_state === 'done').length;
      const overdue = tasks.filter(t =>
        t.date_deadline && new Date(t.date_deadline) < new Date() && t.kanban_state !== 'done'
      ).length;

      return {
        project: project[0],
        taskSummary: {
          total: tasks.length,
          completed,
          overdue,
          inProgress: tasks.length - completed - overdue
        },
        tasks: tasks.slice(0, 20),
        completionRate: tasks.length > 0 ? (completed / tasks.length * 100).toFixed(1) : 0
      };
    }

    return { error: 'Project not found or source not supported' };
  }

  // ==================== TASK OPERATIONS ====================

  async _getAllTasks(params = {}) {
    const { assignee, status = 'open', priority = 'all', project_id } = params;
    const tasks = [];

    if (this.odooClient) {
      try {
        const domain = [];

        if (project_id) {
          domain.push(['project_id', '=', parseInt(project_id.replace('odoo_', ''))]);
        }

        if (status === 'open') {
          domain.push(['kanban_state', '!=', 'done']);
        } else if (status === 'completed') {
          domain.push(['kanban_state', '=', 'done']);
        } else if (status === 'overdue') {
          domain.push(['date_deadline', '<', new Date().toISOString().split('T')[0]]);
          domain.push(['kanban_state', '!=', 'done']);
        }

        const odooTasks = await this.odooClient.searchRead('project.task', domain, [
          'name', 'project_id', 'user_ids', 'stage_id', 'date_deadline',
          'priority', 'kanban_state', 'description', 'create_date', 'write_date'
        ], { limit: 200 });

        for (const t of odooTasks) {
          const task = {
            id: `odoo_${t.id}`,
            source: 'odoo',
            title: t.name,
            project: t.project_id?.[1],
            projectId: t.project_id?.[0],
            assignees: t.user_ids?.map((u) => typeof u === 'object' ? u[1] : u) || [],
            stage: t.stage_id?.[1],
            deadline: t.date_deadline,
            priority: t.priority === '1' ? 'high' : 'normal',
            status: t.kanban_state === 'done' ? 'completed' : 'in_progress',
            isOverdue: t.date_deadline && new Date(t.date_deadline) < new Date() && t.kanban_state !== 'done',
            createdAt: t.create_date,
            updatedAt: t.write_date
          };

          // Filter by assignee if specified
          if (assignee) {
            if (!task.assignees.some(a => a.toLowerCase().includes(assignee.toLowerCase()))) {
              continue;
            }
          }

          tasks.push(task);
        }
      } catch (error) {
        console.error('Error fetching Odoo tasks:', error.message);
      }
    }

    // Sort by deadline
    tasks.sort((a, b) => {
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return new Date(a.deadline) - new Date(b.deadline);
    });

    return {
      tasks,
      count: tasks.length,
      filters: { assignee, status, priority, project_id }
    };
  }

  async _getOverdueTasks(params = {}) {
    const { days_overdue = 0 } = params;

    const allTasks = await this._getAllTasks({ status: 'overdue' });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days_overdue);

    const overdueTasks = allTasks.tasks.filter(t => {
      if (!t.deadline) return false;
      return new Date(t.deadline) < cutoffDate;
    });

    return {
      overdueTasks,
      count: overdueTasks.length,
      criticalCount: overdueTasks.filter(t => t.priority === 'high').length
    };
  }

  async _getUpcomingDeadlines(params = {}) {
    const { days_ahead = 7 } = params;

    const allTasks = await this._getAllTasks({ status: 'open' });

    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days_ahead);

    const upcoming = allTasks.tasks.filter(t => {
      if (!t.deadline) return false;
      const deadline = new Date(t.deadline);
      return deadline >= now && deadline <= futureDate;
    });

    return {
      upcomingTasks: upcoming,
      count: upcoming.length,
      byDay: this._groupByDeadline(upcoming)
    };
  }

  _groupByDeadline(tasks) {
    const byDay = {};
    for (const task of tasks) {
      const day = task.deadline?.split('T')[0];
      if (day) {
        byDay[day] = byDay[day] || [];
        byDay[day].push(task);
      }
    }
    return byDay;
  }

  async _createTask(params) {
    const { title, description, assignee, deadline, priority, project_id, source = 'odoo' } = params;

    // This should go through approval workflow
    const pendingTask = {
      id: `pending_${Date.now()}`,
      type: 'create_task',
      params: { title, description, assignee, deadline, priority, project_id, source },
      status: 'pending_approval',
      createdAt: new Date().toISOString()
    };

    return {
      status: 'pending_approval',
      taskId: pendingTask.id,
      message: 'Task creation requires approval'
    };
  }

  async _updateTaskStatus(params) {
    const { task_id, status, notes: _notes, source = 'odoo' } = params;

    if (source === 'odoo' && this.odooClient) {
      const id = parseInt(task_id.replace('odoo_', ''));

      const stateMap = {
        'not_started': 'normal',
        'in_progress': 'normal',
        'on_hold': 'blocked',
        'completed': 'done'
      };

      await this.odooClient.write('project.task', [id], {
        kanban_state: stateMap[status] || 'normal'
      });

      return {
        success: true,
        taskId: task_id,
        newStatus: status
      };
    }

    return { error: 'Source not supported' };
  }

  // ==================== TEAM ANALYSIS ====================

  async _getTeamWorkload(params = {}) {
    const { team } = params;

    const allTasks = await this._getAllTasks({ status: 'open' });

    const workload = {};

    for (const task of allTasks.tasks) {
      for (const assignee of task.assignees) {
        if (team && !assignee.toLowerCase().includes(team.toLowerCase())) continue;

        workload[assignee] = workload[assignee] || {
          name: assignee,
          totalTasks: 0,
          overdueTasks: 0,
          highPriorityTasks: 0,
          tasks: []
        };

        workload[assignee].totalTasks++;
        if (task.isOverdue) workload[assignee].overdueTasks++;
        if (task.priority === 'high') workload[assignee].highPriorityTasks++;
        workload[assignee].tasks.push({
          id: task.id,
          title: task.title,
          deadline: task.deadline,
          priority: task.priority
        });
      }
    }

    const members = Object.values(workload);
    const overloaded = members.filter(m => m.totalTasks > this.settings.workloadWarningThreshold);

    return {
      teamWorkload: members,
      totalMembers: members.length,
      overloadedMembers: overloaded,
      averageTasksPerPerson: members.length > 0
        ? (members.reduce((sum, m) => sum + m.totalTasks, 0) / members.length).toFixed(1)
        : 0
    };
  }

  async _getEmployeeTasks(params) {
    const { employee, include_completed = false } = params;

    const status = include_completed ? 'all' : 'open';
    const allTasks = await this._getAllTasks({ assignee: employee, status });

    return {
      employee,
      tasks: allTasks.tasks,
      count: allTasks.count,
      overdueCount: allTasks.tasks.filter(t => t.isOverdue).length
    };
  }

  async _getPerformanceMetrics(params = {}) {
    const { period_days = 30, employee } = params;

    // Get completed tasks in period
    const allTasks = await this._getAllTasks({ status: 'all' });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period_days);

    const metrics = {};

    for (const task of allTasks.tasks) {
      if (task.status !== 'completed') continue;
      if (new Date(task.updatedAt) < cutoffDate) continue;

      for (const assignee of task.assignees) {
        if (employee && !assignee.toLowerCase().includes(employee.toLowerCase())) continue;

        metrics[assignee] = metrics[assignee] || {
          name: assignee,
          completed: 0,
          onTime: 0,
          late: 0
        };

        metrics[assignee].completed++;

        if (task.deadline) {
          if (new Date(task.updatedAt) <= new Date(task.deadline)) {
            metrics[assignee].onTime++;
          } else {
            metrics[assignee].late++;
          }
        }
      }
    }

    const members = Object.values(metrics).map(m => ({
      ...m,
      onTimeRate: m.completed > 0 ? ((m.onTime / m.completed) * 100).toFixed(1) : 0
    }));

    return {
      period: `${period_days} days`,
      metrics: members,
      totalCompleted: members.reduce((sum, m) => sum + m.completed, 0)
    };
  }

  // ==================== BLOCKERS & ISSUES ====================

  async _detectBlockers(params = {}) {
    const { stalled_days = 3 } = params;

    const allTasks = await this._getAllTasks({ status: 'open' });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - stalled_days);

    const blockers = allTasks.tasks.filter(t => {
      if (!t.updatedAt) return false;
      return new Date(t.updatedAt) < cutoffDate;
    });

    return {
      blockedTasks: blockers,
      count: blockers.length,
      stalledDays: stalled_days
    };
  }

  async _getAtRiskProjects(_params = {}) {
    const projects = await this._getAllProjects({ status: 'active' });
    const atRisk = [];

    for (const project of projects.projects) {
      if (project.source === 'odoo') {
        const status = await this._getProjectStatus({
          project_id: project.id,
          source: 'odoo'
        });

        const overdueRate = status.taskSummary.total > 0
          ? status.taskSummary.overdue / status.taskSummary.total
          : 0;

        if (overdueRate > 0.2 || status.taskSummary.overdue > 5) {
          atRisk.push({
            ...project,
            overdueRate: (overdueRate * 100).toFixed(1) + '%',
            overdueTasks: status.taskSummary.overdue,
            reason: overdueRate > 0.5 ? 'Critical: >50% tasks overdue' : 'Warning: Significant delays'
          });
        }
      }
    }

    return {
      atRiskProjects: atRisk,
      count: atRisk.length
    };
  }

  async _analyzeProjectHealth(params) {
    const { project_id } = params;

    const status = await this._getProjectStatus({ project_id });

    if (status.error) return status;

    const analysis = {
      projectId: project_id,
      projectName: status.project?.name,
      healthScore: 100,
      issues: [],
      recommendations: []
    };

    // Check overdue tasks
    if (status.taskSummary.overdue > 0) {
      analysis.healthScore -= status.taskSummary.overdue * 5;
      analysis.issues.push(`${status.taskSummary.overdue} overdue tasks`);
      analysis.recommendations.push('Review and reassign overdue tasks');
    }

    // Check completion rate
    const completionRate = parseFloat(status.completionRate);
    if (completionRate < 30) {
      analysis.healthScore -= 20;
      analysis.issues.push('Low completion rate');
      analysis.recommendations.push('Identify and remove blockers');
    }

    analysis.healthScore = Math.max(0, analysis.healthScore);
    analysis.status = analysis.healthScore >= 70 ? 'healthy' :
                      analysis.healthScore >= 40 ? 'at_risk' : 'critical';

    return analysis;
  }

  // ==================== FOLLOW-UPS ====================

  async _getPendingFollowups(_params = {}) {
    const overdue = await this._getOverdueTasks({});
    const blockers = await this._detectBlockers({});

    const followups = [
      ...overdue.overdueTasks.map(t => ({
        type: 'overdue_task',
        taskId: t.id,
        title: t.title,
        assignees: t.assignees,
        daysOverdue: Math.floor((new Date() - new Date(t.deadline)) / (1000 * 60 * 60 * 24)),
        priority: 'high'
      })),
      ...blockers.blockedTasks.map(t => ({
        type: 'stalled_task',
        taskId: t.id,
        title: t.title,
        assignees: t.assignees,
        daysSinceUpdate: Math.floor((new Date() - new Date(t.updatedAt)) / (1000 * 60 * 60 * 24)),
        priority: 'medium'
      }))
    ];

    return {
      followups,
      count: followups.length
    };
  }

  async _createFollowup(params) {
    const { subject, target, due_date, notes } = params;

    const followup = {
      id: `followup_${Date.now()}`,
      subject,
      target,
      dueDate: due_date || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      notes,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    this.followUps.push(followup);

    return {
      success: true,
      followup
    };
  }

  async _generateFollowupMessage(params) {
    const { task_id, tone = 'friendly' } = params;

    // Get task details
    const allTasks = await this._getAllTasks({ status: 'all' });
    const task = allTasks.tasks.find(t => t.id === task_id);

    if (!task) return { error: 'Task not found' };

    const prompt = `Generate a ${tone} follow-up message for this task:

Task: ${task.title}
Assignee: ${task.assignees.join(', ')}
Deadline: ${task.deadline || 'None set'}
Status: ${task.status}
Days overdue: ${task.isOverdue ? Math.floor((new Date() - new Date(task.deadline)) / (1000 * 60 * 60 * 24)) : 'N/A'}

Generate a brief, professional message asking for a status update.`;

    const message = await this._generateWithLLM(prompt);

    return {
      taskId: task_id,
      task: task.title,
      assignees: task.assignees,
      message,
      tone
    };
  }

  async _generateWithLLM(prompt) {
    try {
      const response = await this.llmClient.chat.completions.create({
        model: this.config.model || 'gpt-4',
        messages: [{ role: 'user', content: prompt }]
      });

      return response.choices[0].message.content;
    } catch (error) {
      return `Error generating message: ${error.message}`;
    }
  }

  // ==================== REPORTING ====================

  async _generateDailyStandup(params = {}) {
    const { project_id: _project_id, team } = params;

    const [overdue, upcoming, workload] = await Promise.all([
      this._getOverdueTasks({}),
      this._getUpcomingDeadlines({ days_ahead: 3 }),
      this._getTeamWorkload({ team })
    ]);

    const report = {
      date: new Date().toISOString().split('T')[0],
      summary: {
        overdueTasks: overdue.count,
        upcomingDeadlines: upcoming.count,
        teamMembers: workload.totalMembers,
        overloadedMembers: workload.overloadedMembers.length
      },
      attention: [
        ...overdue.overdueTasks.slice(0, 5).map(t => `OVERDUE: ${t.title} (${t.assignees.join(', ')})`),
        ...upcoming.upcomingTasks.slice(0, 5).map(t => `DUE SOON: ${t.title} - ${t.deadline}`)
      ],
      workloadWarnings: workload.overloadedMembers.map(m =>
        `${m.name} has ${m.totalTasks} tasks assigned`
      )
    };

    return report;
  }

  async _generateWeeklyReport(params = {}) {
    const { project_id: _project_id } = params;

    const [performance, atRisk, blockers] = await Promise.all([
      this._getPerformanceMetrics({ period_days: 7 }),
      this._getAtRiskProjects({}),
      this._detectBlockers({})
    ]);

    return {
      weekEnding: new Date().toISOString().split('T')[0],
      performance: {
        tasksCompleted: performance.totalCompleted,
        topPerformers: performance.metrics
          .sort((a, b) => b.completed - a.completed)
          .slice(0, 3)
      },
      concerns: {
        atRiskProjects: atRisk.count,
        blockedTasks: blockers.count
      },
      atRiskProjects: atRisk.atRiskProjects,
      blockedTasks: blockers.blockedTasks.slice(0, 10)
    };
  }

  async _getCompletionTrends(params = {}) {
    const { weeks = 4 } = params;

    // This would ideally use historical data
    // For now, return current metrics
    const metrics = await this._getPerformanceMetrics({ period_days: weeks * 7 });

    return {
      period: `${weeks} weeks`,
      totalCompleted: metrics.totalCompleted,
      averagePerWeek: (metrics.totalCompleted / weeks).toFixed(1),
      byMember: metrics.metrics
    };
  }

  // ==================== LIFECYCLE ====================

  async init() {
    await super.init();
    console.log('Project Agent initialized');
  }

  setOdooClient(client) {
    this.odooClient = client;
  }
}

module.exports = {
  ProjectAgent,
  TaskStatus,
  Priority
};
