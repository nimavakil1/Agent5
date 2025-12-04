/**
 * ManagerAgent - The CEO Agent that oversees all operations
 *
 * Responsibilities:
 * - Orchestrate all other agents
 * - Make strategic decisions
 * - Aggregate data across departments
 * - Handle escalations
 * - Provide company-wide insights
 * - Manage approval workflows
 */

const { LLMAgent } = require('../LLMAgent');
const { getAgentRegistry } = require('../AgentRegistry');

class ManagerAgent extends LLMAgent {
  constructor(config = {}) {
    super({
      name: 'ManagerAgent',
      role: 'manager',
      taskType: 'manager', // Routes to Claude Opus 4.5 with extended thinking
      description: 'CEO-level AI agent that oversees all company operations and other AI agents',
      capabilities: [
        'strategic_planning',
        'agent_orchestration',
        'cross_department_analysis',
        'approval_handling',
        'escalation_handling',
        'resource_allocation',
        'performance_monitoring',
        'decision_support',
      ],
      systemPrompt: `You are the Manager Agent (CEO-level AI) for ACROPAQ, responsible for overseeing all company operations.

## Your Identity
You are the virtual CEO of ACROPAQ, a Belgian e-commerce company. You think strategically, make data-driven decisions, and coordinate the AI team to achieve business goals.

## Your AI Team
You lead these specialized agents:
- FinanceAgent: Odoo ERP, invoices, payments, financial reports, product costs
- SalesAgent: Amazon, Bol.com, marketplace operations, orders
- OpsAgent: Inventory, shipping, suppliers, logistics
- CommunicationAgent: Outlook, Teams, SharePoint, email

## Your Responsibilities

1. **Strategic Leadership**
   - Make strategic decisions based on data from all departments
   - Identify trends, opportunities, and risks
   - Set priorities aligned with business goals
   - Think long-term while handling immediate needs

2. **Team Coordination**
   - Delegate tasks to the right specialist agents
   - Coordinate multi-department initiatives
   - Ensure agents work together effectively
   - Monitor agent performance

3. **Approval & Escalation**
   - Review requests from other agents
   - Approve/reject sensitive operations (large payments, pricing changes)
   - Escalate to human when stakes are high or uncertain
   - Document decisions for audit trail

4. **Business Intelligence**
   - Provide cross-departmental insights
   - Analyze seasonal patterns
   - Monitor KPIs and metrics
   - Generate recommendations

## Decision Framework
- Consider ROI and business impact
- Verify critical data before deciding
- Escalate if: amount > €5000, irreversible action, uncertain outcome
- Document reasoning for all significant decisions
- When in doubt, ask for more data or escalate to human`,

      // Uses Claude Opus 4.5 with extended thinking (set via taskType: 'manager')
      llmProvider: 'anthropic',
      llmModel: 'opus',
      useExtendedThinking: true,
      thinkingBudget: 15000, // More thinking for strategic decisions
      temperature: 0.5,

      ...config,
    });

    // Approval queue
    this.pendingApprovals = new Map();
    this.approvalHistory = [];

    // Agent performance tracking
    this.agentPerformance = new Map();

    // Decision log
    this.decisionLog = [];
  }

  /**
   * Initialize the Manager Agent
   */
  async init(platform) {
    await super.init(platform);

    // Setup escalation handler
    const registry = getAgentRegistry();
    registry.on('agentEscalation', (data) => this._handleEscalation(data));
    registry.on('approvalRequired', (data) => this._handleApprovalRequest(data));

    this.logger.info('Manager Agent initialized');
  }

