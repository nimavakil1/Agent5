/**
 * Agent System - AI Agent Swarm for Company Operations
 *
 * Exports all agent-related components.
 * Phase 2: Added E-commerce, MCP integrations, protocols, monitoring
 */

// Core components
const { BaseAgent } = require('./BaseAgent');
const { LLMAgent } = require('./LLMAgent');
const { AgentRegistry, getAgentRegistry, createAgentRegistry } = require('./AgentRegistry');
const { MCPClient, MCPRegistry } = require('./MCPClient');
const { AgentModule } = require('./AgentModule');

// Specialized agents
const { FinanceAgent } = require('./specialized/FinanceAgent');
const { ManagerAgent } = require('./specialized/ManagerAgent');
const EcommerceAgent = require('./specialized/EcommerceAgent');

// Integrations - Phase 1
const { createOdooMCPConfig, OdooDirectClient } = require('./integrations/OdooMCP');

// Integrations - Phase 2
const { getAmazonMCPConfig, AmazonDirectClient, MARKETPLACE_IDS } = require('./integrations/AmazonMCP');
const { getBolMCPConfig, BolDirectClient, ORDER_STATUS, FULFILMENT_METHOD } = require('./integrations/BolMCP');
const { getMicrosoftMCPConfig, MicrosoftDirectClient, SCOPES: MS_SCOPES } = require('./integrations/MicrosoftMCP');

// Protocols
const {
  MessageType,
  Priority,
  ProtocolMessage,
  ConversationThread,
  CollaborationSession,
  ConsensusProposal,
  AgentProtocolHandler
} = require('./protocols/AgentProtocol');

// Monitoring
const {
  AgentMonitor,
  getMonitor,
  MetricType,
  AlertSeverity,
  AgentState
} = require('./monitoring/AgentMonitor');

// Data pipeline
const { DataIngestionPipeline, getDataPipeline, createDataPipeline } = require('./data/DataIngestionPipeline');

module.exports = {
  // Core
  BaseAgent,
  LLMAgent,
  AgentRegistry,
  getAgentRegistry,
  createAgentRegistry,
  MCPClient,
  MCPRegistry,
  AgentModule,

  // Specialized Agents
  FinanceAgent,
  ManagerAgent,
  EcommerceAgent,

  // Integrations - Odoo
  createOdooMCPConfig,
  OdooDirectClient,

  // Integrations - Amazon
  getAmazonMCPConfig,
  AmazonDirectClient,
  MARKETPLACE_IDS,

  // Integrations - Bol.com
  getBolMCPConfig,
  BolDirectClient,
  ORDER_STATUS,
  FULFILMENT_METHOD,

  // Integrations - Microsoft
  getMicrosoftMCPConfig,
  MicrosoftDirectClient,
  MS_SCOPES,

  // Protocols
  MessageType,
  Priority,
  ProtocolMessage,
  ConversationThread,
  CollaborationSession,
  ConsensusProposal,
  AgentProtocolHandler,

  // Monitoring
  AgentMonitor,
  getMonitor,
  MetricType,
  AlertSeverity,
  AgentState,

  // Data
  DataIngestionPipeline,
  getDataPipeline,
  createDataPipeline,
};
