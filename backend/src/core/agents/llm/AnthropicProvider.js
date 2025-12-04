/**
 * Anthropic Claude Provider
 *
 * Supports Claude models:
 * - claude-opus-4-5-20251101 (Opus 4.5) - Best for complex reasoning, agentic tasks
 * - claude-sonnet-4-20250514 (Sonnet 4) - Balanced speed/quality
 * - claude-haiku-3-5-20241022 (Haiku 3.5) - Fast, cheap for simple tasks
 */

const Anthropic = require('@anthropic-ai/sdk');
const { LLMProvider } = require('./LLMProvider');

// Model aliases for convenience
const MODEL_ALIASES = {
  'opus': 'claude-opus-4-5-20251101',
  'opus-4.5': 'claude-opus-4-5-20251101',
  'sonnet': 'claude-sonnet-4-20250514',
  'sonnet-4': 'claude-sonnet-4-20250514',
  'haiku': 'claude-haiku-3-5-20241022',
  'haiku-3.5': 'claude-haiku-3-5-20241022',
};

class AnthropicProvider extends LLMProvider {
  constructor(config = {}) {
    super({ ...config, provider: 'anthropic' });

    this.client = new Anthropic({
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
    });

    // Resolve model alias
    this.model = MODEL_ALIASES[config.model] || config.model || 'claude-opus-4-5-20251101';

    // Extended thinking for complex tasks (Opus only)
    this.useExtendedThinking = config.useExtendedThinking || false;
    this.thinkingBudget = config.thinkingBudget || 10000;
  }

  /**
   * Simple chat completion
   */
  async chat(messages, options = {}) {
    const systemMessage = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    const requestParams = {
      model: options.model || this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      messages: this._formatMessages(otherMessages),
    };

    if (systemMessage) {
      requestParams.system = systemMessage.content;
    }

    // Add extended thinking for complex tasks
    if (this.useExtendedThinking && this.model.includes('opus')) {
      requestParams.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingBudget,
      };
      // Extended thinking requires temperature = 1
      requestParams.temperature = 1;
    } else {
      requestParams.temperature = options.temperature ?? this.temperature;
    }

    const response = await this.client.messages.create(requestParams);

    return {
      content: this._extractContent(response),
      thinking: this._extractThinking(response),
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      },
      stopReason: response.stop_reason,
    };
  }

  /**
   * Chat with tool use
   */
  async chatWithTools(messages, tools, options = {}) {
    const systemMessage = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    const requestParams = {
      model: options.model || this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      messages: this._formatMessages(otherMessages),
      tools: this.formatToolsForProvider(tools),
    };

    if (systemMessage) {
      requestParams.system = systemMessage.content;
    }

    // Extended thinking with tools
    if (this.useExtendedThinking && this.model.includes('opus')) {
      requestParams.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingBudget,
      };
      requestParams.temperature = 1;
    } else {
      requestParams.temperature = options.temperature ?? this.temperature;
    }

    const response = await this.client.messages.create(requestParams);

    // Extract tool use if any
    const toolUseBlock = response.content.find(block => block.type === 'tool_use');

    return {
      content: this._extractContent(response),
      thinking: this._extractThinking(response),
      toolCall: toolUseBlock ? {
        id: toolUseBlock.id,
        name: toolUseBlock.name,
        input: toolUseBlock.input,
      } : null,
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      },
      stopReason: response.stop_reason,
    };
  }

  /**
   * Continue after tool execution
   */
  async continueWithToolResult(messages, toolCallId, toolResult, tools, options = {}) {
    const systemMessage = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    // Add tool result message
    const messagesWithResult = [
      ...this._formatMessages(otherMessages),
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
        }],
      },
    ];

    const requestParams = {
      model: options.model || this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      messages: messagesWithResult,
      tools: this.formatToolsForProvider(tools),
    };

    if (systemMessage) {
      requestParams.system = systemMessage.content;
    }

    if (this.useExtendedThinking && this.model.includes('opus')) {
      requestParams.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingBudget,
      };
      requestParams.temperature = 1;
    } else {
      requestParams.temperature = options.temperature ?? this.temperature;
    }

    const response = await this.client.messages.create(requestParams);

    const toolUseBlock = response.content.find(block => block.type === 'tool_use');

    return {
      content: this._extractContent(response),
      thinking: this._extractThinking(response),
      toolCall: toolUseBlock ? {
        id: toolUseBlock.id,
        name: toolUseBlock.name,
        input: toolUseBlock.input,
      } : null,
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      },
      stopReason: response.stop_reason,
    };
  }

  /**
   * Format tools for Anthropic API
   */
  formatToolsForProvider(tools) {
    if (!tools || tools.length === 0) return undefined;

    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema || tool.parameters || {
        type: 'object',
        properties: {},
      },
    }));
  }

  /**
   * Format messages for Anthropic API
   */
  _formatMessages(messages) {
    return messages.map(msg => {
      // Handle tool use messages from assistant
      if (msg.role === 'assistant' && msg.toolCall) {
        return {
          role: 'assistant',
          content: [
            ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
            {
              type: 'tool_use',
              id: msg.toolCall.id,
              name: msg.toolCall.name,
              input: msg.toolCall.input,
            },
          ],
        };
      }

      // Handle tool results from user
      if (msg.role === 'user' && msg.toolResult) {
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.toolResult.id,
            content: typeof msg.toolResult.content === 'string'
              ? msg.toolResult.content
              : JSON.stringify(msg.toolResult.content),
          }],
        };
      }

      // Standard message
      return {
        role: msg.role,
        content: msg.content,
      };
    });
  }

  /**
   * Extract text content from response
   */
  _extractContent(response) {
    const textBlocks = response.content.filter(block => block.type === 'text');
    return textBlocks.map(block => block.text).join('');
  }

  /**
   * Extract thinking content from response (extended thinking)
   */
  _extractThinking(response) {
    const thinkingBlocks = response.content.filter(block => block.type === 'thinking');
    if (thinkingBlocks.length === 0) return null;
    return thinkingBlocks.map(block => block.thinking).join('\n');
  }
}

module.exports = { AnthropicProvider, MODEL_ALIASES };
