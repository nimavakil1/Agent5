/**
 * LLMAgent - Base class for agents that use LLM for reasoning
 *
 * Extends BaseAgent with actual LLM integration for:
 * - Tool use / function calling
 * - Chain-of-thought reasoning
 * - Structured output
 */

const { BaseAgent } = require('./BaseAgent');
const OpenAI = require('openai');

class LLMAgent extends BaseAgent {
  constructor(config = {}) {
    super(config);

    // OpenAI client
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Tool definitions for function calling
    this.toolDefinitions = [];
  }

  /**
   * Initialize with platform
   */
  async init(platform) {
    await super.init(platform);

    // Build tool definitions for OpenAI function calling
    this._buildToolDefinitions();
  }

  /**
   * Think about what action to take using LLM
   */
  async _think(task, previousResult) {
    // Build messages for the LLM
    const messages = this._buildMessages(task, previousResult);

    // Call OpenAI with tools
    const response = await this.openai.chat.completions.create({
      model: this.llmConfig.model,
      messages,
      tools: this.toolDefinitions.length > 0 ? this.toolDefinitions : undefined,
      tool_choice: this.toolDefinitions.length > 0 ? 'auto' : undefined,
      temperature: this.llmConfig.temperature,
      max_tokens: this.llmConfig.maxTokens,
    });

    const choice = response.choices[0];
    const message = choice.message;

    // Check if the model wants to use a tool
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];
      const toolName = toolCall.function.name;
      const toolParams = JSON.parse(toolCall.function.arguments);

      this.logger.debug({ tool: toolName, params: toolParams }, 'LLM requested tool');

      return {
        action: 'tool',
        tool: toolName,
        params: toolParams,
        reasoning: message.content,
      };
    }

    // Check if the model is delegating
    if (message.content && message.content.includes('[DELEGATE:')) {
      const match = message.content.match(/\[DELEGATE:(\w+)\](.*?)\[\/DELEGATE\]/s);
      if (match) {
        return {
          action: 'delegate',
          targetAgent: match[1],
          subtask: JSON.parse(match[2]),
          reasoning: message.content,
        };
      }
    }

    // Check if escalating
    if (message.content && message.content.includes('[ESCALATE]')) {
      const reason = message.content.replace('[ESCALATE]', '').trim();
      return {
        action: 'escalate',
        reason,
      };
    }

    // Check for completion markers
    if (choice.finish_reason === 'stop' ||
        (message.content && message.content.includes('[COMPLETE]'))) {

      // Try to extract structured result
      let result = message.content;

      // Look for JSON result
      const jsonMatch = message.content.match(/```json\n?([\s\S]*?)\n?```/);
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
      };
    }

    // Default: continue thinking (will be re-called)
    return {
      action: 'complete',
      result: message.content,
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
   * Build the system prompt
   */
  _buildSystemPrompt() {
    const toolDescriptions = this._getToolDescriptions();

    return `${this.llmConfig.systemPrompt}

## Available Tools
${toolDescriptions}

## Response Format
- Use the provided tools when you need external data or actions
- When delegating to another agent, use: [DELEGATE:agentName]{"task": "..."}[/DELEGATE]
- When escalating to human, use: [ESCALATE] reason for escalation
- When task is complete, respond with [COMPLETE] followed by your answer
- For structured data, wrap in \`\`\`json code blocks

## Current Context
- Date/Time: ${new Date().toISOString()}
- Agent ID: ${this.id}
- Agent Role: ${this.role}`;
  }

  /**
   * Format a task for the LLM
   */
  _formatTask(task) {
    if (typeof task === 'string') {
      return task;
    }

    return `Task Type: ${task.type || 'general'}
Task ID: ${task.id || 'N/A'}
Description: ${task.description || JSON.stringify(task)}
${task.context ? `Context: ${JSON.stringify(task.context)}` : ''}
${task.constraints ? `Constraints: ${JSON.stringify(task.constraints)}` : ''}`;
  }

  /**
   * Build tool definitions for OpenAI
   */
  _buildToolDefinitions() {
    this.toolDefinitions = [];

    for (const [name, tool] of this.tools) {
      // Skip MCP tools if they don't have schema
      const definition = {
        type: 'function',
        function: {
          name: name.replace(/:/g, '_'), // OpenAI doesn't like colons
          description: tool.schema.description || `Tool: ${name}`,
          parameters: tool.schema.inputSchema || tool.schema.parameters || {
            type: 'object',
            properties: {},
          },
        },
      };

      this.toolDefinitions.push(definition);

      // Map the clean name back to the original
      this._toolNameMap = this._toolNameMap || new Map();
      this._toolNameMap.set(name.replace(/:/g, '_'), name);
    }
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
    // Map back to original name if needed
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

    const response = await this.openai.chat.completions.create({
      model: options.model || this.llmConfig.model,
      messages,
      temperature: options.temperature || this.llmConfig.temperature,
      max_tokens: options.maxTokens || this.llmConfig.maxTokens,
    });

    return response.choices[0].message.content;
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

    const response = await this.openai.chat.completions.create({
      model: options.model || this.llmConfig.model,
      messages,
      response_format: { type: 'json_object' },
      temperature: options.temperature || 0.3,
      max_tokens: options.maxTokens || this.llmConfig.maxTokens,
    });

    return JSON.parse(response.choices[0].message.content);
  }
}

module.exports = { LLMAgent };
