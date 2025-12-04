/**
 * LLM Provider Abstraction
 *
 * Unified interface for multiple LLM providers:
 * - Anthropic Claude (Opus 4.5, Sonnet, Haiku)
 * - OpenAI (GPT-5.1, GPT-4o)
 * - Google (Gemini 3 Pro)
 */

class LLMProvider {
  constructor(config = {}) {
    this.provider = config.provider || 'anthropic';
    this.model = config.model;
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens || 4096;
  }

  async chat(messages, options = {}) {
    throw new Error('chat() must be implemented by subclass');
  }

  async chatWithTools(messages, tools, options = {}) {
    throw new Error('chatWithTools() must be implemented by subclass');
  }

  formatToolsForProvider(tools) {
    throw new Error('formatToolsForProvider() must be implemented by subclass');
  }
}

module.exports = { LLMProvider };
