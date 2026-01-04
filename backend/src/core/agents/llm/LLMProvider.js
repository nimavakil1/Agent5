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

  async chat(_messages, _options = {}) {
    throw new Error('chat() must be implemented by subclass');
  }

  async chatWithTools(_messages, _tools, _options = {}) {
    throw new Error('chatWithTools() must be implemented by subclass');
  }

  formatToolsForProvider(_tools) {
    throw new Error('formatToolsForProvider() must be implemented by subclass');
  }
}

module.exports = { LLMProvider };
