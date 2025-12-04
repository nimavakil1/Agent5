/**
 * OpenAI Provider
 *
 * Supports OpenAI models:
 * - gpt-5.1 - Latest, adaptive reasoning
 * - gpt-4o - Fast, multimodal
 * - gpt-4o-mini - Cheap, fast for simple tasks
 */

const OpenAI = require('openai');
const { LLMProvider } = require('./LLMProvider');

// Model aliases
const MODEL_ALIASES = {
  'gpt5': 'gpt-5.1',
  'gpt-5': 'gpt-5.1',
  'gpt4o': 'gpt-4o',
  'gpt4': 'gpt-4o',
  'mini': 'gpt-4o-mini',
};

class OpenAIProvider extends LLMProvider {
  constructor(config = {}) {
    super({ ...config, provider: 'openai' });

    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
    });

    this.model = MODEL_ALIASES[config.model] || config.model || 'gpt-4o';
  }

  /**
   * Simple chat completion
   */
  async chat(messages, options = {}) {
    const response = await this.client.chat.completions.create({
      model: options.model || this.model,
      messages: this._formatMessages(messages),
      temperature: options.temperature ?? this.temperature,
      max_tokens: options.maxTokens || this.maxTokens,
    });

    const choice = response.choices[0];

    return {
      content: choice.message.content,
      thinking: null,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      stopReason: choice.finish_reason,
    };
  }

  /**
   * Chat with tool use
   */
  async chatWithTools(messages, tools, options = {}) {
    const formattedTools = this.formatToolsForProvider(tools);

    const response = await this.client.chat.completions.create({
      model: options.model || this.model,
      messages: this._formatMessages(messages),
      tools: formattedTools,
      tool_choice: formattedTools?.length > 0 ? 'auto' : undefined,
      temperature: options.temperature ?? this.temperature,
      max_tokens: options.maxTokens || this.maxTokens,
    });

    const choice = response.choices[0];
    const message = choice.message;

    // Extract tool call if any
    let toolCall = null;
    if (message.tool_calls && message.tool_calls.length > 0) {
      const tc = message.tool_calls[0];
      toolCall = {
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      };
    }

    return {
      content: message.content || '',
      thinking: null,
      toolCall,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      stopReason: choice.finish_reason,
    };
  }

  /**
   * Continue after tool execution
   */
  async continueWithToolResult(messages, toolCallId, toolResult, tools, options = {}) {
    // Add tool result to messages
    const messagesWithResult = [
      ...this._formatMessages(messages),
      {
        role: 'tool',
        tool_call_id: toolCallId,
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
      },
    ];

    const formattedTools = this.formatToolsForProvider(tools);

    const response = await this.client.chat.completions.create({
      model: options.model || this.model,
      messages: messagesWithResult,
      tools: formattedTools,
      tool_choice: formattedTools?.length > 0 ? 'auto' : undefined,
      temperature: options.temperature ?? this.temperature,
      max_tokens: options.maxTokens || this.maxTokens,
    });

    const choice = response.choices[0];
    const message = choice.message;

    let toolCall = null;
    if (message.tool_calls && message.tool_calls.length > 0) {
      const tc = message.tool_calls[0];
      toolCall = {
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      };
    }

    return {
      content: message.content || '',
      thinking: null,
      toolCall,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      stopReason: choice.finish_reason,
    };
  }

  /**
   * Format tools for OpenAI API
   */
  formatToolsForProvider(tools) {
    if (!tools || tools.length === 0) return undefined;

    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name.replace(/:/g, '_'),
        description: tool.description,
        parameters: tool.inputSchema || tool.parameters || {
          type: 'object',
          properties: {},
        },
      },
    }));
  }

  /**
   * Format messages for OpenAI API
   */
  _formatMessages(messages) {
    return messages.map(msg => {
      // Handle tool calls from assistant
      if (msg.role === 'assistant' && msg.toolCall) {
        return {
          role: 'assistant',
          content: msg.content || null,
          tool_calls: [{
            id: msg.toolCall.id,
            type: 'function',
            function: {
              name: msg.toolCall.name,
              arguments: JSON.stringify(msg.toolCall.input),
            },
          }],
        };
      }

      // Handle tool results
      if (msg.role === 'tool' || msg.toolResult) {
        return {
          role: 'tool',
          tool_call_id: msg.toolResult?.id || msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        };
      }

      return {
        role: msg.role,
        content: msg.content,
      };
    });
  }
}

module.exports = { OpenAIProvider, MODEL_ALIASES };
