/**
 * Agent-to-Agent Communication Protocol
 *
 * A comprehensive protocol for inter-agent communication supporting:
 * - Direct messaging (point-to-point)
 * - Broadcast messaging (one-to-many)
 * - Request-response patterns
 * - Publish-subscribe for events
 * - Task delegation chains
 * - Collaborative task execution
 * - Consensus mechanisms
 * - Conversation threads
 *
 * @module AgentProtocol
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

/**
 * Message Types
 */
const MessageType = {
  // Basic messaging
  DIRECT: 'direct',           // Point-to-point message
  BROADCAST: 'broadcast',     // One-to-many message
  MULTICAST: 'multicast',     // Message to specific group

  // Request-response
  REQUEST: 'request',         // Request expecting response
  RESPONSE: 'response',       // Response to request
  ERROR: 'error',             // Error response

  // Task-related
  TASK_DELEGATE: 'task_delegate',     // Delegate task to another agent
  TASK_ACCEPT: 'task_accept',         // Accept delegated task
  TASK_REJECT: 'task_reject',         // Reject delegated task
  TASK_PROGRESS: 'task_progress',     // Task progress update
  TASK_COMPLETE: 'task_complete',     // Task completion
  TASK_FAILED: 'task_failed',         // Task failure

  // Collaboration
  COLLABORATE_REQUEST: 'collaborate_request', // Request collaboration
  COLLABORATE_JOIN: 'collaborate_join',       // Join collaboration
  COLLABORATE_LEAVE: 'collaborate_leave',     // Leave collaboration
  COLLABORATE_UPDATE: 'collaborate_update',   // Collaboration update

  // Consensus
  PROPOSE: 'propose',         // Propose decision
  VOTE: 'vote',               // Vote on proposal
  CONSENSUS: 'consensus',     // Consensus reached

  // Events
  EVENT: 'event',             // Generic event
  SUBSCRIBE: 'subscribe',     // Subscribe to topic
  UNSUBSCRIBE: 'unsubscribe', // Unsubscribe from topic

  // System
  PING: 'ping',               // Health check
  PONG: 'pong',               // Health check response
  HEARTBEAT: 'heartbeat',     // Periodic heartbeat
  CAPABILITY_QUERY: 'capability_query',     // Query agent capabilities
  CAPABILITY_RESPONSE: 'capability_response' // Capability response
};

/**
 * Message Priority Levels
 */
const Priority = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
  CRITICAL: 4
};

/**
 * Protocol Message Structure
 */
class ProtocolMessage {
  constructor(options = {}) {
    this.id = options.id || uuidv4();
    this.type = options.type || MessageType.DIRECT;
    this.from = options.from;
    this.to = options.to;              // Single agent ID or array for multicast
    this.topic = options.topic;        // For pub/sub
    this.replyTo = options.replyTo;    // For request-response
    this.correlationId = options.correlationId; // Links related messages
    this.threadId = options.threadId;  // Conversation thread
    this.priority = options.priority ?? Priority.NORMAL;
    this.payload = options.payload || {};
    this.metadata = options.metadata || {};
    this.timestamp = options.timestamp || new Date().toISOString();
    this.ttl = options.ttl;            // Time-to-live in ms
    this.encrypted = options.encrypted || false;
  }

  /**
   * Check if message has expired
   */
  isExpired() {
    if (!this.ttl) return false;
    const created = new Date(this.timestamp).getTime();
    return Date.now() > created + this.ttl;
  }

  /**
   * Create response to this message
   */
  createResponse(payload, type = MessageType.RESPONSE) {
    return new ProtocolMessage({
      type: type,
      from: this.to,
      to: this.from,
      replyTo: this.id,
      correlationId: this.correlationId || this.id,
      threadId: this.threadId,
      payload: payload
    });
  }

  /**
   * Serialize message
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      from: this.from,
      to: this.to,
      topic: this.topic,
      replyTo: this.replyTo,
      correlationId: this.correlationId,
      threadId: this.threadId,
      priority: this.priority,
      payload: this.payload,
      metadata: this.metadata,
      timestamp: this.timestamp,
      ttl: this.ttl,
      encrypted: this.encrypted
    };
  }

  /**
   * Deserialize message
   */
  static fromJSON(json) {
    return new ProtocolMessage(json);
  }
}

