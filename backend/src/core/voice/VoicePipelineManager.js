/**
 * Voice Pipeline Manager
 *
 * Orchestrates voice providers for optimal performance:
 * - Routes by language and cost requirements
 * - Provides fallback chains for resilience
 * - Manages hybrid pipelines (e.g., Deepgram STT + Claude + ElevenLabs TTS)
 */

const EventEmitter = require('events');
const OpenAIRealtimeProvider = require('./providers/OpenAIRealtimeProvider');
const DeepgramSTTProvider = require('./providers/DeepgramSTTProvider');
const ElevenLabsTTSProvider = require('./providers/ElevenLabsTTSProvider');
const CartesiaTTSProvider = require('./providers/CartesiaTTSProvider');

class VoicePipelineManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || console;

    // Provider registries by type
    this.sttProviders = new Map();
    this.ttsProviders = new Map();
    this.v2vProviders = new Map(); // Voice-to-voice

    // Default providers per language
    this.languageRouting = {
      // Language -> { stt, tts, v2v } provider names
      'en': { v2v: 'openai-realtime', stt: 'deepgram', tts: 'elevenlabs' },
      'es': { v2v: 'openai-realtime', stt: 'deepgram', tts: 'elevenlabs' },
      'fr': { stt: 'deepgram', tts: 'elevenlabs' },
      'de': { stt: 'deepgram', tts: 'elevenlabs' },
      'nl': { stt: 'deepgram', tts: 'elevenlabs' },
      'default': { v2v: 'openai-realtime', stt: 'deepgram', tts: 'elevenlabs' },
    };

    // Fallback chains
    this.fallbackChains = {
      stt: ['deepgram', 'openai-realtime'],
      tts: ['elevenlabs', 'cartesia', 'openai-realtime'],
      v2v: ['openai-realtime'],
    };

    // Pipeline modes
    this.pipelineModes = {
      'realtime': 'v2v', // Use voice-to-voice for lowest latency
      'quality': 'hybrid', // Use separate STT + LLM + TTS for best quality
      'cost': 'hybrid', // Use cost-effective providers
    };

    // Statistics
    this.stats = {
      totalRequests: 0,
      byProvider: {},
      byLanguage: {},
      fallbacksUsed: 0,
    };
  }

  /**
   * Initialize all providers
   */
  async init() {
    this.logger.info('Initializing Voice Pipeline Manager...');

    // Initialize STT providers
    const deepgram = new DeepgramSTTProvider({ logger: this.logger });
    await deepgram.init();
    this.sttProviders.set('deepgram', deepgram);

    // Initialize TTS providers
    const elevenlabs = new ElevenLabsTTSProvider({ logger: this.logger });
    await elevenlabs.init();
    this.ttsProviders.set('elevenlabs', elevenlabs);

    const cartesia = new CartesiaTTSProvider({ logger: this.logger });
    await cartesia.init();
    this.ttsProviders.set('cartesia', cartesia);

    // Initialize V2V providers
    const openaiRealtime = new OpenAIRealtimeProvider({ logger: this.logger });
    await openaiRealtime.init();
    this.v2vProviders.set('openai-realtime', openaiRealtime);

    this.logger.info({
      stt: Array.from(this.sttProviders.keys()),
      tts: Array.from(this.ttsProviders.keys()),
      v2v: Array.from(this.v2vProviders.keys()),
    }, 'Voice Pipeline Manager initialized');
  }

  /**
   * Get the best provider for a request
   */
  getProvider(type, options = {}) {
    const { language = 'en', preferredProvider, mode = 'realtime' } = options;

    let providerName;
    let registry;

    switch (type) {
      case 'stt':
        registry = this.sttProviders;
        break;
      case 'tts':
        registry = this.ttsProviders;
        break;
      case 'v2v':
        registry = this.v2vProviders;
        break;
      default:
        throw new Error(`Unknown provider type: ${type}`);
    }

    // Try preferred provider first
    if (preferredProvider && registry.has(preferredProvider)) {
      return registry.get(preferredProvider);
    }

    // Check language-specific routing
    const routing = this.languageRouting[language] || this.languageRouting['default'];
    providerName = routing[type];

    if (providerName && registry.has(providerName)) {
      const provider = registry.get(providerName);
      if (provider.supportsLanguage(language)) {
        return provider;
      }
    }

    // Fallback chain
    const fallbackChain = this.fallbackChains[type] || [];
    for (const name of fallbackChain) {
      if (registry.has(name)) {
        const provider = registry.get(name);
        if (provider.supportsLanguage(language)) {
          this.stats.fallbacksUsed++;
          this.logger.debug({ type, language, provider: name }, 'Using fallback provider');
          return provider;
        }
      }
    }

    throw new Error(`No ${type} provider available for language: ${language}`);
  }

  /**
   * Create a voice conversation session
   * Returns appropriate pipeline based on language and mode
   */
  async createSession(options = {}) {
    const {
      language = 'en',
      mode = 'realtime',
      instructions = '',
      voice = 'alloy',
    } = options;

    this.stats.totalRequests++;
    this.stats.byLanguage[language] = (this.stats.byLanguage[language] || 0) + 1;

    // For realtime mode, try to use V2V provider
    if (mode === 'realtime') {
      try {
        const v2vProvider = this.getProvider('v2v', { language, mode });

        this.logger.info({
          provider: v2vProvider.name,
          language,
          mode,
        }, 'Creating V2V session');

        const session = await v2vProvider.createSession({
          instructions,
          voice,
          language,
          modalities: ['text', 'audio'],
        });

        return {
          type: 'v2v',
          provider: v2vProvider,
          session,
          sendAudio: (buffer) => v2vProvider.sendAudio(buffer),
          sendText: (text) => v2vProvider.sendText(text),
          interrupt: () => v2vProvider.interrupt(),
          end: () => v2vProvider.endSession(),
        };
      } catch (error) {
        this.logger.warn({ error: error.message }, 'V2V provider failed, falling back to hybrid');
      }
    }

    // Hybrid mode: separate STT + TTS
    return this._createHybridSession(options);
  }

  /**
   * Create a hybrid pipeline session (STT + external LLM + TTS)
   */
  async _createHybridSession(options = {}) {
    const { language = 'en', voice } = options;

    const sttProvider = this.getProvider('stt', { language });
    const ttsProvider = this.getProvider('tts', { language });

    this.logger.info({
      stt: sttProvider.name,
      tts: ttsProvider.name,
      language,
    }, 'Creating hybrid session');

    // Create STT stream
    const sttStream = sttProvider.createStream({
      language,
      interimResults: true,
      utteranceEndMs: 1000,
    });

    await sttStream.connect();

    return {
      type: 'hybrid',
      sttProvider,
      ttsProvider,
      sttStream,

      /**
       * Send audio for transcription
       */
      sendAudio: (buffer) => {
        sttStream.write(buffer);
      },

      /**
       * Synthesize and stream TTS response
       */
      synthesize: async function*(text) {
        yield* ttsProvider.synthesizeStream(text, {
          voiceId: voice,
          language,
        });
      },

      /**
       * End the session
       */
      end: () => {
        sttStream.close();
      },
    };
  }

  /**
   * Transcribe audio using best available provider
   */
  async transcribe(audioBuffer, options = {}) {
    const provider = this.getProvider('stt', options);

    this.stats.totalRequests++;
    this.stats.byProvider[provider.name] = (this.stats.byProvider[provider.name] || 0) + 1;

    return provider.transcribe(audioBuffer, options);
  }

  /**
   * Synthesize text to speech using best available provider
   */
  async synthesize(text, options = {}) {
    const provider = this.getProvider('tts', options);

    this.stats.totalRequests++;
    this.stats.byProvider[provider.name] = (this.stats.byProvider[provider.name] || 0) + 1;

    return provider.synthesize(text, options);
  }

  /**
   * Stream synthesized audio
   */
  async *synthesizeStream(text, options = {}) {
    const provider = this.getProvider('tts', options);

    this.stats.totalRequests++;
    this.stats.byProvider[provider.name] = (this.stats.byProvider[provider.name] || 0) + 1;

    yield* provider.synthesizeStream(text, options);
  }

  /**
   * Get health status of all providers
   */
  async healthCheck() {
    const results = {
      status: 'healthy',
      providers: {
        stt: {},
        tts: {},
        v2v: {},
      },
    };

    // Check STT providers
    for (const [name, provider] of this.sttProviders) {
      try {
        const health = await provider.healthCheck();
        results.providers.stt[name] = health;
        if (health.status === 'unhealthy') {
          results.status = 'degraded';
        }
      } catch (error) {
        results.providers.stt[name] = { status: 'unhealthy', error: error.message };
        results.status = 'degraded';
      }
    }

    // Check TTS providers
    for (const [name, provider] of this.ttsProviders) {
      try {
        const health = await provider.healthCheck();
        results.providers.tts[name] = health;
        if (health.status === 'unhealthy') {
          results.status = 'degraded';
        }
      } catch (error) {
        results.providers.tts[name] = { status: 'unhealthy', error: error.message };
        results.status = 'degraded';
      }
    }

    // Check V2V providers
    for (const [name, provider] of this.v2vProviders) {
      try {
        const health = await provider.healthCheck();
        results.providers.v2v[name] = health;
        if (health.status === 'unhealthy') {
          results.status = 'degraded';
        }
      } catch (error) {
        results.providers.v2v[name] = { status: 'unhealthy', error: error.message };
        results.status = 'degraded';
      }
    }

    return results;
  }

  /**
   * Get statistics
   */
  getStats() {
    const allProviderStats = {};

    for (const [name, provider] of this.sttProviders) {
      allProviderStats[`stt:${name}`] = provider.getStats();
    }
    for (const [name, provider] of this.ttsProviders) {
      allProviderStats[`tts:${name}`] = provider.getStats();
    }
    for (const [name, provider] of this.v2vProviders) {
      allProviderStats[`v2v:${name}`] = provider.getStats();
    }

    return {
      ...this.stats,
      providerStats: allProviderStats,
    };
  }

  /**
   * Update language routing configuration
   */
  setLanguageRouting(language, routing) {
    this.languageRouting[language] = { ...this.languageRouting[language], ...routing };
  }

  /**
   * Shutdown all providers
   */
  async shutdown() {
    this.logger.info('Shutting down Voice Pipeline Manager...');

    for (const provider of this.sttProviders.values()) {
      await provider.disconnect();
    }
    for (const provider of this.ttsProviders.values()) {
      await provider.disconnect();
    }
    for (const provider of this.v2vProviders.values()) {
      await provider.disconnect();
    }
  }
}

// Singleton instance
let instance = null;

function getVoicePipelineManager(options = {}) {
  if (!instance) {
    instance = new VoicePipelineManager(options);
  }
  return instance;
}

module.exports = { VoicePipelineManager, getVoicePipelineManager };
