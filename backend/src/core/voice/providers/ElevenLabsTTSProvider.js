/**
 * ElevenLabs Text-to-Speech Provider
 *
 * High-quality, natural-sounding TTS with voice cloning
 * Best for: All languages, high-quality voice output
 */

const { TTSProvider } = require('../VoiceProvider');
const { withTimeout, RetryPolicy, circuitBreakerRegistry } = require('../../resilience');
const { ExternalServiceError, TimeoutError, ValidationError } = require('../../errors');

class ElevenLabsTTSProvider extends TTSProvider {
  constructor(options = {}) {
    super({
      name: 'elevenlabs',
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'hi', 'ar', 'zh', 'ja', 'ko'],
      outputFormats: ['mp3', 'pcm16', 'ulaw'],
      defaultSampleRate: 24000,
      ...options,
    });

    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
    this.defaultVoiceId = options.voiceId || process.env.ELEVENLABS_VOICE_ID;
    this.baseUrl = options.baseUrl || 'https://api.elevenlabs.io/v1';
    this.logger = options.logger || console;

    // Output format mappings
    this.formatMap = {
      'pcm16': 'pcm_24000',
      'pcm_16000': 'pcm_16000',
      'pcm_24000': 'pcm_24000',
      'pcm_44100': 'pcm_44100',
      'mp3': 'mp3_44100_128',
      'ulaw': 'ulaw_8000',
    };

    // Circuit breaker
    this.circuitBreaker = circuitBreakerRegistry.getOrCreate('elevenlabs-tts', {
      failureThreshold: 5,
      timeout: 30000,
      onStateChange: ({ name, from, to }) => {
        this.logger.warn({ name, from, to }, 'ElevenLabs circuit breaker state change');
      },
    });

    // Retry policy
    this.retry = new RetryPolicy({
      maxAttempts: 3,
      baseDelayMs: 500,
      onRetry: ({ error, attempt }) => {
        this.logger.warn({ error: error.message, attempt }, 'ElevenLabs retry');
      },
    });