/**
 * Conversation Thread
 * Manages a series of related messages
 */
class ConversationThread {
  constructor(id, participants = []) {
    this.id = id || uuidv4();
    this.participants = new Set(participants);
    this.messages = [];
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.metadata = {};
    this.status = 'active'; // active, closed, archived
  }

  addMessage(message) {
    this.messages.push(message);
    this.updatedAt = new Date().toISOString();
    if (message.from) this.participants.add(message.from);
  }

  getHistory(limit = 50) {
    return this.messages.slice(-limit);
  }

  close() {
    this.status = 'closed';
    this.updatedAt = new Date().toISOString();
  }
}

/**
 * Collaboration Session
 * Manages multi-agent collaborative tasks
 */
class CollaborationSession {
  constructor(id, initiator, task) {
    this.id = id || uuidv4();
    this.initiator = initiator;
    this.task = task;
    this.participants = new Map(); // agentId -> { role, joinedAt, status }
    this.status = 'pending'; // pending, active, completed, failed, cancelled
    this.results = new Map(); // agentId -> result
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;

    // Add initiator as first participant
    this.participants.set(initiator, {
      role: 'initiator',
      joinedAt: this.createdAt,
      status: 'active'
    });
  }

  addParticipant(agentId, role = 'participant') {
    this.participants.set(agentId, {
      role: role,
      joinedAt: new Date().toISOString(),
      status: 'active'
    });
    this.updatedAt = new Date().toISOString();
  }

  removeParticipant(agentId) {
    const participant = this.participants.get(agentId);
    if (participant) {
      participant.status = 'left';
      this.updatedAt = new Date().toISOString();
    }
  }

  submitResult(agentId, result) {
    this.results.set(agentId, {
      result: result,
      submittedAt: new Date().toISOString()
    });
    this.updatedAt = new Date().toISOString();
  }

  isComplete() {
    const activeParticipants = Array.from(this.participants.values())
      .filter(p => p.status === 'active').length;
    return this.results.size >= activeParticipants;
  }

  getAggregatedResult() {
    return {
      sessionId: this.id,
      task: this.task,
      participantCount: this.participants.size,
      results: Object.fromEntries(this.results),
      status: this.status,
      completedAt: this.updatedAt
    };
  }
}

/**
 * Consensus Proposal
 * Manages voting on proposals
 */
class ConsensusProposal {
  constructor(id, proposer, proposal, requiredVotes = 'majority') {
    this.id = id || uuidv4();
    this.proposer = proposer;
    this.proposal = proposal;
    this.requiredVotes = requiredVotes; // 'majority', 'unanimous', or number
    this.votes = new Map(); // agentId -> { vote, reason, timestamp }
    this.eligibleVoters = new Set();
    this.status = 'open'; // open, passed, rejected, expired
    this.createdAt = new Date().toISOString();
    this.deadline = null;
  }

  setEligibleVoters(voters) {
    voters.forEach(v => this.eligibleVoters.add(v));
  }

  setDeadline(deadline) {
    this.deadline = deadline;
  }

  castVote(agentId, vote, reason = '') {
    if (!this.eligibleVoters.has(agentId)) {
      throw new Error(`Agent ${agentId} is not eligible to vote`);
    }
    if (this.status !== 'open') {
      throw new Error('Voting is closed');
    }

    this.votes.set(agentId, {
      vote: vote, // true = approve, false = reject
      reason: reason,
      timestamp: new Date().toISOString()
    });

    // Check if consensus reached
    this._checkConsensus();
  }

  _checkConsensus() {
    const totalVoters = this.eligibleVoters.size;
    const currentVotes = this.votes.size;
    const approvals = Array.from(this.votes.values()).filter(v => v.vote === true).length;
    const rejections = currentVotes - approvals;

    let requiredApprovals;
    if (this.requiredVotes === 'majority') {
      requiredApprovals = Math.floor(totalVoters / 2) + 1;
    } else if (this.requiredVotes === 'unanimous') {
      requiredApprovals = totalVoters;
    } else {
      requiredApprovals = this.requiredVotes;
    }

    // Check if passed
    if (approvals >= requiredApprovals) {
      this.status = 'passed';
      return;
    }

    // Check if impossible to pass
    const remainingVotes = totalVoters - currentVotes;
    if (approvals + remainingVotes < requiredApprovals) {
      this.status = 'rejected';
      return;
    }

    // Check deadline
    if (this.deadline && new Date() > new Date(this.deadline)) {
      this.status = approvals >= requiredApprovals ? 'passed' : 'rejected';
    }
  }

