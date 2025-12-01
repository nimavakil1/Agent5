/**
 * AgentModule - Platform module for AI Agent management
 *
 * Integrates the agent swarm with the Agent5 platform.
 */

const { createAgentRegistry, getAgentRegistry } = require('./AgentRegistry');
const { MCPRegistry } = require('./MCPClient');
const { FinanceAgent } = require('./specialized/FinanceAgent');
const { ManagerAgent } = require('./specialized/ManagerAgent');

class AgentModule {
  constructor(config = {}) {
    this.name = 'agents';
    this.version = '1.0.0';
    this.config = config;

    this.registry = null;
    this.mcpRegistry = null;
    this.platform = null;
    this.logger = null;

    // Default agents to initialize
    this.defaultAgents = config.defaultAgents || ['manager', 'finance'];
  }

  /**
   * Initialize the module
   */
  async init(platform) {
    this.platform = platform;
    this.logger = platform.logger.child({ module: 'AgentModule' });

    // Create registries
    this.registry = createAgentRegistry();
    this.mcpRegistry = new MCPRegistry();
    this.mcpRegistry.logger = this.logger;

    // Initialize registry with platform
    await this.registry.init(platform);

    // Register as a platform service
    platform.registerService('agents', this.registry, {
      version: this.version,
      healthCheck: () => this._healthCheck(),
    });

    platform.registerService('mcp', this.mcpRegistry, {
      version: this.version,
    });

    this.logger.info('Agent module initialized');
  }

  /**
   * Start the module - create default agents
   */
  async start(platform) {
    this.logger.info('Starting agent module');

    // Create and register default agents
    for (const agentType of this.defaultAgents) {
      try {
        await this._createAgent(agentType);
      } catch (error) {
        this.logger.error({ agent: agentType, error: error.message }, 'Failed to create agent');
      }
    }

    // Setup event handlers
    this._setupEventHandlers();

    this.logger.info({ agentCount: this.registry.list().length }, 'Agent module started');
  }

  /**
   * Stop the module
   */
  async stop(platform) {
    this.logger.info('Stopping agent module');

    // Shutdown all agents
    await this.registry.shutdown();

    // Disconnect MCP servers
    await this.mcpRegistry.disconnectAll();

    this.logger.info('Agent module stopped');
  }

  /**
   * Create an agent by type
   */
  async _createAgent(type) {
    let agent;

    switch (type) {
      case 'manager':
        agent = new ManagerAgent();
        break;
      case 'finance':
        agent = new FinanceAgent();
        break;
      default:
        throw new Error(`Unknown agent type: ${type}`);
    }

    await this.registry.register(agent);
    this.logger.info({ agent: agent.name, type }, 'Agent created');

    return agent;
  }

  /**
   * Setup event handlers
   */
  _setupEventHandlers() {
    // Handle escalations that need human attention
    this.registry.on('agentEscalation', (data) => {
      this.logger.warn({ from: data.agentId, reason: data.reason }, 'Agent escalation received');
      this.platform.emit('agent:escalation', data);
    });

    // Handle approval requests
    this.registry.on('approvalRequired', (data) => {
      this.logger.info({ from: data.agentId, task: data.task?.type }, 'Approval required');
      this.platform.emit('agent:approval_required', data);
    });

    // Track task completions
    this.registry.on('agentTaskCompleted', (data) => {
      this.logger.debug({ agent: data.agentId, task: data.task?.type }, 'Task completed');
    });

    // Track task failures
    this.registry.on('agentTaskFailed', (data) => {
      this.logger.error({ agent: data.agentId, error: data.error }, 'Task failed');
    });
  }

  /**
   * Health check
   */
  async _healthCheck() {
    const health = this.registry.getHealth();

    return {
      status: health.totalAgents > 0 ? 'healthy' : 'degraded',
      details: {
        agents: health.totalAgents,
        byState: health.byState,
        messageQueue: health.messageQueueSize,
        mcpServers: this.mcpRegistry.list().length,
      },
    };
  }

  // ============ Public API ============

  /**
   * Get the agent registry
   */
  getRegistry() {
    return this.registry;
  }

  /**
   * Get the MCP registry
   */
  getMCPRegistry() {
    return this.mcpRegistry;
  }

  /**
   * Execute a task using the appropriate agent
   */
  async executeTask(task) {
    // Determine the appropriate agent based on task type
    const role = this._determineRole(task);

    if (role === 'manager' || !role) {
      // Route to manager for orchestration
      const manager = this.registry.getByName('ManagerAgent');
      if (manager) {
        return manager.execute(task);
      }
    }

    // Route to specialized agent
    return this.registry.sendTaskToRole(role, task);
  }

  /**
   * Send a natural language query to the agent system
   */
  async query(question, options = {}) {
    // Use manager to handle and route queries
    const manager = this.registry.getByName('ManagerAgent');

    if (!manager) {
      throw new Error('Manager agent not available');
    }

    return manager.execute({
      type: 'query',
      question,
      ...options,
    });
  }

  /**
   * Get status of all agents
   */
  getStatus() {
    return {
      agents: this.registry.list(),
      health: this.registry.getHealth(),
      mcpServers: this.mcpRegistry.list(),
    };
  }

  /**
   * Determine which role should handle a task
   */
  _determineRole(task) {
    const type = task.type?.toLowerCase() || '';
    const description = task.description?.toLowerCase() || '';
    const combined = `${type} ${description}`;

    // Finance-related
    if (/invoice|payment|financial|revenue|expense|budget|odoo|accounting/i.test(combined)) {
      return 'finance';
    }

    // Sales-related
    if (/sales|order|amazon|bol\.com|marketplace|customer|revenue/i.test(combined)) {
      return 'sales';
    }

    // Operations-related
    if (/inventory|stock|shipping|supplier|warehouse|logistics/i.test(combined)) {
      return 'ops';
    }

    // HR-related
    if (/employee|team|meeting|schedule|hr|hiring|payroll/i.test(combined)) {
      return 'hr';
    }

    // Default to manager
    return 'manager';
  }
}

module.exports = { AgentModule };