  /**
   * Load manager-specific tools
   */
  async _loadTools() {
    // Agent management tools
    this.registerTool('list_agents', this._listAgents.bind(this), {
      description: 'List all registered agents and their current status',
      inputSchema: { type: 'object', properties: {} },
    });

    this.registerTool('delegate_task', this._delegateTask.bind(this), {
      description: 'Delegate a task to a specific agent by name or role',
      inputSchema: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: 'Name of the agent (e.g., FinanceAgent)' },
          agent_role: { type: 'string', description: 'Role of the agent (e.g., finance)' },
          task: { type: 'object', description: 'Task to delegate' },
        },
        required: ['task'],
      },
    });

    this.registerTool('broadcast_query', this._broadcastQuery.bind(this), {
      description: 'Send a query to all agents and aggregate responses',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Query to send to all agents' },
          roles: { type: 'array', items: { type: 'string' }, description: 'Optional: specific roles to query' },
        },
        required: ['query'],
      },
    });

    // Strategic tools
    this.registerTool('get_company_overview', this._getCompanyOverview.bind(this), {
      description: 'Get a comprehensive overview of company operations across all departments',
      inputSchema: {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' }, description: 'Departments to include' },
        },
      },
    });

    this.registerTool('analyze_performance', this._analyzePerformance.bind(this), {
      description: 'Analyze performance metrics across agents or departments',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['agents', 'departments', 'overall'] },
          period: { type: 'string', enum: ['day', 'week', 'month', 'quarter'] },
        },
      },
    });

    // Approval tools
    this.registerTool('list_pending_approvals', this._listPendingApprovals.bind(this), {
      description: 'List all pending approval requests',
      inputSchema: { type: 'object', properties: {} },
    });

    this.registerTool('approve_request', this._approveRequest.bind(this), {
      description: 'Approve a pending request',
      inputSchema: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', description: 'ID of the approval request' },
          reason: { type: 'string', description: 'Reason for approval' },
        },
        required: ['approval_id'],
      },
    });

    this.registerTool('reject_request', this._rejectRequest.bind(this), {
      description: 'Reject a pending request',
      inputSchema: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', description: 'ID of the approval request' },
          reason: { type: 'string', description: 'Reason for rejection' },
        },
        required: ['approval_id', 'reason'],
      },
    });

    // Decision support
    this.registerTool('get_recommendations', this._getRecommendations.bind(this), {
      description: 'Get AI-powered recommendations based on current data',
      inputSchema: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'Area to get recommendations for (e.g., purchasing, staffing)' },
          context: { type: 'object', description: 'Additional context' },
        },
      },
    });

    this.registerTool('log_decision', this._logDecision.bind(this), {
      description: 'Log a strategic decision for audit purposes',
      inputSchema: {
        type: 'object',
        properties: {
          decision: { type: 'string', description: 'Description of the decision' },
          rationale: { type: 'string', description: 'Reasoning behind the decision' },
          impact: { type: 'string', description: 'Expected impact' },
        },
        required: ['decision', 'rationale'],
      },
    });

    this.logger.debug({ toolCount: this.tools.size }, 'Manager tools loaded');
  }

  // ============ Tool Implementations ============

  async _listAgents(_params) {
    const registry = getAgentRegistry();
    const agents = registry.list();

    return {
      total: agents.length,
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        state: a.state,
        tasks_completed: a.status.metrics.tasksCompleted,
        tasks_failed: a.status.metrics.tasksFailed,
        last_active: a.status.metrics.lastActiveAt,
      })),
      by_role: registry.getHealth().byRole,
    };
  }

  async _delegateTask(params) {
    const registry = getAgentRegistry();
    let agent;

    if (params.agent_name) {
      agent = registry.getByName(params.agent_name);
    } else if (params.agent_role) {
      const agents = registry.getByRole(params.agent_role);
      agent = agents.find(a => a.state === 'idle') || agents[0];
    }

    if (!agent) {
      throw new Error(`No agent found for: ${params.agent_name || params.agent_role}`);
    }

    const result = await agent.execute(params.task);

    // Track performance
    this._trackAgentPerformance(agent.id, result);

    return {
      delegated_to: agent.name,
      agent_id: agent.id,
      result,
    };
  }

  async _broadcastQuery(params) {
    const registry = getAgentRegistry();
    const results = [];

    let agents = registry.list();
    if (params.roles && params.roles.length > 0) {
      agents = agents.filter(a => params.roles.includes(a.role));
    }

    for (const agentInfo of agents) {
      if (agentInfo.name === this.name) continue; // Skip self

      try {
        const agent = registry.get(agentInfo.id);
        const result = await agent.execute({
          type: 'query',
          query: params.query,
        });
        results.push({
          agent: agentInfo.name,
          role: agentInfo.role,
          success: result.success,
          response: result.result,
        });
      } catch (error) {
        results.push({
          agent: agentInfo.name,
          role: agentInfo.role,
          success: false,
          error: error.message,
        });
      }
    }

    return {
      query: params.query,
      responses: results,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    };
  }

  async _getCompanyOverview(params) {
    const registry = getAgentRegistry();
    const overview = {
      timestamp: new Date().toISOString(),
      departments: {},
    };

    const includeDepts = params.include || ['finance', 'sales', 'ops', 'hr'];

    // Query each department's agent
    for (const dept of includeDepts) {
      const agents = registry.getByRole(dept);
      if (agents.length === 0) {
        overview.departments[dept] = { status: 'no_agent', data: null };
        continue;
      }

      try {
        const agent = agents[0];
        const result = await agent.execute({
          type: 'status_report',
          description: 'Provide a brief status summary for the manager',
        });

        overview.departments[dept] = {
          status: 'active',
          agent: agent.name,
          summary: result.result,
        };
      } catch (error) {
        overview.departments[dept] = {
          status: 'error',
          error: error.message,
        };
      }
    }

    // Add agent health summary
    overview.agent_health = registry.getHealth();

    // Add pending items
    overview.pending_approvals = this.pendingApprovals.size;

    return overview;
  }

  async _analyzePerformance(params) {
    const scope = params.scope || 'overall';
    const period = params.period || 'week';

    const registry = getAgentRegistry();
    const agents = registry.list();

    const performance = {
      period,
      scope,
      analyzed_at: new Date().toISOString(),
    };

    if (scope === 'agents' || scope === 'overall') {
      performance.agents = agents.map(a => ({
        name: a.name,
        role: a.role,
        tasks_completed: a.status.metrics.tasksCompleted,
        tasks_failed: a.status.metrics.tasksFailed,
        success_rate: a.status.metrics.tasksCompleted > 0
          ? (a.status.metrics.tasksCompleted / (a.status.metrics.tasksCompleted + a.status.metrics.tasksFailed) * 100).toFixed(1) + '%'
          : 'N/A',
        avg_execution_time: a.status.metrics.tasksCompleted > 0
          ? Math.round(a.status.metrics.totalExecutionTimeMs / a.status.metrics.tasksCompleted) + 'ms'
          : 'N/A',
      }));
    }

    if (scope === 'overall') {
      const totals = agents.reduce((acc, a) => ({
        completed: acc.completed + a.status.metrics.tasksCompleted,
        failed: acc.failed + a.status.metrics.tasksFailed,
      }), { completed: 0, failed: 0 });

      performance.overall = {
        total_tasks: totals.completed + totals.failed,
        success_rate: totals.completed > 0
          ? (totals.completed / (totals.completed + totals.failed) * 100).toFixed(1) + '%'
          : 'N/A',
        active_agents: agents.filter(a => a.state === 'executing').length,
        idle_agents: agents.filter(a => a.state === 'idle').length,
      };
    }

    return performance;
  }

  async _listPendingApprovals(_params) {
    const approvals = Array.from(this.pendingApprovals.values());

    return {
      count: approvals.length,
      approvals: approvals.map(a => ({
        id: a.id,
        type: a.task.type,
        from_agent: a.agentName,
        requested_at: a.requestedAt,
        description: a.task.description,
        amount: a.task.amount,
      })),
    };
  }

  async _approveRequest(params) {
    const approval = this.pendingApprovals.get(params.approval_id);
    if (!approval) {
      throw new Error(`Approval not found: ${params.approval_id}`);
    }

    // Send approval to the requesting agent
    const registry = getAgentRegistry();
    const agent = registry.get(approval.agentId);
    if (agent) {
      agent.emit('approvalResponse', {
        approved: true,
        reason: params.reason || 'Approved by Manager Agent',
      });
    }

    // Move to history
    this.approvalHistory.push({
      ...approval,
      approved: true,
      approvedAt: new Date(),
      approvedBy: this.name,
      reason: params.reason,
    });

    this.pendingApprovals.delete(params.approval_id);

    return {
      status: 'approved',
      approval_id: params.approval_id,
      message: `Request approved: ${params.reason || 'No reason provided'}`,
    };
  }

  async _rejectRequest(params) {
    const approval = this.pendingApprovals.get(params.approval_id);
    if (!approval) {
      throw new Error(`Approval not found: ${params.approval_id}`);
    }

    // Send rejection to the requesting agent
    const registry = getAgentRegistry();
    const agent = registry.get(approval.agentId);
    if (agent) {
      agent.emit('approvalResponse', {
        approved: false,
        reason: params.reason,
      });
    }

    // Move to history
    this.approvalHistory.push({
      ...approval,
      approved: false,
      rejectedAt: new Date(),
      rejectedBy: this.name,
      reason: params.reason,
    });

    this.pendingApprovals.delete(params.approval_id);

    return {
      status: 'rejected',
      approval_id: params.approval_id,
      message: `Request rejected: ${params.reason}`,
    };
  }

  async _getRecommendations(params) {
    const area = params.area || 'general';
    const context = params.context || {};

    // Gather relevant data from agents
    const registry = getAgentRegistry();
    const dataPoints = [];

    // Get financial data if relevant
    const financeAgent = registry.getByName('FinanceAgent');
    if (financeAgent && ['purchasing', 'financial', 'general'].includes(area)) {
      try {
        const result = await financeAgent.execute({
          type: 'get_financial_summary',
          description: 'Get current financial summary for recommendations',
        });
        if (result.success) {
          dataPoints.push({ source: 'finance', data: result.result });
        }
      } catch (e) {
        // Continue without financial data
      }
    }

    // Generate recommendations using LLM
    const prompt = `Based on the following data, provide strategic recommendations for: ${area}

Data:
${JSON.stringify(dataPoints, null, 2)}

Additional Context:
${JSON.stringify(context, null, 2)}

Provide 3-5 actionable recommendations with expected impact.`;

    const recommendations = await this.generateStructured(prompt, {
      type: 'object',
      properties: {
        area: { type: 'string' },
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              expected_impact: { type: 'string' },
              action_items: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    });

    return recommendations;
  }

  async _logDecision(params) {
    const entry = {
      id: require('uuid').v4(),
      timestamp: new Date().toISOString(),
      decision: params.decision,
      rationale: params.rationale,
      impact: params.impact || 'Not specified',
      made_by: this.name,
    };

    this.decisionLog.push(entry);

    // Keep only last 1000 decisions in memory
    if (this.decisionLog.length > 1000) {
      this.decisionLog.shift();
    }

    return {
      logged: true,
      decision_id: entry.id,
      message: 'Decision logged for audit purposes',
    };
  }

  // ============ Event Handlers ============

  async _handleEscalation(data) {
    this.logger.info({ from: data.agentId, reason: data.reason }, 'Received escalation');

    // Add to decision queue
    const escalationId = require('uuid').v4();

    this.pendingApprovals.set(escalationId, {
      id: escalationId,
      type: 'escalation',
      agentId: data.agentId,
      agentName: data.agentName,
      task: data.task,
      reason: data.reason,
      requestedAt: new Date(),
    });

    // For now, emit event for human review
    this.emit('escalationReceived', {
      id: escalationId,
      ...data,
    });
  }

  async _handleApprovalRequest(data) {
    this.logger.info({ from: data.agentId, task: data.task.type }, 'Received approval request');

    const approvalId = require('uuid').v4();

    this.pendingApprovals.set(approvalId, {
      id: approvalId,
      type: 'approval',
      agentId: data.agentId,
      task: data.task,
      requestedAt: new Date(),
    });

    // Auto-approve low-risk items, escalate high-risk
    if (this._canAutoApprove(data.task)) {
      await this._approveRequest({ approval_id: approvalId, reason: 'Auto-approved (low risk)' });
    } else {
      this.emit('approvalNeeded', {
        id: approvalId,
        ...data,
      });
    }
  }

  _canAutoApprove(task) {
    // Auto-approve read-only operations
    if (['query', 'report', 'summary', 'status'].includes(task.type)) {
      return true;
    }

    // Auto-approve small amounts
    if (task.amount && task.amount < 1000) {
      return true;
    }

    return false;
  }

  _trackAgentPerformance(agentId, result) {
    if (!this.agentPerformance.has(agentId)) {
      this.agentPerformance.set(agentId, {
        tasks: 0,
        successes: 0,
        failures: 0,
        totalTime: 0,
      });
    }

    const perf = this.agentPerformance.get(agentId);
    perf.tasks++;
    if (result.success) {
      perf.successes++;
    } else {
      perf.failures++;
    }
    perf.totalTime += result.durationMs || 0;
  }
}

module.exports = { ManagerAgent };
