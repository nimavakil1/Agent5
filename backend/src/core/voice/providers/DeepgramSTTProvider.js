/**
 * Deepgram Speech-to-Text Provider
 *
 * High-accuracy, low-latency STT using Deepgram Nova-2
 * Best for: All languages, streaming transcription
 */

const WebSocket = require('ws');
const { STTProvider } = require('../VoiceProvider');
const { withTimeout, RetryPolicy, circuitBreakerRegistry } = require('../../resilience');
const { ExternalServiceError, TimeoutError } = require('../../errors');

class DeepgramSTTProvider extends STTProvider {
  constructor(options = {}) {
    super({
      name: 'deepgram',
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ja', 'ko', 'zh', 'ru', 'ar', 'hi'],
      supportedFormats: ['pcm16', 'wav', 'mp3', 'ogg', 'flac'],
      sampleRates: [8000, 16000, 24000, 48000],
      ...options,
    });

    this.apiKey = options.apiKey || process.env.DEEPGRAM_API_KEY;
    this.model = options.model || 'nova-2';
    this.baseUrl = options.baseUrl || 'wss://api.deepgram.com/v1/listen';
    this.restUrl = options.restUrl || 'https://api.deepgram.com/v1/listen';
    this.logger = options.logger || console;

    // Circuit breaker for API calls
    this.circuitBreaker = circuitBreakerRegistry.getOrCreate('deepgram-stt', {
      failureThreshold: 5,
      timeout: 30000,
      onStateChange: ({ name, from, to }) => {
        this.logger.warn({ name, from, to }, 'Deepgram circuit breaker state change');
      },
    });

    // Retry policy
    this.retry = new RetryPolicy({
      maxAttempts: 3,
      baseDelayMs: 500,
      onRetry: ({ error, attempt }) => {
        this.logger.warn({ error: error.message, attempt }, 'Deepgram retry');
      },
    });
  }

  async init() {
    if (!this.apiKey) {
      this.logger.warn('Deepgram API key not configured - provider will be unavailable');
      return;
    }
    this.logger.info({ provider: this.name, model: this.model }, 'Deepgram STT provider initialized');
  }

  async connect() {
    // Connections are per-stream
    return true;
  }

  async disconnect() {
    this.isConnected = false;
  }

  /**
   * Transcribe audio buffer (batch mode)
   */
  async transcribe(audioBuffer, options = {}) {
    if (!this.apiKey) {
      throw new ExternalServiceError('Deepgram', 'API key not configured');
    }

    const startTime = Date.now();

    try {
      const result = await this.circuitBreaker.execute(async () => {
        return await this.retry.execute(async () => {
          return await withTimeout(
            () => this._transcribeBuffer(audioBuffer, options),
            options.timeout || 30000,
            'Deepgram transcription'
          );
        });
      });

      const latency = Date.now() - startTime;
      this._recordRequest(latency, audioBuffer.length);

      return result;
    } catch (error) {
      this._recordRequest(Date.now() - startTime, audioBuffer.length, true);
      throw new ExternalServiceError('Deepgram', error.message, {
        originalError: error,
        isRetryable: error instanceof TimeoutError,
      });
    }
  }

