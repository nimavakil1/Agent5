/**
 * Agent Monitoring Service
 *
 * Centralized monitoring system for all agents in the swarm.
 * Provides real-time metrics, health checks, activity tracking, and alerting.
 *
 * Features:
 * - Real-time agent status monitoring
 * - Performance metrics collection
 * - Activity logging and audit trail
 * - Health checks and heartbeats
 * - Alert management
 * - Historical data retention
 *
 * @module AgentMonitor
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

/**
 * Metric Types
 */
const MetricType = {
  COUNTER: 'counter',
  GAUGE: 'gauge',
  HISTOGRAM: 'histogram',
  TIMER: 'timer'
};

/**
 * Alert Severity
 */
const AlertSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

/**
 * Agent State
 */
const AgentState = {
  IDLE: 'idle',
  THINKING: 'thinking',
  EXECUTING: 'executing',
  WAITING: 'waiting',
  ERROR: 'error',
  OFFLINE: 'offline'
};

/**
 * Metric class for tracking various measurements
 */
class Metric {
  constructor(name, type, labels = {}) {
    this.name = name;
    this.type = type;
    this.labels = labels;
    this.value = type === MetricType.HISTOGRAM ? [] : 0;
    this.lastUpdated = new Date().toISOString();
  }

  increment(amount = 1) {
    if (this.type === MetricType.COUNTER || this.type === MetricType.GAUGE) {
      this.value += amount;
      this.lastUpdated = new Date().toISOString();
    }
  }

  decrement(amount = 1) {
    if (this.type === MetricType.GAUGE) {
      this.value -= amount;
      this.lastUpdated = new Date().toISOString();
    }
  }

  set(value) {
    if (this.type === MetricType.GAUGE) {
      this.value = value;
      this.lastUpdated = new Date().toISOString();
    }
  }

  observe(value) {
    if (this.type === MetricType.HISTOGRAM || this.type === MetricType.TIMER) {
      this.value.push({ value, timestamp: new Date().toISOString() });
      // Keep last 1000 observations
      if (this.value.length > 1000) {
        this.value = this.value.slice(-1000);
      }
      this.lastUpdated = new Date().toISOString();
    }
  }

  getStats() {
    if (this.type === MetricType.HISTOGRAM || this.type === MetricType.TIMER) {
      const values = this.value.map(v => v.value);
      if (values.length === 0) return { count: 0 };

      const sorted = [...values].sort((a, b) => a - b);
      return {
        count: values.length,
        sum: values.reduce((a, b) => a + b, 0),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p90: sorted[Math.floor(sorted.length * 0.9)],
        p99: sorted[Math.floor(sorted.length * 0.99)]
      };
    }
    return { value: this.value };
  }

  toJSON() {
    return {
      name: this.name,
      type: this.type,
      labels: this.labels,
      ...this.getStats(),
      lastUpdated: this.lastUpdated
    };
  }
}

/**
 * Activity Log Entry
 */
