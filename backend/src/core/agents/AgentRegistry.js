/**
 * AgentRegistry - Central management for all AI agents
 *
 * Responsibilities:
 * - Register and track all agents
 * - Route messages between agents
 * - Monitor agent health
 * - Handle agent lifecycle
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

class AgentRegistry extends EventEmitter {
  constructor(options = {}) {
    super();

    this.agents = new Map();
    this.agentsByRole = new Map();
    this.messageQueue = [];
    this.processingQueue = false;

    this.logger = null;
    this.platform = null;

    // Configuration
    this.maxQueueSize = options.maxQueueSize || 10000;
    this.messageRetryLimit = options.messageRetryLimit || 3;
  }

  /**
   * Initialize the registry with platform context
   */
  async init(platform) {
    this.platform = platform;
    this.logger = platform.logger.child({ service: 'AgentRegistry' });

    // Start message queue processor
    this._startQueueProcessor();

    this.logger.info('Agent registry initialized');
  }

  /**
   * Register an agent
   */
  async register(agent, options = {}) {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent already registered: ${agent.id}`);
    }

    // Initialize agent with platform
    await agent.init(this.platform);

    // Store agent
    this.agents.set(agent.id, {
      agent,
      registeredAt: new Date(),
      options,
    });

    // Index by role
    if (!this.agentsByRole.has(agent.role)) {
      this.agentsByRole.set(agent.role, new Set());
    }
    this.agentsByRole.get(agent.role).add(agent.id);

    // Setup event listeners
    this._setupAgentListeners(agent);

    this.logger.info({ agentId: agent.id, name: agent.name, role: agent.role }, 'Agent registered');
    this.emit('agentRegistered', { agent });

    return agent;
  }

  /**
   * Unregister an agent
   */
  async unregister(agentId) {
    const registration = this.agents.get(agentId);
    if (!registration) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const { agent } = registration;

    // Shutdown the agent
    await agent.shutdown();

    // Remove from role index
    const roleSet = this.agentsByRole.get(agent.role);
    if (roleSet) {
      roleSet.delete(agentId);
      if (roleSet.size === 0) {
        this.agentsByRole.delete(agent.role);
      }
    }

    // Remove from registry
    this.agents.delete(agentId);

    this.logger.info({ agentId, name: agent.name }, 'Agent unregistered');
    this.emit('agentUnregistered', { agentId, name: agent.name });
  }

  /**
   * Get an agent by ID
   */
  get(agentId) {
    const registration = this.agents.get(agentId);
    return registration ? registration.agent : null;
  }

  /**
   * Get an agent by name
   */
  getByName(name) {
    for (const [id, registration] of this.agents) {
      if (registration.agent.name === name) {
        return registration.agent;
      }
    }
    return null;
  }

  /**
   * Get all agents with a specific role
   */
  getByRole(role) {
    const agentIds = this.agentsByRole.get(role);
    if (!agentIds) return [];

    return Array.from(agentIds)
      .map(id => this.agents.get(id)?.agent)
      .filter(Boolean);
  }

  /**
   * List all registered agents
   */
  list() {
    return Array.from(this.agents.values()).map(({ agent, registeredAt }) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      state: agent.state,
      registeredAt,
      status: agent.getStatus(),
    }));
  }

  /**
   * Route a message to the target agent
   */
  async routeMessage(message) {
    // Add to queue
    if (this.messageQueue.length >= this.maxQueueSize) {
      throw new Error('Message queue full');
    }

    message.queuedAt = new Date();
    message.retries = 0;
    this.messageQueue.push(message);

    this.emit('messageQueued', message);
    return message;
  }

  /**
   * Send a task to a specific agent
   */
  async sendTask(agentId, task) {
    const agent = this.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return agent.execute(task);
  }

  /**
   * Send a task to any available agent with the specified role
   */
  async sendTaskToRole(role, task) {
    const agents = this.getByRole(role);
    if (agents.length === 0) {
      throw new Error(`No agents available for role: ${role}`);
    }

    // Find an idle agent, or use the first one
    const idleAgent = agents.find(a => a.state === 'idle') || agents[0];
    return idleAgent.execute(task);
  }

  /**
   * Broadcast a message to all agents
   */
  async broadcast(type, payload, excludeRoles = []) {
    const results = [];

    for (const [id, registration] of this.agents) {
      const { agent } = registration;
      if (excludeRoles.includes(agent.role)) continue;

      try {
        const result = await agent.processMessage({ type, payload });
        results.push({ agentId: id, success: true, result });
      } catch (error) {
        results.push({ agentId: id, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Get aggregate health status of all agents
   */
  getHealth() {
    const health = {
      totalAgents: this.agents.size,
      byState: {},
      byRole: {},
      messageQueueSize: this.messageQueue.length,
    };

    for (const [id, registration] of this.agents) {
      const { agent } = registration;

      // Count by state
      health.byState[agent.state] = (health.byState[agent.state] || 0) + 1;

      // Count by role
      health.byRole[agent.role] = (health.byRole[agent.role] || 0) + 1;
    }

    return health;
  }

  /**
   * Start the message queue processor
   */
  _startQueueProcessor() {
    setInterval(() => this._processQueue(), 100);
  }

  /**
   * Process messages in the queue
   */
  async _processQueue() {
    if (this.processingQueue || this.messageQueue.length === 0) return;

    this.processingQueue = true;

    try {
      while (this.messageQueue.length > 0) {
        const message = this.messageQueue.shift();
        await this._deliverMessage(message);
      }
    } catch (error) {
      this.logger.error({ error: error.message }, 'Queue processing error');
    } finally {
      this.processingQueue = false;
    }
  }

  /**
   * Deliver a message to its target agent
   */
  async _deliverMessage(message) {
    const agent = this.get(message.to);

    if (!agent) {
      this.logger.warn({ messageId: message.id, to: message.to }, 'Target agent not found');
      this.emit('messageDeliveryFailed', { message, reason: 'Agent not found' });
      return;
    }

    try {
      const result = await agent.processMessage(message);
      this.emit('messageDelivered', { message, result });
    } catch (error) {
      message.retries++;

      if (message.retries < this.messageRetryLimit) {
        // Re-queue for retry
        this.messageQueue.push(message);
        this.logger.warn({ messageId: message.id, retries: message.retries }, 'Message delivery failed, retrying');
      } else {
        this.logger.error({ messageId: message.id, error: error.message }, 'Message delivery failed permanently');
        this.emit('messageDeliveryFailed', { message, reason: error.message });
      }
    }
  }

  /**
   * Setup event listeners for an agent
   */
  _setupAgentListeners(agent) {
    agent.on('taskCompleted', (data) => {
      this.emit('agentTaskCompleted', { agentId: agent.id, ...data });
    });

    agent.on('taskFailed', (data) => {
      this.emit('agentTaskFailed', { agentId: agent.id, ...data });
    });

    agent.on('escalation', (data) => {
      this.emit('agentEscalation', { agentId: agent.id, ...data });
    });

    agent.on('approvalRequired', (data) => {
      this.emit('approvalRequired', { agentId: agent.id, ...data });
    });
  }

  /**
   * Shutdown all agents
   */
  async shutdown() {
    this.logger.info('Shutting down all agents');

    for (const [id, registration] of this.agents) {
      try {
        await registration.agent.shutdown();
      } catch (error) {
        this.logger.error({ agentId: id, error: error.message }, 'Agent shutdown failed');
      }
    }

    this.agents.clear();
    this.agentsByRole.clear();
    this.messageQueue = [];

    this.emit('shutdown');
  }
}

// Singleton
let registryInstance = null;

function getAgentRegistry() {
  if (!registryInstance) {
    registryInstance = new AgentRegistry();
  }
  return registryInstance;
}

function createAgentRegistry(options = {}) {
  registryInstance = new AgentRegistry(options);
  return registryInstance;
}

module.exports = { AgentRegistry, getAgentRegistry, createAgentRegistry };
