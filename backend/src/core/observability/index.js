/**
 * Observability Module
 *
 * Provides:
 * - Structured logging with Pino
 * - Metrics collection (Prometheus-compatible)
 * - Health check aggregation
 * - Request tracing
 */

const pino = require('pino');

/**
 * Create a configured logger instance
 */
function createLogger(options = {}) {
  const defaultOptions = {
    name: options.name || 'agent5',
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => ({
        pid: bindings.pid,
        hostname: bindings.hostname,
        service: options.name || 'agent5',
      }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'password',
        'passwordHash',
        'apiKey',
        'api_key',
        'secret',
        'token',
        'accessToken',
        'refreshToken',
        '*.password',
        '*.apiKey',
        '*.secret',
      ],
      remove: true,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  // Use pretty printing in development
  if (process.env.NODE_ENV === 'development' && !process.env.LOG_JSON) {
    return pino({
      ...defaultOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino(defaultOptions);
}

/**
 * Metrics collector for Prometheus-style metrics
 */
class MetricsCollector {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.startTime = Date.now();
  }

  /**
   * Increment a counter
   */
  incCounter(name, labels = {}, value = 1) {
    const key = this._makeKey(name, labels);
    const current = this.counters.get(key) || { name, labels, value: 0 };
    current.value += value;
    this.counters.set(key, current);
  }

  /**
   * Set a gauge value
   */
  setGauge(name, labels = {}, value) {
    const key = this._makeKey(name, labels);
    this.gauges.set(key, { name, labels, value, updatedAt: Date.now() });
  }

  /**
   * Record a histogram observation
   */
  observeHistogram(name, labels = {}, value) {
    const key = this._makeKey(name, labels);
    const histogram = this.histograms.get(key) || {
      name,
      labels,
      count: 0,
      sum: 0,
      buckets: new Map(),
    };

    histogram.count++;
    histogram.sum += value;

    // Standard histogram buckets (in ms for latency)
    const buckets = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    for (const bucket of buckets) {
      if (value <= bucket) {
        const bucketKey = `le_${bucket}`;
        histogram.buckets.set(bucketKey, (histogram.buckets.get(bucketKey) || 0) + 1);
      }
    }
    histogram.buckets.set('le_inf', (histogram.buckets.get('le_inf') || 0) + 1);

    this.histograms.set(key, histogram);
  }

  /**
   * Record request metrics
   */
  recordRequest(method, path, statusCode, durationMs) {
    const labels = { method, path: this._normalizePath(path), status: String(statusCode) };

    this.incCounter('http_requests_total', labels);
    this.observeHistogram('http_request_duration_ms', labels, durationMs);

    if (statusCode >= 500) {
      this.incCounter('http_server_errors_total', labels);
    } else if (statusCode >= 400) {
      this.incCounter('http_client_errors_total', labels);
    }
  }

  /**
   * Get all metrics in Prometheus text format
   */
  getPrometheusMetrics() {
    const lines = [];

    // Add uptime gauge
    this.setGauge('process_uptime_seconds', {}, (Date.now() - this.startTime) / 1000);
    this.setGauge('process_memory_heap_bytes', {}, process.memoryUsage().heapUsed);
    this.setGauge('process_memory_rss_bytes', {}, process.memoryUsage().rss);

    // Counters
    for (const metric of this.counters.values()) {
      lines.push(`# TYPE ${metric.name} counter`);
      lines.push(`${metric.name}${this._formatLabels(metric.labels)} ${metric.value}`);
    }

    // Gauges
    for (const metric of this.gauges.values()) {
      lines.push(`# TYPE ${metric.name} gauge`);
      lines.push(`${metric.name}${this._formatLabels(metric.labels)} ${metric.value}`);
    }

    // Histograms
    for (const metric of this.histograms.values()) {
      lines.push(`# TYPE ${metric.name} histogram`);
      for (const [bucket, count] of metric.buckets) {
        const bucketLabels = { ...metric.labels, le: bucket.replace('le_', '') };
        lines.push(`${metric.name}_bucket${this._formatLabels(bucketLabels)} ${count}`);
      }
      lines.push(`${metric.name}_count${this._formatLabels(metric.labels)} ${metric.count}`);
      lines.push(`${metric.name}_sum${this._formatLabels(metric.labels)} ${metric.sum}`);
    }

    return lines.join('\n');
  }

  /**
   * Get metrics as JSON
   */
  getJsonMetrics() {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(this.histograms),
      uptime: Date.now() - this.startTime,
      memory: process.memoryUsage(),
    };
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  _makeKey(name, labels) {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${name}{${labelStr}}`;
  }

  _formatLabels(labels) {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    return '{' + entries.map(([k, v]) => `${k}="${v}"`).join(',') + '}';
  }

  _normalizePath(path) {
    // Normalize dynamic path segments for better grouping
    return path
      .replace(/\/[0-9a-f]{24}/g, '/:id')           // MongoDB ObjectIds
      .replace(/\/[0-9]+/g, '/:id')                  // Numeric IDs
      .replace(/\/[0-9a-f-]{36}/g, '/:uuid')         // UUIDs
      .replace(/\?.*$/, '');                         // Remove query strings
  }
}

/**
 * Health check aggregator
 */
class HealthAggregator {
  constructor() {
    this.checks = new Map();
  }

  /**
   * Register a health check
   */
  register(name, checkFn, options = {}) {
    this.checks.set(name, {
      fn: checkFn,
      timeout: options.timeout || 5000,
      critical: options.critical !== false,
    });
  }

  /**
   * Run all health checks
   */
  async check() {
    const results = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      checks: {},
    };

    for (const [name, check] of this.checks) {
      try {
        const start = Date.now();
        const result = await Promise.race([
          check.fn(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout')), check.timeout)
          ),
        ]);

        results.checks[name] = {
          status: result.status || 'healthy',
          latencyMs: Date.now() - start,
          details: result.details || null,
        };

        if (result.status === 'unhealthy' && check.critical) {
          results.status = 'unhealthy';
        } else if (result.status === 'degraded' && results.status !== 'unhealthy') {
          results.status = 'degraded';
        }
      } catch (error) {
        results.checks[name] = {
          status: 'unhealthy',
          error: error.message,
        };

        if (check.critical) {
          results.status = 'unhealthy';
        }
      }
    }

    return results;
  }

  /**
   * Simple liveness check
   */
  async liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness check (all critical checks must pass)
   */
  async readiness() {
    const health = await this.check();
    return {
      ready: health.status !== 'unhealthy',
      status: health.status,
    };
  }
}

/**
 * Request tracing middleware
 */
function requestTracingMiddleware(logger, metrics) {
  return (req, res, next) => {
    const start = Date.now();
    const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    // Add request ID to response headers
    res.setHeader('X-Request-ID', requestId);

    // Create child logger with request context
    req.log = logger.child({
      requestId,
      method: req.method,
      path: req.path,
    });

    // Log request start
    req.log.debug({ query: req.query }, 'Request started');

    // Capture response
    const originalEnd = res.end;
    res.end = function(...args) {
      const duration = Date.now() - start;

      // Log request completion
      req.log.info({
        statusCode: res.statusCode,
        durationMs: duration,
        contentLength: res.getHeader('content-length'),
      }, 'Request completed');

      // Record metrics
      if (metrics) {
        metrics.recordRequest(req.method, req.path, res.statusCode, duration);
      }

      originalEnd.apply(res, args);
    };

    next();
  };
}

/**
 * Express error logging middleware
 */
function errorLoggingMiddleware(logger) {
  return (err, req, res, next) => {
    const log = req.log || logger;

    log.error({
      error: {
        name: err.name,
        message: err.message,
        code: err.code,
        stack: err.stack,
      },
      statusCode: err.statusCode || 500,
    }, 'Request error');

    next(err);
  };
}

// Singleton instances
let metricsInstance = null;
let healthInstance = null;
let loggerInstance = null;

function getMetrics() {
  if (!metricsInstance) {
    metricsInstance = new MetricsCollector();
  }
  return metricsInstance;
}

function getHealth() {
  if (!healthInstance) {
    healthInstance = new HealthAggregator();
  }
  return healthInstance;
}

function getLogger(name) {
  if (!loggerInstance) {
    loggerInstance = createLogger({ name });
  }
  return name ? loggerInstance.child({ module: name }) : loggerInstance;
}

module.exports = {
  createLogger,
  MetricsCollector,
  HealthAggregator,
  requestTracingMiddleware,
  errorLoggingMiddleware,
  getMetrics,
  getHealth,
  getLogger,
};
