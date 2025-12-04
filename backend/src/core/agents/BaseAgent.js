/**
 * BaseAgent - Foundation for all AI Agents
 *
 * Every agent in the swarm inherits from this class.
 * Agents can:
 * - Execute tasks autonomously
 * - Communicate with other agents
 * - Access MCP tools
 * - Report to the manager agent
 * - Maintain conversation state
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

class BaseAgent extends EventEmitter {
  constructor(config = {}) {
    super();

    this.id = config.id || uuidv4();
    this.name = config.name || 'UnnamedAgent';
    this.role = config.role || 'general';
    this.description = config.description || '';

    // Agent capabilities
    this.capabilities = config.capabilities || [];
    this.tools = new Map();
    this.mcpServers = new Map();

    // State management
    this.state = 'idle'; // idle, thinking, executing, waiting, error
    this.memory = [];
    this.context = {};
    this.maxMemorySize = config.maxMemorySize || 100;

    // Communication
    this.inbox = [];
    this.outbox = [];
    this.parentAgent = null;
    this.childAgents = new Map();

    // LLM Configuration
    this.llmConfig = {
      model: config.model || 'gpt-4o',
      temperature: config.temperature || 0.7,
      maxTokens: config.maxTokens || 4096,
      systemPrompt: config.systemPrompt || this._getDefaultSystemPrompt(),
    };

    // Execution settings
    this.maxIterations = config.maxIterations || 100;
    this.timeoutMs = config.timeoutMs || 60000;

    // Approval settings
    this.requiresApproval = config.requiresApproval || [];
    this.approvalThresholds = config.approvalThresholds || {};

    // Metrics
    this.metrics = {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalExecutionTimeMs: 0,
      lastActiveAt: null,
      createdAt: new Date(),
    };

    // Platform reference (set during registration)
    this.platform = null;
    this.logger = null;
  }

  /**
   * Initialize the agent with platform context
   */
  async init(platform) {
    this.platform = platform;
    this.logger = platform.logger.child({ agent: this.name, agentId: this.id });

    // Load agent-specific tools
    await this._loadTools();

    // Connect to MCP servers
    await this._connectMCPServers();

    this.logger.info({ capabilities: this.capabilities }, 'Agent initialized');
    this.emit('initialized');
  }

  /**
   * Execute a task
   * @param {object} task - Task to execute
   * @returns {object} Task result
   */
  async execute(task) {
    const startTime = Date.now();
    this.state = 'thinking';
    this.metrics.lastActiveAt = new Date();

    const executionId = uuidv4();
    this.logger.info({ executionId, task: task.type }, 'Starting task execution');

    try {
      // Check if task requires approval
      if (await this._requiresApproval(task)) {
        this.state = 'waiting';
        const approval = await this._requestApproval(task);
        if (!approval.approved) {
          return {
            success: false,
            executionId,
            reason: 'Task rejected: ' + (approval.reason || 'No reason provided'),
          };
        }
      }

      this.state = 'executing';

      // Add task to memory
      this._addToMemory({ role: 'user', content: JSON.stringify(task) });

      // Execute the task with iteration limit
      let result = null;
      let iterations = 0;

      while (iterations < this.maxIterations) {
        iterations++;

        // Think about what to do
        const thought = await this._think(task, result);

        if (thought.action === 'complete') {
          result = thought.result;
          break;
        }

        if (thought.action === 'tool') {
          // Execute tool
          result = await this._executeTool(thought.tool, thought.params);
          this._addToMemory({
            role: 'assistant',
            content: `Used tool: ${thought.tool}`,
            toolResult: result
          });
        }

        if (thought.action === 'delegate') {
          // Delegate to another agent
          result = await this._delegate(thought.targetAgent, thought.subtask);
        }

        if (thought.action === 'escalate') {
          // Escalate to manager/human
          result = await this._escalate(thought.reason, task);
          break;
        }
      }

      if (iterations >= this.maxIterations) {
        throw new Error('Max iterations reached without completing task');
      }

      this.metrics.tasksCompleted++;
      this.metrics.totalExecutionTimeMs += Date.now() - startTime;

      this._addToMemory({ role: 'assistant', content: JSON.stringify(result) });

      this.state = 'idle';
      this.emit('taskCompleted', { executionId, task, result });

      return {
        success: true,
        executionId,
        result,
        iterations,
        durationMs: Date.now() - startTime,
      };

    } catch (error) {
      this.metrics.tasksFailed++;
      this.state = 'error';

      this.logger.error({ executionId, error: error.message }, 'Task execution failed');
      this.emit('taskFailed', { executionId, task, error });

      return {
        success: false,
        executionId,
        error: error.message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Process incoming messages from other agents
   */
  async processMessage(message) {
    this.inbox.push({
      ...message,
      receivedAt: new Date(),
    });

    this.emit('messageReceived', message);

    // Handle the message based on type
    switch (message.type) {
      case 'task':
        return this.execute(message.payload);
      case 'query':
        return this._handleQuery(message.payload);
      case 'status':
        return this.getStatus();
      case 'shutdown':
        return this.shutdown();
      default:
        this.logger.warn({ messageType: message.type }, 'Unknown message type');
    }
  }

  /**
   * Send a message to another agent
   */
  async sendMessage(targetAgentId, type, payload) {
    const message = {
      id: uuidv4(),
      from: this.id,
      to: targetAgentId,
      type,
      payload,
      sentAt: new Date(),
    };

    this.outbox.push(message);
    this.emit('messageSent', message);

    // Route through the agent registry
    if (this.platform) {
      const agentService = this.platform.getService('agents');
      return agentService.routeMessage(message);
    }

    return message;
  }

  /**
   * Register a tool that this agent can use
   */
  registerTool(name, handler, schema = {}) {
    this.tools.set(name, {
      handler,
      schema,
      name,
    });
    this.logger.debug({ tool: name }, 'Tool registered');
  }

  /**
   * Connect to an MCP server
   */
  async connectMCP(serverConfig) {
    const { MCPClient } = require('./MCPClient');
    const client = new MCPClient(serverConfig);
    await client.connect();

    this.mcpServers.set(serverConfig.name, client);

    // Register MCP tools with this agent
    const tools = await client.listTools();
    for (const tool of tools) {
      this.registerTool(`mcp:${serverConfig.name}:${tool.name}`,
        (params) => client.callTool(tool.name, params),
        tool.schema
      );
    }

    this.logger.info({ server: serverConfig.name, toolCount: tools.length }, 'MCP server connected');
  }

  /**
   * Get current agent status
   */
  getStatus() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      state: this.state,
      capabilities: this.capabilities,
      metrics: this.metrics,
      toolCount: this.tools.size,
      mcpServerCount: this.mcpServers.size,
      memorySize: this.memory.length,
      inboxSize: this.inbox.length,
    };
  }

  /**
   * Gracefully shutdown the agent
   */
  async shutdown() {
    this.logger.info('Shutting down agent');
    this.state = 'shutdown';

    // Disconnect MCP servers
    for (const [_name, client] of this.mcpServers) {
      await client.disconnect();
    }

    // Clear memory
    this.memory = [];
    this.inbox = [];
    this.outbox = [];

    this.emit('shutdown');
  }

  // ============ Protected Methods ============

  /**
   * Think about what action to take
   * Override in subclasses for specialized behavior
   */
  async _think(_task, _previousResult) {
    // Default implementation - subclasses should override
    throw new Error('_think() must be implemented by subclass');
  }

  /**
   * Execute a registered tool
   */
  async _executeTool(toolName, params) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    this.logger.debug({ tool: toolName, params }, 'Executing tool');

    try {
      const result = await tool.handler(params);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Delegate a subtask to another agent
   */
  async _delegate(targetAgentId, subtask) {
    return this.sendMessage(targetAgentId, 'task', subtask);
  }

  /**
   * Escalate to manager or human
   */
  async _escalate(reason, task) {
    this.logger.warn({ reason }, 'Escalating task');

    if (this.parentAgent) {
      return this.sendMessage(this.parentAgent, 'escalation', {
        reason,
        task,
        agentId: this.id,
        agentName: this.name,
      });
    }

    // No parent - emit event for human handling
    this.emit('escalation', { reason, task });
    return { escalated: true, reason };
  }

  /**
   * Check if task requires human approval
   */
  async _requiresApproval(task) {
    // Check if task type requires approval
    if (this.requiresApproval.includes(task.type)) {
      return true;
    }

    // Check thresholds (e.g., financial amount)
    for (const [key, threshold] of Object.entries(this.approvalThresholds)) {
      if (task[key] && task[key] > threshold) {
        return true;
      }
    }

    return false;
  }

  /**
   * Request approval from manager or human
   */
  async _requestApproval(task) {
    this.logger.info({ task: task.type }, 'Requesting approval');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ approved: false, reason: 'Approval timeout' });
      }, 300000); // 5 minute timeout

      this.once('approvalResponse', (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      this.emit('approvalRequired', { task, agentId: this.id });
    });
  }

  /**
   * Handle query from another agent
   */
  async _handleQuery(_query) {
    // Default implementation - subclasses can override
    return {
      status: this.getStatus(),
      query: 'handled',
    };
  }

  /**
   * Add entry to memory with size limit
   */
  _addToMemory(entry) {
    this.memory.push({
      ...entry,
      timestamp: new Date(),
    });

    // Trim memory if needed
    while (this.memory.length > this.maxMemorySize) {
      this.memory.shift();
    }
  }

  /**
   * Load agent-specific tools
   */
  async _loadTools() {
    // Override in subclasses
  }

  /**
   * Connect to required MCP servers
   */
  async _connectMCPServers() {
    // Override in subclasses
  }

  /**
   * Get default system prompt
   */
  _getDefaultSystemPrompt() {
    return `You are ${this.name}, an AI agent with the role of ${this.role}.
${this.description}

Your capabilities include: ${this.capabilities.join(', ')}

Guidelines:
- Be precise and accurate in your responses
- Use available tools when needed
- Escalate to your manager when unsure
- Report progress clearly
- Maintain professional communication`;
  }
}

module.exports = { BaseAgent };