  async _transcribeBuffer(audioBuffer, options) {
    const queryParams = new URLSearchParams({
      model: options.model || this.model,
      language: options.language || 'en',
      punctuate: options.punctuate !== false ? 'true' : 'false',
      diarize: options.diarize ? 'true' : 'false',
      smart_format: options.smartFormat !== false ? 'true' : 'false',
    });

    if (options.keywords?.length > 0) {
      options.keywords.forEach(kw => queryParams.append('keywords', kw));
    }

    const response = await fetch(`${this.restUrl}?${queryParams}`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${this.apiKey}`,
        'Content-Type': options.contentType || 'audio/wav',
      },
      body: audioBuffer,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Deepgram API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const alternative = data.results?.channels?.[0]?.alternatives?.[0];

    return {
      text: alternative?.transcript || '',
      confidence: alternative?.confidence || 0,
      words: alternative?.words?.map(w => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence,
      })) || [],
      metadata: {
        duration: data.metadata?.duration,
        channels: data.metadata?.channels,
        model: data.metadata?.model_info?.name,
      },
    };
  }

  /**
   * Create a streaming transcription session
   */
  createStream(options = {}) {
    if (!this.apiKey) {
      throw new ExternalServiceError('Deepgram', 'API key not configured');
    }

    const queryParams = new URLSearchParams({
      model: options.model || this.model,
      language: options.language || 'en',
      punctuate: 'true',
      interim_results: options.interimResults !== false ? 'true' : 'false',
      utterance_end_ms: String(options.utteranceEndMs || 1000),
      vad_events: options.vadEvents ? 'true' : 'false',
      encoding: options.encoding || 'linear16',
      sample_rate: String(options.sampleRate || 16000),
      channels: String(options.channels || 1),
    });

    const wsUrl = `${this.baseUrl}?${queryParams}`;

    return new DeepgramStream(wsUrl, this.apiKey, {
      logger: this.logger,
      onStats: (latency, bytes, isError) => this._recordRequest(latency, bytes, isError),
    });
  }

  async healthCheck() {
    const baseHealth = await super.healthCheck();

    return {
      ...baseHealth,
      details: {
        model: this.model,
        circuitBreaker: this.circuitBreaker.getState(),
        hasApiKey: !!this.apiKey,
      },
    };
  }
}

/**
 * Deepgram Streaming Session
 */
class DeepgramStream {
  constructor(url, apiKey, options = {}) {
    this.url = url;
    this.apiKey = apiKey;
    this.logger = options.logger || console;
    this.onStats = options.onStats || (() => {});

    this.ws = null;
    this.isConnected = false;
    this.startTime = Date.now();
    this.bytesWritten = 0;

    // Event callbacks
    this.onTranscript = null;
    this.onUtteranceEnd = null;
    this.onError = null;
    this.onClose = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, {
        headers: {
          'Authorization': `Token ${this.apiKey}`,
        },
      });

      const timeout = setTimeout(() => {
        this.ws.close();
        reject(new TimeoutError('Deepgram stream connection', 10000));
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.logger.debug('Deepgram stream connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this._handleMessage(message);
        } catch (error) {
          this.logger.error({ error: error.message }, 'Failed to parse Deepgram message');
        }
      });

      this.ws.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error({ error: error.message }, 'Deepgram stream error');
        if (this.onError) this.onError(error);
        if (!this.isConnected) reject(error);
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        this.isConnected = false;
        const latency = Date.now() - this.startTime;
        this.onStats(latency, this.bytesWritten, code !== 1000);
        if (this.onClose) this.onClose({ code, reason: reason?.toString() });
      });
    });
  }

  _handleMessage(message) {
    if (message.type === 'Results') {
      const alternative = message.channel?.alternatives?.[0];
      if (alternative && this.onTranscript) {
        this.onTranscript({
          text: alternative.transcript,
          confidence: alternative.confidence,
          isFinal: message.is_final,
          speechFinal: message.speech_final,
          words: alternative.words,
        });
      }
    } else if (message.type === 'UtteranceEnd') {
      if (this.onUtteranceEnd) this.onUtteranceEnd();
    } else if (message.type === 'Metadata') {
      this.logger.debug({ metadata: message }, 'Deepgram metadata received');
    } else if (message.type === 'Error') {
      this.logger.error({ error: message }, 'Deepgram stream error');
      if (this.onError) this.onError(new Error(message.description || 'Unknown error'));
    }
  }

  /**
   * Write audio data to the stream
   */
  write(audioBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(audioBuffer);
      this.bytesWritten += audioBuffer.length;
      return true;
    }
    return false;
  }

  /**
   * End the stream (request final transcription)
   */
  end() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send close message to get final results
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
  }

  /**
   * Close the stream immediately
   */
  close() {
    if (this.ws) {
      this.ws.close(1000, 'Stream closed');
      this.ws = null;
    }
    this.isConnected = false;
  }
}

module.exports = DeepgramSTTProvider;
