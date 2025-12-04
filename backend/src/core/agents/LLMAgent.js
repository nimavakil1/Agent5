/**
 * LLMAgent - Base class for agents that use LLM for reasoning
 *
 * Extends BaseAgent with multi-provider LLM integration for:
 * - Tool use / function calling
 * - Chain-of-thought reasoning
 * - Extended thinking (Claude Opus)
 * - RAG with company knowledge
 */

const { BaseAgent } = require('./BaseAgent');
const { createLLMProvider, getRecommendedModel } = require('./llm');

class LLMAgent extends BaseAgent {
  constructor(config = {}) {
    super(config);

    // Get recommended model for this agent type
    const recommended = getRecommendedModel(config.taskType || this.role || 'general');

    // Create LLM provider
    this.llmProvider = createLLMProvider({
      provider: config.llmProvider || recommended.provider,
      model: config.llmModel || recommended.model,
      temperature: config.temperature ?? this.llmConfig.temperature,
      maxTokens: config.maxTokens || this.llmConfig.maxTokens,
      useExtendedThinking: config.useExtendedThinking ?? recommended.useExtendedThinking,
      thinkingBudget: config.thinkingBudget || 10000,
    });

    // Tool definitions cache
    this.toolDefinitions = [];

    // RAG context (injected from knowledge base)
    this.ragContext = null;

    // Company context (always available)
    this.companyContext = null;
  }

  /**
   * Initialize with platform
   */
  async init(platform) {
    await super.init(platform);

    // Build tool definitions
    this._buildToolDefinitions();

    // Load company context if available
    await this._loadCompanyContext();
  }

  /**
   * Set RAG context for current task
   */
  setRAGContext(context) {
    this.ragContext = context;
  }

  /**
   * Set company context
   */
  setCompanyContext(context) {
    this.companyContext = context;
  }

