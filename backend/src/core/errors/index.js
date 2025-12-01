/**
 * Centralized Error Handling System
 *
 * Provides:
 * - Custom error classes with proper classification
 * - Global Express error middleware
 * - Error serialization for logging
 * - Retry-able error detection
 */

/**
 * Base Platform Error
 */
class PlatformError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || 'PLATFORM_ERROR';
    this.statusCode = options.statusCode || 500;
    this.isOperational = options.isOperational !== false; // vs programmer error
    this.isRetryable = options.isRetryable || false;
    this.context = options.context || {};
    this.cause = options.cause || null;

    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      isRetryable: this.isRetryable,
      context: this.context,
    };
  }
}

/**
 * Validation Error (400)
 */
class ValidationError extends PlatformError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'VALIDATION_ERROR',
      statusCode: 400,
      isOperational: true,
      isRetryable: false,
    });
    this.fields = options.fields || [];
  }
}

/**
 * Authentication Error (401)
 */
class AuthenticationError extends PlatformError {
  constructor(message = 'Authentication required', options = {}) {
    super(message, {
      ...options,
      code: options.code || 'AUTHENTICATION_ERROR',
      statusCode: 401,
      isOperational: true,
      isRetryable: false,
    });
  }
}

/**
 * Authorization Error (403)
 */
class AuthorizationError extends PlatformError {
  constructor(message = 'Access denied', options = {}) {
    super(message, {
      ...options,
      code: options.code || 'AUTHORIZATION_ERROR',
      statusCode: 403,
      isOperational: true,
      isRetryable: false,
    });
  }
}

/**
 * Not Found Error (404)
 */
class NotFoundError extends PlatformError {
  constructor(resource = 'Resource', options = {}) {
    super(`${resource} not found`, {
      ...options,
      code: options.code || 'NOT_FOUND',
      statusCode: 404,
      isOperational: true,
      isRetryable: false,
    });
    this.resource = resource;
  }
}

/**
 * Conflict Error (409)
 */
class ConflictError extends PlatformError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'CONFLICT',
      statusCode: 409,
      isOperational: true,
      isRetryable: false,
    });
  }
}

/**
 * Rate Limit Error (429)
 */
class RateLimitError extends PlatformError {
  constructor(message = 'Too many requests', options = {}) {
    super(message, {
      ...options,
      code: options.code || 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
      isOperational: true,
      isRetryable: true,
    });
    this.retryAfter = options.retryAfter || 60;
  }
}

/**
 * External Service Error (502/503)
 */
class ExternalServiceError extends PlatformError {
  constructor(serviceName, message, options = {}) {
    super(`${serviceName}: ${message}`, {
      ...options,
      code: options.code || 'EXTERNAL_SERVICE_ERROR',
      statusCode: options.statusCode || 502,
      isOperational: true,
      isRetryable: options.isRetryable !== false,
    });
    this.serviceName = serviceName;
    this.originalError = options.originalError || null;
  }
}

/**
 * Database Error
 */
class DatabaseError extends PlatformError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'DATABASE_ERROR',
      statusCode: 500,
      isOperational: true,
      isRetryable: options.isRetryable || false,
    });
    this.query = options.query || null;
  }
}

/**
 * Configuration Error
 */
class ConfigurationError extends PlatformError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'CONFIGURATION_ERROR',
      statusCode: 500,
      isOperational: false,
      isRetryable: false,
    });
  }
}

/**
 * Timeout Error
 */
class TimeoutError extends PlatformError {
  constructor(operation, timeoutMs, options = {}) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`, {
      ...options,
      code: options.code || 'TIMEOUT',
      statusCode: 504,
      isOperational: true,
      isRetryable: true,
    });
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Circuit Breaker Open Error
 */
class CircuitBreakerError extends PlatformError {
  constructor(serviceName, options = {}) {
    super(`Circuit breaker open for service: ${serviceName}`, {
      ...options,
      code: 'CIRCUIT_BREAKER_OPEN',
      statusCode: 503,
      isOperational: true,
      isRetryable: true,
    });
    this.serviceName = serviceName;
    this.retryAfter = options.retryAfter || 30;
  }
}

/**
 * Check if error is retryable
 */
function isRetryableError(error) {
  if (error instanceof PlatformError) {
    return error.isRetryable;
  }

  // Network errors
  if (error.code === 'ECONNREFUSED' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND') {
    return true;
  }

  // HTTP status codes that are retryable
  if (error.statusCode === 429 ||
      error.statusCode === 502 ||
      error.statusCode === 503 ||
      error.statusCode === 504) {
    return true;
  }

  return false;
}

/**
 * Wrap error with context
 */
function wrapError(error, context = {}) {
  if (error instanceof PlatformError) {
    error.context = { ...error.context, ...context };
    return error;
  }

  return new PlatformError(error.message, {
    cause: error,
    context,
    code: error.code || 'UNKNOWN_ERROR',
  });
}

/**
 * Express error handling middleware
 */
function errorHandler(logger) {
  return (err, req, res, next) => {
    // Determine if this is an operational error
    const isOperational = err instanceof PlatformError ? err.isOperational : false;

    // Log the error
    const logContext = {
      error: {
        name: err.name,
        message: err.message,
        code: err.code,
        stack: err.stack,
      },
      request: {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userId: req.user?.id,
      },
    };

    if (isOperational) {
      logger.warn(logContext, 'Operational error');
    } else {
      logger.error(logContext, 'Unexpected error');
    }

    // Determine status code
    const statusCode = err.statusCode || err.status || 500;

    // Build response
    const response = {
      error: {
        message: isOperational ? err.message : 'An unexpected error occurred',
        code: err.code || 'INTERNAL_ERROR',
      },
    };

    // Add validation details if available
    if (err instanceof ValidationError && err.fields.length > 0) {
      response.error.fields = err.fields;
    }

    // Add retry-after header for rate limits
    if (err instanceof RateLimitError || err instanceof CircuitBreakerError) {
      res.set('Retry-After', String(err.retryAfter));
    }

    // Include stack trace in development
    if (process.env.NODE_ENV === 'development') {
      response.error.stack = err.stack;
    }

    res.status(statusCode).json(response);
  };
}

/**
 * Async route handler wrapper (catches async errors)
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  PlatformError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ExternalServiceError,
  DatabaseError,
  ConfigurationError,
  TimeoutError,
  CircuitBreakerError,
  isRetryableError,
  wrapError,
  errorHandler,
  asyncHandler,
};
