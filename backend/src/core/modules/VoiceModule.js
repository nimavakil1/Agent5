/**
 * Voice Module
 *
 * Platform module for AI-powered voice communications.
 * Integrates the hybrid voice pipeline with the platform.
 */

const { getVoicePipelineManager } = require('../voice');

class VoiceModule {
  constructor(options = {}) {
    this.name = 'voice';
    this.version = '2.0.0';
    this.platform = null;
    this.pipeline = null;
    this.logger = options.logger || console;
  }

  /**
   * Initialize the voice module
   */
  async init(platform) {
    this.platform = platform;
    this.logger = platform.logger.child({ module: this.name });

    this.logger.info('Initializing Voice Module...');

    // Get the voice pipeline manager
    this.pipeline = getVoicePipelineManager({ logger: this.logger });

    // Register with platform
    platform.registerService('voice-pipeline', this.pipeline, {
      version: this.version,
      healthCheck: () => this.pipeline.healthCheck(),
    });

    // Register voice providers with platform
    this._registerProviders(platform);

    this.logger.info('Voice Module initialized');
  }

  /**
   * Start the voice module
   */
  async start(platform) {
    this.logger.info('Starting Voice Module...');

    // Initialize the pipeline
    await this.pipeline.init();

    // Setup event handlers
    this._setupEventHandlers();

    this.logger.info('Voice Module started');
  }

  /**
   * Stop the voice module
   */
  async stop(platform) {
    this.logger.info('Stopping Voice Module...');

    if (this.pipeline) {
      await this.pipeline.shutdown();
    }

    this.logger.info('Voice Module stopped');
  }

  /**
   * Register voice providers with the platform
   */
  _registerProviders(platform) {
    // OpenAI Realtime (V2V)
    platform.registerProvider('voice-to-voice', 'openai-realtime', {
      getProvider: () => this.pipeline.getProvider('v2v', { preferredProvider: 'openai-realtime' }),
    }, {
      isDefault: true,
      priority: 1,
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ja', 'ko', 'zh'],
      capabilities: ['streaming', 'turn-detection', 'interruption'],
    });

    // Deepgram STT
    platform.registerProvider('stt', 'deepgram', {
      getProvider: () => this.pipeline.getProvider('stt', { preferredProvider: 'deepgram' }),
    }, {
      isDefault: true,
      priority: 1,
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ja', 'ko', 'zh', 'ru', 'ar', 'hi'],
      capabilities: ['streaming', 'batch', 'speaker-diarization'],
    });

    // ElevenLabs TTS
    platform.registerProvider('tts', 'elevenlabs', {
      getProvider: () => this.pipeline.getProvider('tts', { preferredProvider: 'elevenlabs' }),
    }, {
      isDefault: true,
      priority: 1,
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'hi', 'ar', 'zh', 'ja', 'ko'],
      capabilities: ['streaming', 'voice-cloning', 'emotion'],
    });

    // Cartesia TTS (fallback)
    platform.registerProvider('tts', 'cartesia', {
      getProvider: () => this.pipeline.getProvider('tts', { preferredProvider: 'cartesia' }),
    }, {
      isDefault: false,
      priority: 2,
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'zh', 'ko'],
      capabilities: ['streaming', 'low-latency'],
    });
  }

  /**
   * Setup event handlers for pipeline events
   */
  _setupEventHandlers() {
    // Log provider fallbacks
    this.pipeline.on('fallback', ({ type, from, to, reason }) => {
      this.logger.warn({ type, from, to, reason }, 'Voice provider fallback triggered');
    });
  }

  /**
   * Create a voice session
   */
  async createSession(options = {}) {
    return this.pipeline.createSession(options);
  }

  /**
   * Get pipeline statistics
   */
  getStats() {
    return this.pipeline.getStats();
  }

  /**
   * Health check
   */
  async healthCheck() {
    return this.pipeline.healthCheck();
  }
}

module.exports = VoiceModule;
