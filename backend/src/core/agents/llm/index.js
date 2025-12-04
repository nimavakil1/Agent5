/**
 * LLM Provider Factory
 *
 * Creates the appropriate LLM provider based on configuration
 */

const { LLMProvider } = require('./LLMProvider');
const { AnthropicProvider, MODEL_ALIASES: ANTHROPIC_MODELS } = require('./AnthropicProvider');
const { OpenAIProvider, MODEL_ALIASES: OPENAI_MODELS } = require('./OpenAIProvider');

/**
 * Create an LLM provider instance
 *
 * @param {Object} config Configuration options
 * @param {string} config.provider - 'anthropic' | 'openai' | 'auto'
 * @param {string} config.model - Model name or alias
 * @param {number} config.temperature - Temperature for generation
 * @param {number} config.maxTokens - Max tokens for response
 * @param {boolean} config.useExtendedThinking - Enable Claude extended thinking
 */
function createLLMProvider(config = {}) {
  const provider = config.provider || detectProvider(config.model);

  switch (provider) {
    case 'anthropic':
    case 'claude':
      return new AnthropicProvider(config);

    case 'openai':
    case 'gpt':
      return new OpenAIProvider(config);

    default:
      // Default to Anthropic Claude Opus 4.5
      return new AnthropicProvider({
        ...config,
        model: config.model || 'opus',
      });
  }
}

/**
 * Detect provider from model name
 */
function detectProvider(model) {
  if (!model) return 'anthropic';

  const lowerModel = model.toLowerCase();

  // Anthropic models
  if (lowerModel.includes('claude') ||
      lowerModel.includes('opus') ||
      lowerModel.includes('sonnet') ||
      lowerModel.includes('haiku')) {
    return 'anthropic';
  }

  // OpenAI models
  if (lowerModel.includes('gpt') ||
      lowerModel.includes('o1') ||
      lowerModel.includes('openai')) {
    return 'openai';
  }

  // Default to Anthropic
  return 'anthropic';
}

/**
 * Get recommended model for task type
 */
function getRecommendedModel(taskType) {
  const recommendations = {
    // Strategic, complex reasoning
    'strategic': { provider: 'anthropic', model: 'opus', useExtendedThinking: true },
    'complex': { provider: 'anthropic', model: 'opus', useExtendedThinking: true },
    'manager': { provider: 'anthropic', model: 'opus', useExtendedThinking: true },
    'ceo': { provider: 'anthropic', model: 'opus', useExtendedThinking: true },

    // Finance, structured data
    'finance': { provider: 'anthropic', model: 'opus' },
    'invoices': { provider: 'anthropic', model: 'opus' },
    'analysis': { provider: 'anthropic', model: 'opus' },

    // Standard tasks
    'general': { provider: 'anthropic', model: 'sonnet' },
    'default': { provider: 'anthropic', model: 'sonnet' },

    // Fast, simple queries
    'simple': { provider: 'anthropic', model: 'haiku' },
    'quick': { provider: 'anthropic', model: 'haiku' },
    'lookup': { provider: 'anthropic', model: 'haiku' },

    // Code tasks (can use OpenAI if preferred)
    'code': { provider: 'openai', model: 'gpt-4o' },
    'coding': { provider: 'openai', model: 'gpt-4o' },
  };

  return recommendations[taskType] || recommendations['default'];
}

/**
 * All available models
 */
const AVAILABLE_MODELS = {
  anthropic: {
    'claude-opus-4-5-20251101': {
      name: 'Claude Opus 4.5',
      description: 'Best for complex reasoning, agentic tasks',
      inputCost: 5,   // per million tokens
      outputCost: 25,
      contextWindow: 200000,
      capabilities: ['extended-thinking', 'tool-use', 'vision'],
    },
    'claude-sonnet-4-20250514': {
      name: 'Claude Sonnet 4',
      description: 'Balanced speed and quality',
      inputCost: 3,
      outputCost: 15,
      contextWindow: 200000,
      capabilities: ['tool-use', 'vision'],
    },
    'claude-haiku-3-5-20241022': {
      name: 'Claude Haiku 3.5',
      description: 'Fast, cheap for simple tasks',
      inputCost: 0.25,
      outputCost: 1.25,
      contextWindow: 200000,
      capabilities: ['tool-use', 'vision'],
    },
  },
  openai: {
    'gpt-5.1': {
      name: 'GPT-5.1',
      description: 'Latest OpenAI model with adaptive reasoning',
      inputCost: 2.50,
      outputCost: 10,
      contextWindow: 128000,
      capabilities: ['tool-use', 'vision', 'adaptive-reasoning'],
    },
    'gpt-4o': {
      name: 'GPT-4o',
      description: 'Fast multimodal model',
      inputCost: 2.50,
      outputCost: 10,
      contextWindow: 128000,
      capabilities: ['tool-use', 'vision'],
    },
    'gpt-4o-mini': {
      name: 'GPT-4o Mini',
      description: 'Cheap and fast',
      inputCost: 0.15,
      outputCost: 0.60,
      contextWindow: 128000,
      capabilities: ['tool-use'],
    },
  },
};

module.exports = {
  LLMProvider,
  AnthropicProvider,
  OpenAIProvider,
  createLLMProvider,
  detectProvider,
  getRecommendedModel,
  AVAILABLE_MODELS,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
};
