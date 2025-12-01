/**
 * Agent System - AI Agent Swarm for Company Operations
 *
 * Exports all agent-related components.
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

// Integrations
const { createOdooMCPConfig, OdooDirectClient } = require('./integrations/OdooMCP');

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

  // Integrations
  createOdooMCPConfig,
  OdooDirectClient,

  // Data
  DataIngestionPipeline,
  getDataPipeline,
  createDataPipeline,
};
