/**
 * Voice Provider Abstraction
 *
 * Defines the interface for voice providers (STT, TTS, Voice-to-Voice)
 * Allows hot-swapping between providers based on language, cost, quality requirements
 */

const EventEmitter = require('events');

/**
 * Base class for all voice providers
 */
class VoiceProvider extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name || 'unknown';
    this.type = options.type || 'unknown'; // stt, tts, voice-to-voice
    this.languages = options.languages || ['en'];
    this.isConnected = false;
    this.stats = {
      requests: 0,
      errors: 0,
      totalLatencyMs: 0,
      bytesProcessed: 0,
    };
  }

  /**
   * Initialize the provider
   */
  async init() {
    throw new Error('init() must be implemented by subclass');
  }

  /**
   * Connect to the provider service
   */
  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Disconnect from the provider service
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Check if provider supports a language
   */
  supportsLanguage(lang) {
    return this.languages.includes(lang) || this.languages.includes('*');
  }

  /**
   * Get provider health status
   */
  async healthCheck() {
    return {
      status: this.isConnected ? 'healthy' : 'unhealthy',
      name: this.name,
      type: this.type,
    };
  }

  /**
   * Get provider statistics
   */
  getStats() {
    return {
      ...this.stats,
      avgLatencyMs: this.stats.requests > 0
        ? Math.round(this.stats.totalLatencyMs / this.stats.requests)
        : 0,
      errorRate: this.stats.requests > 0
        ? (this.stats.errors / this.stats.requests * 100).toFixed(2) + '%'
        : '0%',
    };
  }

  /**
   * Record a request for statistics
   */
  _recordRequest(latencyMs, bytes = 0, isError = false) {
    this.stats.requests++;
    this.stats.totalLatencyMs += latencyMs;
    this.stats.bytesProcessed += bytes;
    if (isError) {
      this.stats.errors++;
    }
  }
}

/**
 * Speech-to-Text Provider Interface
 */
class STTProvider extends VoiceProvider {
  constructor(options = {}) {
    super({ ...options, type: 'stt' });
    this.supportedFormats = options.supportedFormats || ['pcm16', 'wav', 'mp3'];
    this.sampleRates = options.sampleRates || [8000, 16000, 24000, 48000];
  }

  /**
   * Transcribe audio buffer to text
   * @param {Buffer} audioBuffer - Audio data
   * @param {object} options - Transcription options
   * @returns {Promise<{text: string, confidence: number, words?: Array}>}
   */
  async transcribe(audioBuffer, options = {}) {
    throw new Error('transcribe() must be implemented by subclass');
  }

  /**
   * Start streaming transcription
   * @param {object} options - Stream options
   * @returns {object} Stream controller with write(), end() methods
   */
  createStream(options = {}) {
    throw new Error('createStream() must be implemented by subclass');
  }
}

/**
 * Text-to-Speech Provider Interface
 */
class TTSProvider extends VoiceProvider {
  constructor(options = {}) {
    super({ ...options, type: 'tts' });
    this.voices = options.voices || [];
    this.outputFormats = options.outputFormats || ['pcm16', 'mp3'];
    this.defaultSampleRate = options.defaultSampleRate || 24000;
  }

  /**
   * Get available voices
   * @returns {Promise<Array>} List of available voices
   */
  async getVoices() {
    throw new Error('getVoices() must be implemented by subclass');
  }

  /**
   * Synthesize text to audio
   * @param {string} text - Text to synthesize
   * @param {object} options - Synthesis options (voice, speed, etc.)
   * @returns {Promise<Buffer>} Audio buffer
   */
  async synthesize(text, options = {}) {
    throw new Error('synthesize() must be implemented by subclass');
  }

  /**
   * Stream synthesized audio
   * @param {string} text - Text to synthesize
   * @param {object} options - Synthesis options
   * @returns {AsyncGenerator<Buffer>} Audio chunks
   */
  async *synthesizeStream(text, options = {}) {
    throw new Error('synthesizeStream() must be implemented by subclass');
  }
}

/**
 * Voice-to-Voice (Real-time conversation) Provider Interface
 */
class VoiceToVoiceProvider extends VoiceProvider {
  constructor(options = {}) {
    super({ ...options, type: 'voice-to-voice' });
    this.supportsTurnDetection = options.supportsTurnDetection || false;
    this.supportsInterruption = options.supportsInterruption || false;
  }

  /**
   * Create a new conversation session
   * @param {object} options - Session options (instructions, voice, etc.)
   * @returns {Promise<object>} Session object
   */
  async createSession(options = {}) {
    throw new Error('createSession() must be implemented by subclass');
  }

  /**
   * Send audio to the session
   * @param {Buffer} audioBuffer - Audio data
   */
  sendAudio(audioBuffer) {
    throw new Error('sendAudio() must be implemented by subclass');
  }

  /**
   * Send text message to the session
   * @param {string} text - Text message
   */
  sendText(text) {
    throw new Error('sendText() must be implemented by subclass');
  }

  /**
   * Interrupt current response
   */
  interrupt() {
    throw new Error('interrupt() must be implemented by subclass');
  }

  /**
   * End the session
   */
  endSession() {
    throw new Error('endSession() must be implemented by subclass');
  }
}

module.exports = {
  VoiceProvider,
  STTProvider,
  TTSProvider,
  VoiceToVoiceProvider,
};