class ActivityEntry {
  constructor(agentId, action, details = {}) {
    this.id = uuidv4();
    this.agentId = agentId;
    this.action = action;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Agent Monitor - Central monitoring service
 */
class AgentMonitor extends EventEmitter {
  constructor(config = {}) {
    super();

    // Configuration
    this.config = {
      heartbeatInterval: config.heartbeatInterval || 30000,     // 30 seconds
      healthCheckInterval: config.healthCheckInterval || 60000, // 1 minute
      metricsRetention: config.metricsRetention || 24 * 60 * 60 * 1000, // 24 hours
      activityLogSize: config.activityLogSize || 10000,
      alertRetention: config.alertRetention || 7 * 24 * 60 * 60 * 1000, // 7 days
      ...config
    };

    // Agent tracking
    this.agents = new Map(); // agentId -> agent info
    this.agentStates = new Map(); // agentId -> current state

    // Metrics
    this.metrics = new Map(); // metricName -> Metric
    this.agentMetrics = new Map(); // agentId -> Map of metrics

    // Activity log
    this.activityLog = [];

    // Alerts
    this.alerts = [];
    this.alertRules = [];

    // Health status
    this.systemHealth = {
      status: 'healthy',
      lastCheck: null,
      agents: {}
    };

    // Snapshots for historical data
    this.snapshots = [];
    this.maxSnapshots = 1440; // 24 hours at 1-minute intervals

    // Timers
    this.heartbeatTimer = null;
    this.healthCheckTimer = null;
    this.snapshotTimer = null;

    // Initialize default metrics
    this._initializeMetrics();
  }

  /**
   * Initialize default system metrics
   */
  _initializeMetrics() {
    // System-wide metrics
    this.createMetric('agents_total', MetricType.GAUGE, { description: 'Total registered agents' });
    this.createMetric('agents_active', MetricType.GAUGE, { description: 'Currently active agents' });
    this.createMetric('agents_idle', MetricType.GAUGE, { description: 'Idle agents' });
    this.createMetric('agents_error', MetricType.GAUGE, { description: 'Agents in error state' });

    this.createMetric('tasks_total', MetricType.COUNTER, { description: 'Total tasks processed' });
    this.createMetric('tasks_success', MetricType.COUNTER, { description: 'Successful tasks' });
    this.createMetric('tasks_failed', MetricType.COUNTER, { description: 'Failed tasks' });

    this.createMetric('messages_total', MetricType.COUNTER, { description: 'Total messages sent' });
    this.createMetric('messages_received', MetricType.COUNTER, { description: 'Messages received' });

    this.createMetric('task_duration', MetricType.HISTOGRAM, { description: 'Task duration in ms' });
    this.createMetric('response_time', MetricType.HISTOGRAM, { description: 'Response time in ms' });
  }

  /**
   * Start monitoring
   */
  start() {
    // Start heartbeat monitoring
    this.heartbeatTimer = setInterval(() => {
      this._checkHeartbeats();
    }, this.config.heartbeatInterval);

    // Start health checks
    this.healthCheckTimer = setInterval(() => {
      this._performHealthChecks();
    }, this.config.healthCheckInterval);

    // Start snapshot collection
    this.snapshotTimer = setInterval(() => {
      this._takeSnapshot();
    }, 60000); // Every minute

    this.emit('started');
    this.logActivity('system', 'monitor_started', { config: this.config });
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);

    this.emit('stopped');
    this.logActivity('system', 'monitor_stopped', {});
  }

  // ==================== AGENT REGISTRATION ====================

  /**
   * Register an agent for monitoring
   */
  registerAgent(agent) {
    const agentInfo = {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      capabilities: agent.capabilities || [],
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      lastActivity: null,
      metadata: agent.metadata || {}
    };

    this.agents.set(agent.id, agentInfo);
    this.agentStates.set(agent.id, AgentState.IDLE);
    this.agentMetrics.set(agent.id, new Map());

    // Initialize agent-specific metrics
    this._initializeAgentMetrics(agent.id);

    // Update system metrics
    this.getMetric('agents_total').set(this.agents.size);
    this._updateStateMetrics();

    // Subscribe to agent events
    this._subscribeToAgent(agent);

    this.emit('agentRegistered', agentInfo);
    this.logActivity(agent.id, 'registered', { name: agent.name, role: agent.role });

    return agentInfo;
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.agents.delete(agentId);
    this.agentStates.delete(agentId);
    this.agentMetrics.delete(agentId);

    // Update system metrics
    this.getMetric('agents_total').set(this.agents.size);
    this._updateStateMetrics();

    this.emit('agentUnregistered', { agentId });
    this.logActivity(agentId, 'unregistered', {});
  }

  /**
   * Initialize metrics for a specific agent
   */
  _initializeAgentMetrics(agentId) {
    const metrics = this.agentMetrics.get(agentId);

    metrics.set('tasks_processed', new Metric('tasks_processed', MetricType.COUNTER));
    metrics.set('tasks_success', new Metric('tasks_success', MetricType.COUNTER));
    metrics.set('tasks_failed', new Metric('tasks_failed', MetricType.COUNTER));
    metrics.set('messages_sent', new Metric('messages_sent', MetricType.COUNTER));
    metrics.set('messages_received', new Metric('messages_received', MetricType.COUNTER));
    metrics.set('tool_calls', new Metric('tool_calls', MetricType.COUNTER));
    metrics.set('llm_calls', new Metric('llm_calls', MetricType.COUNTER));
    metrics.set('llm_tokens', new Metric('llm_tokens', MetricType.COUNTER));
    metrics.set('task_duration', new Metric('task_duration', MetricType.HISTOGRAM));
    metrics.set('response_time', new Metric('response_time', MetricType.HISTOGRAM));
    metrics.set('error_count', new Metric('error_count', MetricType.COUNTER));
  }

  /**
   * Subscribe to agent events for automatic tracking
   */
  _subscribeToAgent(agent) {
    if (!agent.on) return;

    agent.on('stateChange', (state) => {
      this.updateAgentState(agent.id, state);
    });

    agent.on('taskStart', (task) => {
      this.trackTaskStart(agent.id, task);
    });

    agent.on('taskComplete', (result) => {
      this.trackTaskComplete(agent.id, result);
    });

    agent.on('taskError', (error) => {
      this.trackTaskError(agent.id, error);
    });

    agent.on('message', (msg) => {
      this.trackMessage(agent.id, msg, 'received');
    });

    agent.on('messageSent', (msg) => {
      this.trackMessage(agent.id, msg, 'sent');
    });

    agent.on('toolCall', (tool) => {
      this.trackToolCall(agent.id, tool);
    });

    agent.on('llmCall', (data) => {
      this.trackLLMCall(agent.id, data);
    });

    agent.on('error', (error) => {
      this.trackError(agent.id, error);
    });
  }

  // ==================== METRICS ====================

  /**
   * Create a new metric
   */
  createMetric(name, type, labels = {}) {
    const metric = new Metric(name, type, labels);
    this.metrics.set(name, metric);
    return metric;
  }

  /**
   * Get a metric
   */
  getMetric(name) {
    return this.metrics.get(name);
  }

  /**
   * Get agent-specific metric
   */
  getAgentMetric(agentId, metricName) {
    const agentMetrics = this.agentMetrics.get(agentId);
    return agentMetrics ? agentMetrics.get(metricName) : null;
  }

  /**
   * Increment agent metric
   */
  incrementAgentMetric(agentId, metricName, amount = 1) {
    const metric = this.getAgentMetric(agentId, metricName);
    if (metric) metric.increment(amount);
  }

  /**
   * Observe value for histogram metric
   */
  observeAgentMetric(agentId, metricName, value) {
    const metric = this.getAgentMetric(agentId, metricName);
    if (metric) metric.observe(value);
  }

  /**
   * Get all metrics summary
   */
  getAllMetrics() {
    const systemMetrics = {};
    for (const [name, metric] of this.metrics) {
      systemMetrics[name] = metric.toJSON();
    }

    const agentMetrics = {};
    for (const [agentId, metrics] of this.agentMetrics) {
      agentMetrics[agentId] = {};
      for (const [name, metric] of metrics) {
        agentMetrics[agentId][name] = metric.toJSON();
      }
    }

    return { system: systemMetrics, agents: agentMetrics };
  }

  // ==================== STATE TRACKING ====================

  /**
   * Update agent state
   */
  updateAgentState(agentId, state) {
    const previousState = this.agentStates.get(agentId);
    this.agentStates.set(agentId, state);

    // Update last activity
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastActivity = new Date().toISOString();
    }

    this._updateStateMetrics();

    this.emit('agentStateChange', { agentId, previousState, newState: state });

    // Log state change
    if (state === AgentState.ERROR) {
      this.logActivity(agentId, 'state_error', { previousState, newState: state });
    }
  }

