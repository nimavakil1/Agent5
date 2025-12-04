/**
 * OpenAI Realtime API Provider
 *
 * Full voice-to-voice provider using OpenAI's Realtime API
 * Best for: English calls, low latency requirements
 */

const WebSocket = require('ws');
const { VoiceToVoiceProvider } = require('../VoiceProvider');
const { withTimeout, RetryPolicy } = require('../../resilience');
const { ExternalServiceError, TimeoutError } = require('../../errors');

class OpenAIRealtimeProvider extends VoiceToVoiceProvider {
  constructor(options = {}) {
    super({
      name: 'openai-realtime',
      languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'ko', 'zh'],
      supportsTurnDetection: true,
      supportsInterruption: true,
      ...options,
    });

    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    this.model = options.model || process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
    this.baseUrl = options.baseUrl || 'wss://api.openai.com/v1/realtime';
    this.sessionsUrl = options.sessionsUrl || 'https://api.openai.com/v1/realtime/sessions';

    this.ws = null;
    this.sessionId = null;
    this.logger = options.logger || console;

    // VAD settings
    this.turnDetection = {
      type: 'server_vad',
      threshold: options.vadThreshold || 0.5,
      prefixPaddingMs: options.vadPrefixMs || 300,
      silenceDurationMs: options.vadSilenceMs || 500,
    };

    // Retry policy for API calls
    this.retry = new RetryPolicy({
      maxAttempts: 3,
      baseDelayMs: 1000,
      onRetry: ({ error, attempt, delay }) => {
        this.logger.warn({ error: error.message, attempt, delay }, 'OpenAI API retry');
      },
    });

    // Connection state
    this.connectionTimeout = options.connectionTimeout || 10000;
    this.pingInterval = null;
    this.lastPong = null;
  }

  async init() {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required');
    }
    this.logger.info({ provider: this.name }, 'OpenAI Realtime provider initialized');
  }

  async connect() {
    // Connection happens per-session
    return true;
  }

  async disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.isConnected = false;
  }

  /**
   * Create a new OpenAI Realtime session
   */
  async createSession(options = {}) {
    const startTime = Date.now();

    try {
      // First, create a session token via REST API
      const sessionConfig = await this.retry.execute(async () => {
        return await withTimeout(
          () => this._createSessionToken(options),
          this.connectionTimeout,
          'OpenAI session creation'
        );
      });

      // Connect via WebSocket
      await this._connectWebSocket(sessionConfig, options);

      const latency = Date.now() - startTime;
      this._recordRequest(latency);

      this.logger.info({
        sessionId: this.sessionId,
        latency,
      }, 'OpenAI Realtime session created');

      return {
        sessionId: this.sessionId,
        provider: this.name,
        capabilities: {
          turnDetection: true,
          interruption: true,
          transcription: true,
        },
      };
    } catch (error) {
      this._recordRequest(Date.now() - startTime, 0, true);
      throw new ExternalServiceError('OpenAI Realtime', error.message, {
        originalError: error,
        isRetryable: error instanceof TimeoutError,
      });
    }
  }

  async _createSessionToken(options) {
    const response = await fetch(this.sessionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        modalities: options.modalities || ['text', 'audio'],
        instructions: options.instructions || '',
        voice: options.voice || 'alloy',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage;
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.error?.message || errorData.message || errorText;
      } catch {
        errorMessage = errorText;
      }
      throw new Error(`Session creation failed: ${response.status} - ${errorMessage}`);
    }

    return response.json();
  }

  async _connectWebSocket(sessionConfig, options) {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.baseUrl}?model=${this.model}`;

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      const timeout = setTimeout(() => {
        this.ws.close();
        reject(new TimeoutError('WebSocket connection', this.connectionTimeout));
      }, this.connectionTimeout);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.sessionId = sessionConfig.id || `session_${Date.now()}`;

        // Configure session
        this._sendMessage({
          type: 'session.update',
          session: {
            modalities: options.modalities || ['text', 'audio'],
            instructions: options.instructions || '',
            voice: options.voice || 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
              model: 'whisper-1',
              language: options.language || 'en',
            },
            turn_detection: this.turnDetection,
          },
        });

        // Setup ping/pong for connection health
        this._setupPingPong();

        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this._handleMessage(message);
        } catch (error) {
          this.logger.error({ error: error.message }, 'Failed to parse OpenAI message');
        }
      });

      this.ws.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error({ error: error.message }, 'OpenAI WebSocket error');
        this.emit('error', error);
        if (!this.isConnected) {
          reject(error);
        }
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        this.isConnected = false;
        this.logger.info({ code, reason: reason?.toString() }, 'OpenAI WebSocket closed');
        this.emit('disconnected', { code, reason: reason?.toString() });
      });
    });
  }

  _setupPingPong() {
    // Send ping every 30 seconds to keep connection alive
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);

    this.ws.on('pong', () => {
      this.lastPong = Date.now();
    });
  }

  _handleMessage(message) {
    switch (message.type) {
      case 'session.created':
        this.emit('session.created', message.session);
        break;

      case 'session.updated':
        this.emit('session.updated', message.session);
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speech.started');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.emit('speech.stopped');
        break;

      case 'conversation.item.input_audio_transcription.delta':
        this.emit('transcription.delta', { text: message.delta });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.emit('transcription.completed', { text: message.transcript });
        break;

      case 'response.audio.delta':
        if (message.delta) {
          const audioBuffer = Buffer.from(message.delta, 'base64');
          this.emit('audio', audioBuffer);
        }
        break;

      case 'response.audio_transcript.delta':
        this.emit('response.text.delta', { text: message.delta });
        break;

      case 'response.audio_transcript.done':
        this.emit('response.text.done', { text: message.transcript });
        break;

      case 'response.done':
        this.emit('response.done', message.response);
        break;

      case 'error':
        this.logger.error({ error: message.error }, 'OpenAI error');
        this.emit('error', new Error(message.error?.message || 'Unknown OpenAI error'));
        break;

      default:
        this.emit('message', message);
    }
  }

  _sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  /**
   * Send audio data to the session
   */
  sendAudio(audioBuffer) {
    if (!this.isConnected) {
      throw new Error('Not connected to OpenAI');
    }

    const base64Audio = audioBuffer.toString('base64');
    return this._sendMessage({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    });
  }

  /**
   * Commit audio buffer and trigger response
   */
  commitAudio() {
    return this._sendMessage({ type: 'input_audio_buffer.commit' });
  }

  /**
   * Send text message
   */
  sendText(text, options = {}) {
    return this._sendMessage({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: options.role || 'user',
        content: [{ type: 'input_text', text }],
      },
    });
  }

  /**
   * Request a response from the model
   */
  requestResponse(options = {}) {
    return this._sendMessage({
      type: 'response.create',
      response: options,
    });
  }

  /**
   * Interrupt/cancel current response
   */
  interrupt() {
    return this._sendMessage({ type: 'response.cancel' });
  }

  /**
   * Update session configuration
   */
  updateSession(config) {
    return this._sendMessage({
      type: 'session.update',
      session: config,
    });
  }

  /**
   * End the session
   */
  endSession() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Session ended');
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
  }

  async healthCheck() {
    const baseHealth = await super.healthCheck();

    return {
      ...baseHealth,
      details: {
        model: this.model,
        sessionId: this.sessionId,
        lastPong: this.lastPong,
        wsState: this.ws?.readyState,
      },
    };
  }
}

module.exports = OpenAIRealtimeProvider;
