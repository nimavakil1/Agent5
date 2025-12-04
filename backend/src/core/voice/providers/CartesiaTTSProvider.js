/**
 * Cartesia Text-to-Speech Provider
 *
 * Ultra-low latency TTS with streaming support
 * Best for: Real-time conversations, cost-effective backup
 */

const WebSocket = require('ws');
const { TTSProvider } = require('../VoiceProvider');
const { withTimeout, RetryPolicy, circuitBreakerRegistry } = require('../../resilience');
const { ExternalServiceError, TimeoutError, ValidationError } = require('../../errors');

class CartesiaTTSProvider extends TTSProvider {
  constructor(options = {}) {
    super({
      name: 'cartesia',
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'zh', 'ko'],
      outputFormats: ['pcm16', 'mp3'],
      defaultSampleRate: 24000,
      ...options,
    });

    this.apiKey = options.apiKey || process.env.CARTESIA_API_KEY;
    this.defaultVoiceId = options.voiceId || process.env.CARTESIA_VOICE_ID;
    this.baseUrl = options.baseUrl || 'https://api.cartesia.ai';
    this.wsUrl = options.wsUrl || 'wss://api.cartesia.ai/tts/websocket';
    this.logger = options.logger || console;

    // Model configuration
    this.model = options.model || 'sonic-english';

    // Circuit breaker
    this.circuitBreaker = circuitBreakerRegistry.getOrCreate('cartesia-tts', {
      failureThreshold: 5,
      timeout: 30000,
      onStateChange: ({ name, from, to }) => {
        this.logger.warn({ name, from, to }, 'Cartesia circuit breaker state change');
      },
    });

    // Retry policy
    this.retry = new RetryPolicy({
      maxAttempts: 3,
      baseDelayMs: 300,
      onRetry: ({ error, attempt }) => {
        this.logger.warn({ error: error.message, attempt }, 'Cartesia retry');
      },
    });