  getResult() {
    return {
      proposalId: this.id,
      proposal: this.proposal,
      status: this.status,
      votes: Object.fromEntries(this.votes),
      approvals: Array.from(this.votes.values()).filter(v => v.vote).length,
      rejections: Array.from(this.votes.values()).filter(v => !v.vote).length,
      totalEligible: this.eligibleVoters.size
    };
  }
}

/**
 * Agent Protocol Handler
 * Central protocol management for an agent
 */
class AgentProtocolHandler extends EventEmitter {
  constructor(agentId, registry = null) {
    super();
    this.agentId = agentId;
    this.registry = registry;

    // Message handling
    this.pendingRequests = new Map(); // correlationId -> { resolve, reject, timeout }
    this.messageHandlers = new Map(); // type -> handler function

    // Pub/sub
    this.subscriptions = new Set(); // topics this agent subscribes to
    this.subscribers = new Map();   // topic -> Set of agentIds (for publishing)

    // Conversations
    this.threads = new Map(); // threadId -> ConversationThread

    // Collaborations
    this.collaborations = new Map(); // sessionId -> CollaborationSession

    // Consensus
    this.proposals = new Map(); // proposalId -> ConsensusProposal

    // Configuration
    this.config = {
      requestTimeout: 30000,      // 30 seconds
      maxRetries: 3,
      retryDelay: 1000,
      enableEncryption: false,
      maxThreadMessages: 1000,
      heartbeatInterval: 60000    // 1 minute
    };

    // Statistics
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      requestsSent: 0,
      responsesReceived: 0,
      errors: 0
    };