  /**
   * Update state-related metrics
   */
  _updateStateMetrics() {
    let active = 0, idle = 0, error = 0;

    for (const state of this.agentStates.values()) {
      switch (state) {
        case AgentState.THINKING:
        case AgentState.EXECUTING:
          active++;
          break;
        case AgentState.IDLE:
        case AgentState.WAITING:
          idle++;
          break;
        case AgentState.ERROR:
          error++;
          break;
      }
    }

    this.getMetric('agents_active').set(active);
    this.getMetric('agents_idle').set(idle);
    this.getMetric('agents_error').set(error);
  }

  /**
   * Record heartbeat from agent
   */
  recordHeartbeat(agentId) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastHeartbeat = new Date().toISOString();

      // If agent was offline, mark as recovered
      if (this.agentStates.get(agentId) === AgentState.OFFLINE) {
        this.updateAgentState(agentId, AgentState.IDLE);
        this.emit('agentRecovered', { agentId });
      }
    }
  }

  // ==================== ACTIVITY TRACKING ====================

  /**
   * Log an activity
   */
  logActivity(agentId, action, details = {}) {
    const entry = new ActivityEntry(agentId, action, details);
    this.activityLog.push(entry);

    // Trim log if too large
    if (this.activityLog.length > this.config.activityLogSize) {
      this.activityLog = this.activityLog.slice(-this.config.activityLogSize);
    }

    this.emit('activity', entry);
    return entry;
  }

  /**
   * Track task start
   */
  trackTaskStart(agentId, task) {
    this.incrementAgentMetric(agentId, 'tasks_processed');
    this.getMetric('tasks_total').increment();
    this.logActivity(agentId, 'task_start', { taskId: task.id, type: task.type });

    // Store start time for duration calculation
    const agent = this.agents.get(agentId);
    if (agent) {
      agent._currentTaskStart = Date.now();
    }
  }

  /**
   * Track task completion
   */
  trackTaskComplete(agentId, result) {
    this.incrementAgentMetric(agentId, 'tasks_success');
    this.getMetric('tasks_success').increment();

    // Calculate duration
    const agent = this.agents.get(agentId);
    if (agent && agent._currentTaskStart) {
      const duration = Date.now() - agent._currentTaskStart;
      this.observeAgentMetric(agentId, 'task_duration', duration);
      this.getMetric('task_duration').observe(duration);
      delete agent._currentTaskStart;
    }

    this.logActivity(agentId, 'task_complete', { result: result?.summary || 'success' });
  }

  /**
   * Track task error
   */
  trackTaskError(agentId, error) {
    this.incrementAgentMetric(agentId, 'tasks_failed');
    this.incrementAgentMetric(agentId, 'error_count');
    this.getMetric('tasks_failed').increment();

    // Clean up task start time
    const agent = this.agents.get(agentId);
    if (agent) {
      delete agent._currentTaskStart;
    }

    this.logActivity(agentId, 'task_error', {
      error: error.message || String(error),
      stack: error.stack
    });

    // Create alert for errors
    this.createAlert({
      severity: AlertSeverity.ERROR,
      source: agentId,
      title: 'Task Execution Error',
      message: error.message || String(error),
      details: { error: error.stack }
    });
  }

  /**
   * Track message
   */
  trackMessage(agentId, msg, direction) {
    const metricName = direction === 'sent' ? 'messages_sent' : 'messages_received';
    this.incrementAgentMetric(agentId, metricName);
    this.getMetric(direction === 'sent' ? 'messages_total' : 'messages_received').increment();
  }

  /**
   * Track tool call
   */
  trackToolCall(agentId, tool) {
    this.incrementAgentMetric(agentId, 'tool_calls');
    this.logActivity(agentId, 'tool_call', { tool: tool.name });
  }

  /**
   * Track LLM call
   */
  trackLLMCall(agentId, data) {
    this.incrementAgentMetric(agentId, 'llm_calls');
    if (data.tokens) {
      this.incrementAgentMetric(agentId, 'llm_tokens', data.tokens);
    }
    if (data.duration) {
      this.observeAgentMetric(agentId, 'response_time', data.duration);
      this.getMetric('response_time').observe(data.duration);
    }
  }

  /**
   * Track error
   */
  trackError(agentId, error) {
    this.incrementAgentMetric(agentId, 'error_count');
    this.logActivity(agentId, 'error', {
      error: error.message || String(error)
    });
  }

  /**
   * Get activity log
   */
  getActivityLog(options = {}) {
    let log = [...this.activityLog];

    // Filter by agent
    if (options.agentId) {
      log = log.filter(e => e.agentId === options.agentId);
    }

    // Filter by action
    if (options.action) {
      log = log.filter(e => e.action === options.action);
    }

    // Filter by time range
    if (options.since) {
      const sinceTime = new Date(options.since).getTime();
      log = log.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
    }

    // Limit
    if (options.limit) {
      log = log.slice(-options.limit);
    }

    return log;
  }

  // ==================== HEALTH CHECKS ====================

  /**
   * Check heartbeats and mark offline agents
   */
  _checkHeartbeats() {
    const now = Date.now();
    const timeout = this.config.heartbeatInterval * 3; // Miss 3 heartbeats

    for (const [agentId, agent] of this.agents) {
      const lastHeartbeat = new Date(agent.lastHeartbeat).getTime();
      if (now - lastHeartbeat > timeout) {
        if (this.agentStates.get(agentId) !== AgentState.OFFLINE) {
          this.updateAgentState(agentId, AgentState.OFFLINE);

          this.createAlert({
            severity: AlertSeverity.WARNING,
            source: agentId,
            title: 'Agent Offline',
            message: `Agent ${agent.name} has not sent heartbeat in ${Math.round(timeout / 1000)}s`
          });

          this.emit('agentOffline', { agentId, agent });
        }
      }
    }
  }

  /**
   * Perform health checks
   */
  _performHealthChecks() {
    const health = {
      status: 'healthy',
      lastCheck: new Date().toISOString(),
      agents: {},
      issues: []
    };

    let hasWarnings = false;
    let hasCritical = false;

    for (const [agentId, agent] of this.agents) {
      const state = this.agentStates.get(agentId);
      const agentHealth = {
        name: agent.name,
        state: state,
        lastHeartbeat: agent.lastHeartbeat,
        lastActivity: agent.lastActivity,
        metrics: this.getAgentMetricsSummary(agentId)
      };

      // Check for issues
      if (state === AgentState.OFFLINE) {
        agentHealth.status = 'critical';
        health.issues.push({ agentId, issue: 'Agent offline' });
        hasCritical = true;
      } else if (state === AgentState.ERROR) {
        agentHealth.status = 'error';
        health.issues.push({ agentId, issue: 'Agent in error state' });
        hasCritical = true;
      } else if (agentHealth.metrics.errorRate > 10) {
        agentHealth.status = 'warning';
        health.issues.push({ agentId, issue: `High error rate: ${agentHealth.metrics.errorRate}%` });
        hasWarnings = true;
      } else {
        agentHealth.status = 'healthy';
      }

      health.agents[agentId] = agentHealth;
    }

    // Determine overall status
    if (hasCritical) {
      health.status = 'critical';
    } else if (hasWarnings) {
      health.status = 'warning';
    }

    this.systemHealth = health;
    this.emit('healthCheck', health);

    return health;
  }

  /**
   * Get agent metrics summary
   */
  getAgentMetricsSummary(agentId) {
    const metrics = this.agentMetrics.get(agentId);
    if (!metrics) return {};

    const tasksProcessed = metrics.get('tasks_processed')?.value || 0;
    const tasksFailed = metrics.get('tasks_failed')?.value || 0;
    const durationStats = metrics.get('task_duration')?.getStats() || {};

    return {
      tasksProcessed,
      tasksFailed,
      tasksSuccess: metrics.get('tasks_success')?.value || 0,
      errorRate: tasksProcessed > 0 ? (tasksFailed / tasksProcessed * 100).toFixed(1) : 0,
      avgTaskDuration: durationStats.avg?.toFixed(0) || 0,
      p99TaskDuration: durationStats.p99?.toFixed(0) || 0,
      messagesSent: metrics.get('messages_sent')?.value || 0,
      messagesReceived: metrics.get('messages_received')?.value || 0,
      toolCalls: metrics.get('tool_calls')?.value || 0,
      llmCalls: metrics.get('llm_calls')?.value || 0,
      llmTokens: metrics.get('llm_tokens')?.value || 0
    };
  }

  /**
   * Get current system health
   */
  getHealth() {
    return this.systemHealth;
  }

  // ==================== ALERTS ====================

  /**
   * Create an alert
   */
  createAlert(options) {
    const alert = {
      id: uuidv4(),
      severity: options.severity || AlertSeverity.INFO,
      source: options.source,
      title: options.title,
      message: options.message,
      details: options.details || {},
      timestamp: new Date().toISOString(),
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null
    };

    this.alerts.push(alert);

    // Clean old alerts
    const retentionCutoff = Date.now() - this.config.alertRetention;
    this.alerts = this.alerts.filter(a =>
      new Date(a.timestamp).getTime() > retentionCutoff || !a.acknowledged
    );

    this.emit('alert', alert);
    return alert;
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId, acknowledgedBy = 'system') {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedBy = acknowledgedBy;
      alert.acknowledgedAt = new Date().toISOString();
      this.emit('alertAcknowledged', alert);
    }
    return alert;
  }

  /**
   * Get alerts
   */
  getAlerts(options = {}) {
    let alerts = [...this.alerts];

    // Filter by severity
    if (options.severity) {
      alerts = alerts.filter(a => a.severity === options.severity);
    }

    // Filter by source
    if (options.source) {
      alerts = alerts.filter(a => a.source === options.source);
    }

    // Filter acknowledged
    if (options.acknowledged !== undefined) {
      alerts = alerts.filter(a => a.acknowledged === options.acknowledged);
    }

    // Sort by timestamp (newest first)
    alerts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Limit
    if (options.limit) {
      alerts = alerts.slice(0, options.limit);
    }

    return alerts;
  }

  /**
   * Add alert rule for automatic alerting
   */
  addAlertRule(rule) {
    this.alertRules.push({
      id: uuidv4(),
      ...rule
    });
  }

  // ==================== SNAPSHOTS ====================

  /**
   * Take a snapshot of current state
   */
  _takeSnapshot() {
    const snapshot = {
      timestamp: new Date().toISOString(),
      agents: {},
      metrics: {}
    };

    // Agent states
    for (const [agentId, _agent] of this.agents) {
      snapshot.agents[agentId] = {
        state: this.agentStates.get(agentId),
        metrics: this.getAgentMetricsSummary(agentId)
      };
    }

    // System metrics
    for (const [name, metric] of this.metrics) {
      snapshot.metrics[name] = metric.toJSON();
    }

    this.snapshots.push(snapshot);

    // Trim old snapshots
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-this.maxSnapshots);
    }

    return snapshot;
  }

  /**
   * Get historical snapshots
   */
  getSnapshots(options = {}) {
    let snapshots = [...this.snapshots];

    if (options.since) {
      const sinceTime = new Date(options.since).getTime();
      snapshots = snapshots.filter(s => new Date(s.timestamp).getTime() >= sinceTime);
    }

    if (options.limit) {
      snapshots = snapshots.slice(-options.limit);
    }

    return snapshots;
  }

  // ==================== DASHBOARD DATA ====================

  /**
   * Get comprehensive dashboard data
   */
  getDashboardData() {
    return {
      timestamp: new Date().toISOString(),
      health: this.systemHealth,
      agents: this.getAgentsSummary(),
      metrics: this.getAllMetrics(),
      alerts: this.getAlerts({ limit: 20, acknowledged: false }),
      activity: this.getActivityLog({ limit: 50 }),
      charts: {
        agentStates: this._getStateDistribution(),
        taskTrend: this._getTaskTrend(),
        errorTrend: this._getErrorTrend()
      }
    };
  }

  /**
   * Get agents summary
   */
  getAgentsSummary() {
    const agents = [];

    for (const [agentId, agent] of this.agents) {
      agents.push({
        id: agentId,
        name: agent.name,
        role: agent.role,
        state: this.agentStates.get(agentId),
        lastHeartbeat: agent.lastHeartbeat,
        lastActivity: agent.lastActivity,
        metrics: this.getAgentMetricsSummary(agentId)
      });
    }

    return agents;
  }

  /**
   * Get state distribution for chart
   */
  _getStateDistribution() {
    const distribution = {};

    for (const state of Object.values(AgentState)) {
      distribution[state] = 0;
    }

    for (const state of this.agentStates.values()) {
      distribution[state] = (distribution[state] || 0) + 1;
    }

    return distribution;
  }

  /**
   * Get task trend from snapshots
   */
  _getTaskTrend() {
    return this.snapshots.slice(-60).map(s => ({
      timestamp: s.timestamp,
      total: s.metrics.tasks_total?.value || 0,
      success: s.metrics.tasks_success?.value || 0,
      failed: s.metrics.tasks_failed?.value || 0
    }));
  }

  /**
   * Get error trend from snapshots
   */
  _getErrorTrend() {
    return this.snapshots.slice(-60).map(s => ({
      timestamp: s.timestamp,
      errors: s.metrics.tasks_failed?.value || 0
    }));
  }
}

// Export singleton instance for global use
let monitorInstance = null;

function getMonitor(config = {}) {
  if (!monitorInstance) {
    monitorInstance = new AgentMonitor(config);
  }
  return monitorInstance;
}

module.exports = {
  AgentMonitor,
  getMonitor,
  MetricType,
  AlertSeverity,
  AgentState,
  Metric,
  ActivityEntry
};