  /**
   * Think about what action to take using LLM
   */
  async _think(task, previousResult) {
    // Build messages for the LLM
    const messages = this._buildMessages(task, previousResult);

    // Get tool list for provider
    const tools = this._getToolsForProvider();

    // Call LLM with tools
    const response = await this.llmProvider.chatWithTools(messages, tools);

    // Log thinking if extended thinking was used
    if (response.thinking) {
      this.logger.debug({ thinking: response.thinking.substring(0, 500) }, 'Extended thinking');
    }

    // Check if the model wants to use a tool
    if (response.toolCall) {
      this.logger.debug({
        tool: response.toolCall.name,
        params: response.toolCall.input,
      }, 'LLM requested tool');

      return {
        action: 'tool',
        tool: this._mapToolName(response.toolCall.name),
        params: response.toolCall.input,
        reasoning: response.content,
        thinking: response.thinking,
      };
    }

    // Check if the model is delegating
    if (response.content && response.content.includes('[DELEGATE:')) {
      const match = response.content.match(/\[DELEGATE:(\w+)\](.*?)\[\/DELEGATE\]/s);
      if (match) {
        return {
          action: 'delegate',
          targetAgent: match[1],
          subtask: JSON.parse(match[2]),
          reasoning: response.content,
        };
      }
    }

    // Check if escalating
    if (response.content && response.content.includes('[ESCALATE]')) {
      const reason = response.content.replace('[ESCALATE]', '').trim();
      return {
        action: 'escalate',
        reason,
      };
    }

    // Check for completion
    if (response.stopReason === 'end_turn' ||
        response.stopReason === 'stop' ||
        (response.content && response.content.includes('[COMPLETE]'))) {

      // Try to extract structured result
      let result = response.content;

      // Look for JSON result
      const jsonMatch = response.content.match(/```json\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        try {
          result = JSON.parse(jsonMatch[1]);
        } catch (e) {
          // Keep as string
        }
      }

      return {
        action: 'complete',
        result,
        thinking: response.thinking,
      };
    }

    // Default: complete with content
    return {
      action: 'complete',
      result: response.content,
      thinking: response.thinking,
    };
  }

  /**
   * Build messages for the LLM
   */
  _buildMessages(task, previousResult) {
    const messages = [
      {
        role: 'system',
        content: this._buildSystemPrompt(),
      },
    ];

    // Add memory context
    for (const mem of this.memory.slice(-10)) {
      messages.push({
        role: mem.role,
        content: typeof mem.content === 'string' ? mem.content : JSON.stringify(mem.content),
      });
    }

    // Add current task
    messages.push({
      role: 'user',
      content: this._formatTask(task),
    });

    // Add previous result if any
    if (previousResult) {
      messages.push({
        role: 'assistant',
        content: `Previous action result: ${JSON.stringify(previousResult)}`,
      });
    }

    return messages;
  }

  /**
   * Build the system prompt with company context and RAG
   */
  _buildSystemPrompt() {
    const toolDescriptions = this._getToolDescriptions();

    let prompt = `${this.llmConfig.systemPrompt}

## Your Identity
- Agent ID: ${this.id}
- Agent Name: ${this.name}
- Agent Role: ${this.role}
- Current Time: ${new Date().toISOString()}`;

    // Add company context
    if (this.companyContext) {
      prompt += `

## Company Context
${this.companyContext}`;
    }

    // Add RAG context for current task
    if (this.ragContext) {
      prompt += `

## Relevant Knowledge
${this.ragContext}`;
    }

    prompt += `

## Available Tools
${toolDescriptions}

## Response Guidelines
- Use the provided tools when you need external data or actions
- When delegating to another agent, use: [DELEGATE:agentName]{"task": "..."}[/DELEGATE]
- When escalating to human, use: [ESCALATE] reason for escalation
- When task is complete, respond with [COMPLETE] followed by your answer
- For structured data, wrap in \`\`\`json code blocks
- Be concise and actionable
- Always explain your reasoning`;

    return prompt;
  }

  /**
   * Load company context from knowledge base
   */
  async _loadCompanyContext() {
    try {
      // Try to get company context from knowledge base
      if (this.platform?.getDb) {
        const db = this.platform.getDb();
        if (db) {
          const companyKnowledge = await db.collection('knowledge')
            .find({ category: 'company' })
            .limit(5)
            .toArray();

          if (companyKnowledge.length > 0) {
            this.companyContext = companyKnowledge
              .map(k => `### ${k.title}\n${k.content}`)
              .join('\n\n');
          }
        }
      }
    } catch (e) {
      this.logger.debug({ error: e.message }, 'Could not load company context');
    }
  }

  /**
   * Format a task for the LLM
   */
  _formatTask(task) {
    if (typeof task === 'string') {
      return task;
    }

    let formatted = `Task Type: ${task.type || 'general'}
Task ID: ${task.id || 'N/A'}
Description: ${task.description || JSON.stringify(task)}`;

    if (task.context) {
      formatted += `\nContext: ${JSON.stringify(task.context)}`;
    }
    if (task.constraints) {
      formatted += `\nConstraints: ${JSON.stringify(task.constraints)}`;
    }
    if (task.params) {
      formatted += `\nParameters: ${JSON.stringify(task.params)}`;
    }

    return formatted;
  }

  /**
   * Build tool definitions for LLM
   */
  _buildToolDefinitions() {
    this.toolDefinitions = [];
    this._toolNameMap = new Map();

    for (const [name, tool] of this.tools) {
      const cleanName = name.replace(/:/g, '_');

      this.toolDefinitions.push({
        name: cleanName,
        description: tool.schema.description || `Tool: ${name}`,
        inputSchema: tool.schema.inputSchema || tool.schema.parameters || {
          type: 'object',
          properties: {},
        },
      });

      this._toolNameMap.set(cleanName, name);
    }
  }

  /**
   * Get tools formatted for provider
   */
  _getToolsForProvider() {
    return this.toolDefinitions;
  }

  /**
   * Map clean tool name back to original
   */
  _mapToolName(cleanName) {
    return this._toolNameMap?.get(cleanName) || cleanName;
  }

  /**
   * Get tool descriptions for system prompt
   */
  _getToolDescriptions() {
    const descriptions = [];

    for (const [name, tool] of this.tools) {
      const desc = tool.schema.description || 'No description';
      descriptions.push(`- ${name}: ${desc}`);
    }

    return descriptions.length > 0 ? descriptions.join('\n') : 'No tools available';
  }

  /**
   * Execute a tool (with name mapping)
   */
  async _executeTool(toolName, params) {
    const originalName = this._toolNameMap?.get(toolName) || toolName;
    return super._executeTool(originalName, params);
  }

  /**
   * Generate a simple response without tools
   */
  async generateResponse(prompt, options = {}) {
    const messages = [
      { role: 'system', content: this.llmConfig.systemPrompt },
      { role: 'user', content: prompt },
    ];

    const response = await this.llmProvider.chat(messages, options);
    return response.content;
  }

  /**
   * Generate structured output
   */
  async generateStructured(prompt, schema, options = {}) {
    const messages = [
      {
        role: 'system',
        content: `${this.llmConfig.systemPrompt}\n\nRespond with valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`,
      },
      { role: 'user', content: prompt },
    ];

    const response = await this.llmProvider.chat(messages, {
      ...options,
      temperature: 0.3,
    });

    // Extract JSON from response
    const jsonMatch = response.content.match(/```json\n?([\s\S]*?)\n?```/) ||
                      response.content.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      return JSON.parse(jsonMatch[1] || jsonMatch[0]);
    }

    return JSON.parse(response.content);
  }

  /**
   * Query with RAG (retrieves relevant knowledge first)
   */
  async queryWithRAG(question, options = {}) {
    // Get relevant knowledge from vector search
    const ragContext = await this._retrieveRelevantKnowledge(question);
    this.setRAGContext(ragContext);

    // Generate response
    const response = await this.generateResponse(question, options);

    // Clear RAG context
    this.setRAGContext(null);

    return response;
  }

  /**
   * Retrieve relevant knowledge for RAG
   */
  async _retrieveRelevantKnowledge(query) {
    try {
      if (!this.platform?.getDb) return null;

      const db = this.platform.getDb();
      if (!db) return null;

      // Simple text search for now
      // TODO: Replace with vector similarity search
      const results = await db.collection('knowledge')
        .find({
          $or: [
            { title: { $regex: query, $options: 'i' } },
            { content: { $regex: query, $options: 'i' } },
            { tags: { $in: query.toLowerCase().split(' ') } },
          ],
        })
        .limit(5)
        .toArray();

      if (results.length === 0) return null;

      return results
        .map(r => `### ${r.title} (${r.category})\n${r.content}`)
        .join('\n\n---\n\n');

    } catch (e) {
      this.logger.debug({ error: e.message }, 'RAG retrieval failed');
      return null;
    }
  }
}

module.exports = { LLMAgent };