    // Voice cache
    this.voiceCache = null;
    this.voiceCacheTime = 0;
    this.voiceCacheTTL = 3600000; // 1 hour
  }

  async init() {
    if (!this.apiKey) {
      this.logger.warn('ElevenLabs API key not configured - provider will be unavailable');
      return;
    }
    this.logger.info({ provider: this.name }, 'ElevenLabs TTS provider initialized');
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
      throw new ExternalServiceError('ElevenLabs', 'API key not configured');
    }

    // Return cached voices if still valid
    if (this.voiceCache && Date.now() - this.voiceCacheTime < this.voiceCacheTTL) {
      return this.voiceCache;
    }

    const startTime = Date.now();

    try {
      const response = await withTimeout(
        () => fetch(`${this.baseUrl}/voices`, {
          headers: { 'xi-api-key': this.apiKey },
        }),
        10000,
        'ElevenLabs get voices'
      );

      if (!response.ok) {
        throw new Error(`Failed to get voices: ${response.status}`);
      }

      const data = await response.json();
      this.voiceCache = data.voices.map(v => ({
        id: v.voice_id,
        name: v.name,
        category: v.category,
        labels: v.labels,
        preview: v.preview_url,
      }));
      this.voiceCacheTime = Date.now();

      this._recordRequest(Date.now() - startTime);
      return this.voiceCache;
    } catch (error) {
      this._recordRequest(Date.now() - startTime, 0, true);
      throw new ExternalServiceError('ElevenLabs', error.message, {
        originalError: error,
      });
    }
  }

  /**
   * Synthesize text to audio (batch mode)
   */
  async synthesize(text, options = {}) {
    if (!this.apiKey) {
      throw new ExternalServiceError('ElevenLabs', 'API key not configured');
    }

    if (!text || text.trim().length === 0) {
      throw new ValidationError('Text is required for synthesis');
    }

    const voiceId = options.voiceId || this.defaultVoiceId;
    if (!voiceId) {
      throw new ValidationError('Voice ID is required');
    }

    const startTime = Date.now();
    const outputFormat = this.formatMap[options.format] || this.formatMap['pcm16'];

    try {
      const result = await this.circuitBreaker.execute(async () => {
        return await this.retry.execute(async () => {
          return await withTimeout(
            () => this._synthesizeText(text, voiceId, outputFormat, options),
            options.timeout || 30000,
            'ElevenLabs synthesis'
          );
        });
      });

      const latency = Date.now() - startTime;
      this._recordRequest(latency, result.length);

      return result;
    } catch (error) {
      this._recordRequest(Date.now() - startTime, 0, true);
      throw new ExternalServiceError('ElevenLabs', error.message, {
        originalError: error,
        isRetryable: error instanceof TimeoutError,
      });
    }
  }

  async _synthesizeText(text, voiceId, outputFormat, options) {
    const url = `${this.baseUrl}/text-to-speech/${voiceId}?output_format=${outputFormat}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: options.modelId || 'eleven_multilingual_v2',
        voice_settings: {
          stability: options.stability ?? 0.5,
          similarity_boost: options.similarityBoost ?? 0.75,
          style: options.style ?? 0,
          use_speaker_boost: options.speakerBoost ?? true,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs synthesis failed: ${response.status} - ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Stream synthesized audio
   */
  async *synthesizeStream(text, options = {}) {
    if (!this.apiKey) {
      throw new ExternalServiceError('ElevenLabs', 'API key not configured');
    }

    if (!text || text.trim().length === 0) {
      return;
    }

    const voiceId = options.voiceId || this.defaultVoiceId;
    if (!voiceId) {
      throw new ValidationError('Voice ID is required');
    }

    const outputFormat = this.formatMap[options.format] || this.formatMap['pcm16'];
    const url = `${this.baseUrl}/text-to-speech/${voiceId}/stream?output_format=${outputFormat}&optimize_streaming_latency=${options.optimizeLatency || 3}`;

    const startTime = Date.now();
    let totalBytes = 0;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: options.modelId || 'eleven_multilingual_v2',
          voice_settings: {
            stability: options.stability ?? 0.5,
            similarity_boost: options.similarityBoost ?? 0.75,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs streaming failed: ${response.status} - ${errorText}`);
      }

      const reader = response.body.getReader();
      let headerSkipped = false;
      let headerBuffer = Buffer.alloc(0);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        let chunk = Buffer.from(value);
        totalBytes += chunk.length;

        // Skip WAV header if present (for PCM formats)
        if (!headerSkipped && outputFormat.startsWith('pcm')) {
          headerBuffer = Buffer.concat([headerBuffer, chunk]);

          // Look for 'data' marker in WAV header
          const dataIndex = headerBuffer.indexOf('data');
          if (dataIndex !== -1 && headerBuffer.length >= dataIndex + 8) {
            // Skip past 'data' marker and size (8 bytes total)
            chunk = headerBuffer.slice(dataIndex + 8);
            headerSkipped = true;
          } else if (headerBuffer.length < 100) {
            // Still accumulating header
            continue;
          } else {
            // No WAV header found, emit as-is
            chunk = headerBuffer;
            headerSkipped = true;
          }
        }

        if (chunk.length > 0) {
          yield chunk;
        }
      }

      this._recordRequest(Date.now() - startTime, totalBytes);
    } catch (error) {
      this._recordRequest(Date.now() - startTime, totalBytes, true);
      throw new ExternalServiceError('ElevenLabs', error.message, {
        originalError: error,
      });
    }
  }

  async healthCheck() {
    const baseHealth = await super.healthCheck();

    return {
      ...baseHealth,
      details: {
        defaultVoiceId: this.defaultVoiceId,
        circuitBreaker: this.circuitBreaker.getState(),
        hasApiKey: !!this.apiKey,
        voicesCached: !!this.voiceCache,
      },
    };
  }
}

module.exports = ElevenLabsTTSProvider;