    // Register default handlers
    this._registerDefaultHandlers();
  }

  /**
   * Register default message handlers
   */
  _registerDefaultHandlers() {
    this.messageHandlers.set(MessageType.PING, (msg) => {
      return this.send(msg.createResponse({ status: 'alive' }, MessageType.PONG));
    });

    this.messageHandlers.set(MessageType.CAPABILITY_QUERY, (msg) => {
      const capabilities = this.emit('getCapabilities') || [];
      return this.send(msg.createResponse({ capabilities }, MessageType.CAPABILITY_RESPONSE));
    });
  }

  /**
   * Register custom message handler
   */
  registerHandler(type, handler) {
    this.messageHandlers.set(type, handler);
  }

  /**
   * Set agent registry reference
   */
  setRegistry(registry) {
    this.registry = registry;
  }

  /**
   * Send a message
   */
  async send(message) {
    if (!this.registry) {
      throw new Error('No registry configured');
    }

    message.from = this.agentId;
    this.stats.messagesSent++;

    // Handle broadcast
    if (message.type === MessageType.BROADCAST) {
      return this._broadcast(message);
    }

    // Handle multicast
    if (message.type === MessageType.MULTICAST && Array.isArray(message.to)) {
      return this._multicast(message);
    }

    // Handle pub/sub
    if (message.type === MessageType.EVENT && message.topic) {
      return this._publish(message);
    }

    // Direct send
    return this.registry.routeMessage(message.to, message);
  }

  /**
   * Send and wait for response
   */
  async request(to, payload, options = {}) {
    const correlationId = uuidv4();
    const message = new ProtocolMessage({
      type: MessageType.REQUEST,
      from: this.agentId,
      to: to,
      correlationId: correlationId,
      payload: payload,
      priority: options.priority ?? Priority.NORMAL,
      ttl: options.timeout || this.config.requestTimeout
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request timeout after ${options.timeout || this.config.requestTimeout}ms`));
      }, options.timeout || this.config.requestTimeout);

      this.pendingRequests.set(correlationId, {
        resolve: (response) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(correlationId);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(correlationId);
          reject(error);
        },
        timeout: timeout
      });

      this.stats.requestsSent++;
      this.send(message).catch(reject);
    });
  }

  /**
   * Handle incoming message
   */
  async handleMessage(message) {
    this.stats.messagesReceived++;

    // Check expiry
    if (message.isExpired && message.isExpired()) {
      this.emit('messageExpired', message);
      return;
    }

    // Handle response to pending request
    if ((message.type === MessageType.RESPONSE || message.type === MessageType.ERROR) && message.correlationId) {
      const pending = this.pendingRequests.get(message.correlationId);
      if (pending) {
        this.stats.responsesReceived++;
        if (message.type === MessageType.ERROR) {
          pending.reject(new Error(message.payload.error || 'Request failed'));
        } else {
          pending.resolve(message.payload);
        }
        return;
      }
    }

    // Add to thread if applicable
    if (message.threadId) {
      let thread = this.threads.get(message.threadId);
      if (!thread) {
        thread = new ConversationThread(message.threadId, [message.from, this.agentId]);
        this.threads.set(message.threadId, thread);
      }
      thread.addMessage(message);
    }

    // Check for registered handler
    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      try {
        return await handler(message);
      } catch (error) {
        this.stats.errors++;
        this.emit('handlerError', { message, error });

        // Send error response if it was a request
        if (message.type === MessageType.REQUEST) {
          return this.send(message.createResponse({
            error: error.message
          }, MessageType.ERROR));
        }
      }
    }

    // Emit for custom handling
    this.emit('message', message);
    this.emit(`message:${message.type}`, message);
  }

  /**
   * Broadcast message to all agents
   */
  async _broadcast(message) {
    if (!this.registry) return;

    const agents = this.registry.getAllAgents ? this.registry.getAllAgents() : [];
    const results = [];

    for (const agent of agents) {
      if (agent.id !== this.agentId) {
        const clone = ProtocolMessage.fromJSON(message.toJSON());
        clone.to = agent.id;
        results.push(this.registry.routeMessage(agent.id, clone));
      }
    }

    return Promise.allSettled(results);
  }

  /**
   * Multicast message to specific agents
   */
  async _multicast(message) {
    const targets = Array.isArray(message.to) ? message.to : [message.to];
    const results = [];

    for (const target of targets) {
      if (target !== this.agentId) {
        const clone = ProtocolMessage.fromJSON(message.toJSON());
        clone.to = target;
        results.push(this.registry.routeMessage(target, clone));
      }
    }

    return Promise.allSettled(results);
  }

  /**
   * Publish event to topic subscribers
   */
  async _publish(message) {
    const subscribers = this.subscribers.get(message.topic) || new Set();
    const results = [];

    for (const subscriberId of subscribers) {
      if (subscriberId !== this.agentId) {
        const clone = ProtocolMessage.fromJSON(message.toJSON());
        clone.to = subscriberId;
        results.push(this.registry.routeMessage(subscriberId, clone));
      }
    }

    return Promise.allSettled(results);
  }

  // ==================== PUB/SUB ====================

  /**
   * Subscribe to topic
   */
  subscribe(topic) {
    this.subscriptions.add(topic);
    this.emit('subscribed', topic);
  }

  /**
   * Unsubscribe from topic
   */
  unsubscribe(topic) {
    this.subscriptions.delete(topic);
    this.emit('unsubscribed', topic);
  }

  /**
   * Register a subscriber (for publishers)
   */
  addSubscriber(topic, agentId) {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }
    this.subscribers.get(topic).add(agentId);
  }

  /**
   * Remove a subscriber
   */
  removeSubscriber(topic, agentId) {
    const subs = this.subscribers.get(topic);
    if (subs) subs.delete(agentId);
  }

  /**
   * Publish event
   */
  async publishEvent(topic, data) {
    return this.send(new ProtocolMessage({
      type: MessageType.EVENT,
      topic: topic,
      payload: data
    }));
  }

  // ==================== TASK DELEGATION ====================

  /**
   * Delegate task to another agent
   */
  async delegateTask(targetAgentId, task, options = {}) {
    const message = new ProtocolMessage({
      type: MessageType.TASK_DELEGATE,
      to: targetAgentId,
      correlationId: uuidv4(),
      payload: {
        task: task,
        priority: options.priority || Priority.NORMAL,
        deadline: options.deadline,
        context: options.context || {}
      }
    });

    // Track delegation
    this.emit('taskDelegated', { target: targetAgentId, task, messageId: message.id });

    return this.send(message);
  }

  /**
   * Accept delegated task
   */
  async acceptTask(originalMessage, estimatedCompletion = null) {
    return this.send(originalMessage.createResponse({
      accepted: true,
      estimatedCompletion: estimatedCompletion
    }, MessageType.TASK_ACCEPT));
  }

  /**
   * Reject delegated task
   */
  async rejectTask(originalMessage, reason) {
    return this.send(originalMessage.createResponse({
      accepted: false,
      reason: reason
    }, MessageType.TASK_REJECT));
  }

  /**
   * Report task progress
   */
  async reportProgress(targetAgentId, correlationId, progress) {
    return this.send(new ProtocolMessage({
      type: MessageType.TASK_PROGRESS,
      to: targetAgentId,
      correlationId: correlationId,
      payload: {
        progress: progress, // 0-100
        status: progress >= 100 ? 'complete' : 'in_progress',
        timestamp: new Date().toISOString()
      }
    }));
  }

  /**
   * Complete task
   */
  async completeTask(targetAgentId, correlationId, result) {
    return this.send(new ProtocolMessage({
      type: MessageType.TASK_COMPLETE,
      to: targetAgentId,
      correlationId: correlationId,
      payload: {
        result: result,
        completedAt: new Date().toISOString()
      }
    }));
  }

  /**
   * Report task failure
   */
  async failTask(targetAgentId, correlationId, error) {
    return this.send(new ProtocolMessage({
      type: MessageType.TASK_FAILED,
      to: targetAgentId,
      correlationId: correlationId,
      payload: {
        error: error,
        failedAt: new Date().toISOString()
      }
    }));
  }

  // ==================== COLLABORATION ====================

  /**
   * Start collaboration session
   */
  async startCollaboration(task, invitees) {
    const session = new CollaborationSession(uuidv4(), this.agentId, task);
    this.collaborations.set(session.id, session);

    // Invite participants
    const inviteMessage = new ProtocolMessage({
      type: MessageType.COLLABORATE_REQUEST,
      to: invitees,
      payload: {
        sessionId: session.id,
        task: task,
        initiator: this.agentId
      }
    });

    await this._multicast(inviteMessage);

    this.emit('collaborationStarted', session);
    return session;
  }

  /**
   * Join collaboration
   */
  async joinCollaboration(sessionId, initiatorId) {
    const session = this.collaborations.get(sessionId);
    if (!session) {
      // Create local reference to remote session
      const newSession = new CollaborationSession(sessionId, initiatorId, null);
      newSession.addParticipant(this.agentId);
      this.collaborations.set(sessionId, newSession);
    }

    return this.send(new ProtocolMessage({
      type: MessageType.COLLABORATE_JOIN,
      to: initiatorId,
      payload: {
        sessionId: sessionId,
        agentId: this.agentId
      }
    }));
  }

  /**
   * Leave collaboration
   */
  async leaveCollaboration(sessionId) {
    const session = this.collaborations.get(sessionId);
    if (!session) return;

    session.removeParticipant(this.agentId);

    // Notify initiator
    return this.send(new ProtocolMessage({
      type: MessageType.COLLABORATE_LEAVE,
      to: session.initiator,
      payload: {
        sessionId: sessionId,
        agentId: this.agentId
      }
    }));
  }

  /**
   * Submit collaboration result
   */
  async submitCollaborationResult(sessionId, result) {
    const session = this.collaborations.get(sessionId);
    if (!session) return;

    session.submitResult(this.agentId, result);

    // Notify initiator
    return this.send(new ProtocolMessage({
      type: MessageType.COLLABORATE_UPDATE,
      to: session.initiator,
      payload: {
        sessionId: sessionId,
        agentId: this.agentId,
        result: result,
        isComplete: session.isComplete()
      }
    }));
  }

  // ==================== CONSENSUS ====================

  /**
   * Create proposal for voting
   */
  async createProposal(proposal, eligibleVoters, options = {}) {
    const prop = new ConsensusProposal(
      uuidv4(),
      this.agentId,
      proposal,
      options.requiredVotes || 'majority'
    );

    prop.setEligibleVoters(eligibleVoters);
    if (options.deadline) {
      prop.setDeadline(options.deadline);
    }

    this.proposals.set(prop.id, prop);

    // Broadcast proposal to eligible voters
    const message = new ProtocolMessage({
      type: MessageType.PROPOSE,
      to: eligibleVoters,
      payload: {
        proposalId: prop.id,
        proposal: proposal,
        deadline: options.deadline,
        requiredVotes: options.requiredVotes || 'majority'
      }
    });

    await this._multicast(message);

    this.emit('proposalCreated', prop);
    return prop;
  }

  /**
   * Vote on proposal
   */
  async vote(proposalId, proposerId, approve, reason = '') {
    return this.send(new ProtocolMessage({
      type: MessageType.VOTE,
      to: proposerId,
      payload: {
        proposalId: proposalId,
        vote: approve,
        reason: reason,
        voterId: this.agentId
      }
    }));
  }

  /**
   * Handle incoming vote
   */
  handleVote(proposalId, voterId, vote, reason) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;

    try {
      proposal.castVote(voterId, vote, reason);

      // Check if consensus reached
      if (proposal.status !== 'open') {
        this.emit('consensusReached', proposal.getResult());

        // Notify voters of result
        this._notifyConsensusResult(proposal);
      }

      return proposal.getResult();
    } catch (error) {
      this.emit('voteError', { proposalId, voterId, error });
      return null;
    }
  }

  /**
   * Notify voters of consensus result
   */
  async _notifyConsensusResult(proposal) {
    const message = new ProtocolMessage({
      type: MessageType.CONSENSUS,
      to: Array.from(proposal.eligibleVoters),
      payload: proposal.getResult()
    });

    return this._multicast(message);
  }

  // ==================== CONVERSATION THREADS ====================

  /**
   * Start new conversation thread
   */
  startThread(participants = []) {
    const thread = new ConversationThread(uuidv4(), [this.agentId, ...participants]);
    this.threads.set(thread.id, thread);
    return thread;
  }

  /**
   * Send message in thread
   */
  async sendInThread(threadId, to, content) {
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = new ConversationThread(threadId, [this.agentId, to]);
      this.threads.set(threadId, thread);
    }

    const message = new ProtocolMessage({
      type: MessageType.DIRECT,
      to: to,
      threadId: threadId,
      payload: { content: content }
    });

    thread.addMessage(message);
    return this.send(message);
  }

  /**
   * Get thread history
   */
  getThreadHistory(threadId, limit = 50) {
    const thread = this.threads.get(threadId);
    return thread ? thread.getHistory(limit) : [];
  }

  /**
   * Close thread
   */
  closeThread(threadId) {
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.close();
      this.emit('threadClosed', threadId);
    }
  }

  // ==================== UTILITIES ====================

  /**
   * Get protocol statistics
   */
  getStats() {
    return {
      ...this.stats,
      pendingRequests: this.pendingRequests.size,
      activeThreads: this.threads.size,
      activeCollaborations: this.collaborations.size,
      openProposals: Array.from(this.proposals.values()).filter(p => p.status === 'open').length,
      subscriptions: this.subscriptions.size
    };
  }

  /**
   * Clear expired data
   */
  cleanup() {
    // Clear old threads
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();

    for (const [id, thread] of this.threads) {
      if (thread.status === 'closed' || now - new Date(thread.updatedAt).getTime() > maxAge) {
        this.threads.delete(id);
      }
    }

    // Clear completed collaborations
    for (const [id, session] of this.collaborations) {
      if (['completed', 'failed', 'cancelled'].includes(session.status)) {
        this.collaborations.delete(id);
      }
    }

    // Clear closed proposals
    for (const [id, proposal] of this.proposals) {
      if (proposal.status !== 'open') {
        this.proposals.delete(id);
      }
    }
  }
}

module.exports = {
  MessageType,
  Priority,
  ProtocolMessage,
  ConversationThread,
  CollaborationSession,
  ConsensusProposal,
  AgentProtocolHandler
};
