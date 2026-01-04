/**
 * Resilience Patterns
 *
 * Provides:
 * - Retry with exponential backoff
 * - Circuit breaker
 * - Timeout wrapper
 * - Bulkhead (concurrency limiter)
 */

const { TimeoutError, CircuitBreakerError, ExternalServiceError } = require('../errors');

/**
 * Retry with exponential backoff
 */
class RetryPolicy {
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts || 3;
    this.baseDelayMs = options.baseDelayMs || 1000;
    this.maxDelayMs = options.maxDelayMs || 30000;
    this.multiplier = options.multiplier || 2;
    this.jitter = options.jitter !== false;
    this.shouldRetry = options.shouldRetry || this._defaultShouldRetry;
    this.onRetry = options.onRetry || null;
  }

  _defaultShouldRetry(error, _attempt) {
    // Retry on network errors
    if (error.code === 'ECONNREFUSED' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND') {
      return true;
    }

    // Retry on specific HTTP status codes
    if (error.statusCode === 429 ||
        error.statusCode === 502 ||
        error.statusCode === 503 ||
        error.statusCode === 504) {
      return true;
    }

    // Check if error has isRetryable flag
    if (typeof error.isRetryable === 'boolean') {
      return error.isRetryable;
    }

    return false;
  }

  _calculateDelay(attempt) {
    let delay = Math.min(
      this.baseDelayMs * Math.pow(this.multiplier, attempt - 1),
      this.maxDelayMs
    );

    if (this.jitter) {
      // Add random jitter between 0-25%
      delay = delay * (1 + Math.random() * 0.25);
    }

    return Math.floor(delay);
  }

  async execute(fn, context = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (error) {
        lastError = error;

        const shouldRetry = this.shouldRetry(error, attempt) && attempt < this.maxAttempts;

        if (shouldRetry) {
          const delay = this._calculateDelay(attempt);

          if (this.onRetry) {
            this.onRetry({ error, attempt, delay, context });
          }

          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          break;
        }
      }
    }

    throw lastError;
  }
}

/**
 * Circuit Breaker implementation
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.timeout = options.timeout || 30000; // Time in open state before half-open
    this.monitorInterval = options.monitorInterval || 10000;
    this.onStateChange = options.onStateChange || null;

    this.state = 'closed'; // closed, open, half-open
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
    this.nextAttempt = null;
  }

  async execute(fn) {
    if (this.state === 'open') {
      if (Date.now() >= this.nextAttempt) {
        this._transition('half-open');
      } else {
        throw new CircuitBreakerError(this.name, {
          retryAfter: Math.ceil((this.nextAttempt - Date.now()) / 1000),
        });
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure(error);
      throw error;
    }
  }

  _onSuccess() {
    this.failures = 0;

    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this._transition('closed');
      }
    }
  }

  _onFailure(_error) {
    this.failures++;
    this.lastFailure = Date.now();
    this.successes = 0;

    if (this.state === 'half-open') {
      this._transition('open');
    } else if (this.state === 'closed' && this.failures >= this.failureThreshold) {
      this._transition('open');
    }
  }

  _transition(newState) {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'open') {
      this.nextAttempt = Date.now() + this.timeout;
    } else if (newState === 'closed') {
      this.failures = 0;
      this.successes = 0;
    } else if (newState === 'half-open') {
      this.successes = 0;
    }

    if (this.onStateChange && oldState !== newState) {
      this.onStateChange({ name: this.name, from: oldState, to: newState });
    }
  }

  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      nextAttempt: this.nextAttempt,
    };
  }

  reset() {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
    this.nextAttempt = null;
  }
}

/**
 * Timeout wrapper
 */
async function withTimeout(fn, timeoutMs, operationName = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(operationName, timeoutMs));
    }, timeoutMs);

    Promise.resolve(fn())
      .then(result => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Bulkhead (concurrency limiter)
 */
class Bulkhead {
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.maxConcurrent = options.maxConcurrent || 10;
    this.maxQueue = options.maxQueue || 100;
    this.queueTimeout = options.queueTimeout || 30000;

    this.running = 0;
    this.queue = [];
  }

  async execute(fn) {
    if (this.running < this.maxConcurrent) {
      return this._execute(fn);
    }

    if (this.queue.length >= this.maxQueue) {
      throw new ExternalServiceError(this.name, 'Bulkhead queue full', {
        statusCode: 503,
        isRetryable: true,
      });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.queue.findIndex(item => item.resolve === resolve);
        if (index > -1) {
          this.queue.splice(index, 1);
        }
        reject(new TimeoutError(`${this.name} queue`, this.queueTimeout));
      }, this.queueTimeout);

      this.queue.push({
        fn,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async _execute(fn) {
    this.running++;
    try {
      const result = await fn();
      return result;
    } finally {
      this.running--;
      this._processQueue();
    }
  }

  _processQueue() {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const { fn, resolve, reject } = this.queue.shift();
      this._execute(fn).then(resolve).catch(reject);
    }
  }

  getState() {
    return {
      name: this.name,
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
    };
  }
}

/**
 * Create a resilient function with retry, circuit breaker, and timeout
 */
function createResilientFunction(fn, options = {}) {
  const retry = options.retry !== false ? new RetryPolicy(options.retry || {}) : null;
  const circuitBreaker = options.circuitBreaker ? new CircuitBreaker(options.circuitBreaker) : null;
  const timeout = options.timeout || null;
  const bulkhead = options.bulkhead ? new Bulkhead(options.bulkhead) : null;

  return async (...args) => {
    const execute = async () => {
      let operation = () => fn(...args);

      if (timeout) {
        const originalOp = operation;
        operation = () => withTimeout(originalOp, timeout, options.name || 'operation');
      }

      if (circuitBreaker) {
        const originalOp = operation;
        operation = () => circuitBreaker.execute(originalOp);
      }

      if (bulkhead) {
        const originalOp = operation;
        operation = () => bulkhead.execute(originalOp);
      }

      return operation();
    };

    if (retry) {
      return retry.execute(execute, { args });
    }

    return execute();
  };
}

/**
 * Circuit breaker registry for managing multiple breakers
 */
class CircuitBreakerRegistry {
  constructor() {
    this.breakers = new Map();
  }

  getOrCreate(name, options = {}) {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker({ name, ...options }));
    }
    return this.breakers.get(name);
  }

  get(name) {
    return this.breakers.get(name);
  }

  getAll() {
    const all = {};
    for (const [name, breaker] of this.breakers) {
      all[name] = breaker.getState();
    }
    return all;
  }

  resetAll() {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

// Singleton registry
const circuitBreakerRegistry = new CircuitBreakerRegistry();

module.exports = {
  RetryPolicy,
  CircuitBreaker,
  Bulkhead,
  withTimeout,
  createResilientFunction,
  CircuitBreakerRegistry,
  circuitBreakerRegistry,
};