    // Voice cache
    this.voiceCache = null;
    this.voiceCacheTime = 0;
    this.voiceCacheTTL = 3600000;
  }

  async init() {
    if (!this.apiKey) {
      this.logger.warn('Cartesia API key not configured - provider will be unavailable');
      return;
    }
    this.logger.info({ provider: this.name, model: this.model }, 'Cartesia TTS provider initialized');
  }

  async connect() {
    return true;
  }

  async disconnect() {
    this.isConnected = false;
  }

  /**
   * Get available voices
   */
  async getVoices() {
    if (!this.apiKey) {
      throw new ExternalServiceError('Cartesia', 'API key not configured');
    }

    if (this.voiceCache && Date.now() - this.voiceCacheTime < this.voiceCacheTTL) {
      return this.voiceCache;
    }

    const startTime = Date.now();

    try {
      const response = await withTimeout(
        () => fetch(`${this.baseUrl}/voices`, {
          headers: {
            'X-API-Key': this.apiKey,
            'Cartesia-Version': '2024-06-10',
          },
        }),
        10000,
        'Cartesia get voices'
      );

      if (!response.ok) {
        throw new Error(`Failed to get voices: ${response.status}`);
      }

      const data = await response.json();
      this.voiceCache = data.map(v => ({
        id: v.id,
        name: v.name,
        description: v.description,
        language: v.language,
        isPublic: v.is_public,
      }));
      this.voiceCacheTime = Date.now();

      this._recordRequest(Date.now() - startTime);
      return this.voiceCache;
    } catch (error) {
      this._recordRequest(Date.now() - startTime, 0, true);
      throw new ExternalServiceError('Cartesia', error.message, {
        originalError: error,
      });
    }
  }

  /**
   * Synthesize text to audio (batch mode)
   */
  async synthesize(text, options = {}) {
    if (!this.apiKey) {
      throw new ExternalServiceError('Cartesia', 'API key not configured');
    }

    if (!text || text.trim().length === 0) {
      throw new ValidationError('Text is required for synthesis');
    }

    const voiceId = options.voiceId || this.defaultVoiceId;
    if (!voiceId) {
      throw new ValidationError('Voice ID is required');
    }

    const startTime = Date.now();

    try {
      const result = await this.circuitBreaker.execute(async () => {
        return await this.retry.execute(async () => {
          return await withTimeout(
            () => this._synthesizeText(text, voiceId, options),
            options.timeout || 30000,
            'Cartesia synthesis'
          );
        });
      });

      const latency = Date.now() - startTime;
      this._recordRequest(latency, result.length);

      return result;
    } catch (error) {
      this._recordRequest(Date.now() - startTime, 0, true);
      throw new ExternalServiceError('Cartesia', error.message, {
        originalError: error,
        isRetryable: error instanceof TimeoutError,
      });
    }
  }

  async _synthesizeText(text, voiceId, options) {
    const response = await fetch(`${this.baseUrl}/tts/bytes`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Cartesia-Version': '2024-06-10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: options.model || this.model,
        transcript: text,
        voice: {
          mode: 'id',
          id: voiceId,
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: options.sampleRate || 24000,
        },
        language: options.language || 'en',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cartesia synthesis failed: ${response.status} - ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Stream synthesized audio via WebSocket
   */
  async *synthesizeStream(text, options = {}) {
    if (!this.apiKey) {
      throw new ExternalServiceError('Cartesia', 'API key not configured');
    }

    if (!text || text.trim().length === 0) {
      return;
    }

    const voiceId = options.voiceId || this.defaultVoiceId;
    if (!voiceId) {
      throw new ValidationError('Voice ID is required');
    }

    const startTime = Date.now();
    let totalBytes = 0;

    const audioChunks = [];
    let resolveNext = null;
    let isDone = false;
    let error = null;

    const ws = new WebSocket(`${this.wsUrl}?api_key=${this.apiKey}&cartesia_version=2024-06-10`);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        model_id: options.model || this.model,
        transcript: text,
        voice: {
          mode: 'id',
          id: voiceId,
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: options.sampleRate || 24000,
        },
        language: options.language || 'en',
        context_id: options.contextId || `ctx_${Date.now()}`,
      }));
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'chunk' && message.data) {
          const chunk = Buffer.from(message.data, 'base64');
          totalBytes += chunk.length;
          audioChunks.push(chunk);

          if (resolveNext) {
            const resolve = resolveNext;
            resolveNext = null;
            resolve();
          }
        } else if (message.type === 'done') {
          isDone = true;
          if (resolveNext) {
            const resolve = resolveNext;
            resolveNext = null;
            resolve();
          }
        } else if (message.type === 'error') {
          error = new Error(message.error || 'Unknown Cartesia error');
          if (resolveNext) {
            const resolve = resolveNext;
            resolveNext = null;
            resolve();
          }
        }
      } catch (e) {
        this.logger.error({ error: e.message }, 'Failed to parse Cartesia message');
      }
    });

    ws.on('error', (e) => {
      error = e;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve();
      }
    });

    ws.on('close', () => {
      isDone = true;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve();
      }
    });

    try {
      while (!isDone || audioChunks.length > 0) {
        if (error) {
          throw error;
        }

        if (audioChunks.length > 0) {
          yield audioChunks.shift();
        } else if (!isDone) {
          await new Promise(resolve => {
            resolveNext = resolve;
          });
        }
      }

      this._recordRequest(Date.now() - startTime, totalBytes);
    } catch (e) {
      this._recordRequest(Date.now() - startTime, totalBytes, true);
      throw new ExternalServiceError('Cartesia', e.message, {
        originalError: e,
      });
    } finally {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  }

  async healthCheck() {
    const baseHealth = await super.healthCheck();

    return {
      ...baseHealth,
      details: {
        model: this.model,
        defaultVoiceId: this.defaultVoiceId,
        circuitBreaker: this.circuitBreaker.getState(),
        hasApiKey: !!this.apiKey,
      },
    };
  }
}

module.exports = CartesiaTTSProvider;
