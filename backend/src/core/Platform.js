/**
 * Agent5 Platform Core
 *
 * A modular, extensible platform for AI-powered customer engagement.
 * The voice call center is one module among many (messaging, email, analytics, etc.)
 */

const EventEmitter = require('events');
const pino = require('pino');

class Platform extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name || 'Agent5';
    this.version = options.version || '2.0.0';
    this.env = process.env.NODE_ENV || 'development';

    // Core registries
    this.services = new Map();
    this.modules = new Map();
    this.providers = new Map();
    this.middleware = [];
    this.healthChecks = new Map();

    // Platform state
    this.state = 'initializing';
    this.startedAt = null;
    this.shutdownHandlers = [];

    // Logger
    this.logger = pino({
      name: this.name,
      level: process.env.LOG_LEVEL || 'info',
      formatters: {
        level: (label) => ({ level: label }),
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'password',
          'apiKey',
          'secret',
          'token',
        ],
        remove: true,
      },
    });

    // Setup graceful shutdown
    this._setupShutdownHandlers();
  }

  /**
   * Register a service with the platform
   * @param {string} name - Service name
   * @param {object} service - Service instance
   * @param {object} options - Registration options
   */
  registerService(name, service, options = {}) {
    if (this.services.has(name)) {
      throw new Error(`Service '${name}' is already registered`);
    }

    const registration = {
      service,
      name,
      version: options.version || '1.0.0',
      dependencies: options.dependencies || [],
      healthCheck: options.healthCheck || null,
      priority: options.priority || 100,
      registeredAt: new Date(),
    };

    this.services.set(name, registration);

    if (options.healthCheck) {
      this.healthChecks.set(name, options.healthCheck);
    }

    this.logger.info({ service: name, version: registration.version }, 'Service registered');
    this.emit('service:registered', { name, service });

    return this;
  }

  /**
   * Get a registered service
   * @param {string} name - Service name
   * @returns {object} Service instance
   */
  getService(name) {
    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' not found`);
    }
    return registration.service;
  }

  /**
   * Check if a service is registered
   * @param {string} name - Service name
   * @returns {boolean}
   */
  hasService(name) {
    return this.services.has(name);
  }

  /**
   * Register a module (plugin) with the platform
   * @param {string} name - Module name
   * @param {object} module - Module instance implementing init/start/stop
   * @param {object} options - Registration options
   */
  async registerModule(name, module, options = {}) {
    if (this.modules.has(name)) {
      throw new Error(`Module '${name}' is already registered`);
    }

    const registration = {
      module,
      name,
      version: options.version || '1.0.0',
      dependencies: options.dependencies || [],
      enabled: options.enabled !== false,
      priority: options.priority || 100,
      state: 'registered',
      registeredAt: new Date(),
    };

    this.modules.set(name, registration);
    this.logger.info({ module: name, version: registration.version }, 'Module registered');
    this.emit('module:registered', { name, module });

    return this;
  }

  /**
   * Register a provider (voice, TTS, STT, LLM, etc.)
   * @param {string} type - Provider type (voice, tts, stt, llm)
   * @param {string} name - Provider name
   * @param {object} provider - Provider instance
   * @param {object} options - Registration options
   */
  registerProvider(type, name, provider, options = {}) {
    const key = `${type}:${name}`;

    if (this.providers.has(key)) {
      throw new Error(`Provider '${key}' is already registered`);
    }

    const registration = {
      provider,
      type,
      name,
      priority: options.priority || 100,
      isDefault: options.isDefault || false,
      capabilities: options.capabilities || [],
      languages: options.languages || ['en'],
      healthCheck: options.healthCheck || null,
      registeredAt: new Date(),
    };

    this.providers.set(key, registration);

    if (options.healthCheck) {
      this.healthChecks.set(key, options.healthCheck);
    }

    this.logger.info({ type, provider: name }, 'Provider registered');
    this.emit('provider:registered', { type, name, provider });

    return this;
  }

  /**
   * Get a provider by type and optionally name
   * @param {string} type - Provider type
   * @param {string} name - Provider name (optional, returns default if not specified)
   * @returns {object} Provider instance
   */
  getProvider(type, name = null) {
    if (name) {
      const key = `${type}:${name}`;
      const registration = this.providers.get(key);
      if (!registration) {
        throw new Error(`Provider '${key}' not found`);
      }
      return registration.provider;
    }

    // Find default provider for this type
    for (const [key, reg] of this.providers) {
      if (reg.type === type && reg.isDefault) {
        return reg.provider;
      }
    }

    // Return first provider of this type
    for (const [key, reg] of this.providers) {
      if (reg.type === type) {
        return reg.provider;
      }
    }

    throw new Error(`No provider found for type '${type}'`);
  }

  /**
   * Get all providers of a specific type
   * @param {string} type - Provider type
   * @returns {Array} Array of provider registrations
   */
  getProvidersByType(type) {
    const providers = [];
    for (const [key, reg] of this.providers) {
      if (reg.type === type) {
        providers.push(reg);
      }
    }
    return providers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Initialize all registered modules
   */
  async initialize() {
    this.logger.info('Initializing platform...');
    this.state = 'initializing';

    // Sort modules by priority and dependencies
    const sorted = this._sortModulesByDependencies();

    for (const name of sorted) {
      const reg = this.modules.get(name);
      if (!reg.enabled) {
        this.logger.info({ module: name }, 'Module disabled, skipping');
        continue;
      }

      try {
        if (typeof reg.module.init === 'function') {
          await reg.module.init(this);
          reg.state = 'initialized';
          this.logger.info({ module: name }, 'Module initialized');
        }
      } catch (error) {
        reg.state = 'failed';
        this.logger.error({ module: name, error: error.message }, 'Module initialization failed');
        throw error;
      }
    }

    this.state = 'initialized';
    this.emit('platform:initialized');
    return this;
  }

  /**
   * Start all registered modules
   */
  async start() {
    this.logger.info('Starting platform...');
    this.state = 'starting';

    const sorted = this._sortModulesByDependencies();

    for (const name of sorted) {
      const reg = this.modules.get(name);
      if (!reg.enabled || reg.state !== 'initialized') {
        continue;
      }

      try {
        if (typeof reg.module.start === 'function') {
          await reg.module.start(this);
          reg.state = 'running';
          this.logger.info({ module: name }, 'Module started');
        }
      } catch (error) {
        reg.state = 'failed';
        this.logger.error({ module: name, error: error.message }, 'Module start failed');
        throw error;
      }
    }

    this.state = 'running';
    this.startedAt = new Date();
    this.emit('platform:started');
    this.logger.info({ version: this.version }, 'Platform started');

    return this;
  }

  /**
   * Stop all registered modules (reverse order)
   */
  async stop() {
    this.logger.info('Stopping platform...');
    this.state = 'stopping';

    const sorted = this._sortModulesByDependencies().reverse();

    for (const name of sorted) {
      const reg = this.modules.get(name);
      if (reg.state !== 'running') {
        continue;
      }

      try {
        if (typeof reg.module.stop === 'function') {
          await reg.module.stop(this);
          reg.state = 'stopped';
          this.logger.info({ module: name }, 'Module stopped');
        }
      } catch (error) {
        this.logger.error({ module: name, error: error.message }, 'Module stop failed');
        // Continue stopping other modules
      }
    }

    // Run shutdown handlers
    for (const handler of this.shutdownHandlers) {
      try {
        await handler();
      } catch (error) {
        this.logger.error({ error: error.message }, 'Shutdown handler failed');
      }
    }

    this.state = 'stopped';
    this.emit('platform:stopped');
    return this;
  }

  /**
   * Add a shutdown handler
   * @param {function} handler - Async function to run on shutdown
   */
  onShutdown(handler) {
    this.shutdownHandlers.push(handler);
    return this;
  }

  /**
   * Run health checks for all registered services
   * @returns {object} Health check results
   */
  async checkHealth() {
    const results = {
      status: 'healthy',
      platform: {
        name: this.name,
        version: this.version,
        state: this.state,
        uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      },
      services: {},
      modules: {},
      providers: {},
    };

    // Check services
    for (const [name, check] of this.healthChecks) {
      try {
        const start = Date.now();
        const checkResult = await Promise.race([
          check(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout')), 5000)
          ),
        ]);

        results.services[name] = {
          status: checkResult.status || 'healthy',
          latency: Date.now() - start,
          details: checkResult.details || null,
        };

        if (checkResult.status === 'unhealthy') {
          results.status = 'unhealthy';
        } else if (checkResult.status === 'degraded' && results.status !== 'unhealthy') {
          results.status = 'degraded';
        }
      } catch (error) {
        results.services[name] = {
          status: 'unhealthy',
          error: error.message,
        };
        results.status = 'unhealthy';
      }
    }

    // Check modules
    for (const [name, reg] of this.modules) {
      results.modules[name] = {
        state: reg.state,
        enabled: reg.enabled,
      };
    }

    return results;
  }

  /**
   * Sort modules by dependencies using topological sort
   */
  _sortModulesByDependencies() {
    const sorted = [];
    const visited = new Set();
    const temp = new Set();

    const visit = (name) => {
      if (temp.has(name)) {
        throw new Error(`Circular dependency detected: ${name}`);
      }
      if (visited.has(name)) {
        return;
      }

      temp.add(name);
      const reg = this.modules.get(name);

      if (reg) {
        for (const dep of reg.dependencies) {
          visit(dep);
        }
      }

      temp.delete(name);
      visited.add(name);
      sorted.push(name);
    };

    for (const name of this.modules.keys()) {
      visit(name);
    }

    return sorted;
  }

  /**
   * Setup graceful shutdown handlers
   */
  _setupShutdownHandlers() {
    const shutdown = async (signal) => {
      this.logger.info({ signal }, 'Shutdown signal received');
      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        this.logger.error({ error: error.message }, 'Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error({ reason, promise }, 'Unhandled Promise Rejection');
    });

    process.on('uncaughtException', (error) => {
      this.logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught Exception');
      process.exit(1);
    });
  }
}

// Singleton instance
let instance = null;

function createPlatform(options = {}) {
  if (!instance) {
    instance = new Platform(options);
  }
  return instance;
}

function getPlatform() {
  if (!instance) {
    throw new Error('Platform not initialized. Call createPlatform() first.');
  }
  return instance;
}

module.exports = { Platform, createPlatform, getPlatform };
