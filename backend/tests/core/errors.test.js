/**
 * Error Handling Tests
 */

const {
  PlatformError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ExternalServiceError,
  TimeoutError,
  CircuitBreakerError,
  isRetryableError,
  wrapError,
  asyncHandler,
} = require('../../src/core/errors');

describe('Custom Errors', () => {
  describe('PlatformError', () => {
    test('should create error with defaults', () => {
      const error = new PlatformError('Test error');

      expect(error.message).toBe('Test error');
      expect(error.code).toBe('PLATFORM_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.isOperational).toBe(true);
      expect(error.isRetryable).toBe(false);
    });

    test('should create error with custom options', () => {
      const error = new PlatformError('Custom error', {
        code: 'CUSTOM_CODE',
        statusCode: 400,
        isRetryable: true,
        context: { foo: 'bar' },
      });

      expect(error.code).toBe('CUSTOM_CODE');
      expect(error.statusCode).toBe(400);
      expect(error.isRetryable).toBe(true);
      expect(error.context).toEqual({ foo: 'bar' });
    });

    test('should serialize to JSON', () => {
      const error = new PlatformError('Test error', { code: 'TEST' });
      const json = error.toJSON();

      expect(json).toHaveProperty('name', 'PlatformError');
      expect(json).toHaveProperty('message', 'Test error');
      expect(json).toHaveProperty('code', 'TEST');
      expect(json).not.toHaveProperty('stack');
    });
  });

  describe('ValidationError', () => {
    test('should have 400 status code', () => {
      const error = new ValidationError('Invalid input');

      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.isRetryable).toBe(false);
    });

    test('should include field errors', () => {
      const error = new ValidationError('Invalid input', {
        fields: [
          { field: 'email', message: 'Invalid email format' },
        ],
      });

      expect(error.fields).toHaveLength(1);
      expect(error.fields[0].field).toBe('email');
    });
  });

  describe('AuthenticationError', () => {
    test('should have 401 status code', () => {
      const error = new AuthenticationError();

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Authentication required');
    });
  });

  describe('AuthorizationError', () => {
    test('should have 403 status code', () => {
      const error = new AuthorizationError();

      expect(error.statusCode).toBe(403);
      expect(error.message).toBe('Access denied');
    });
  });

  describe('NotFoundError', () => {
    test('should have 404 status code', () => {
      const error = new NotFoundError('User');

      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('User not found');
      expect(error.resource).toBe('User');
    });
  });

  describe('RateLimitError', () => {
    test('should have 429 status code and be retryable', () => {
      const error = new RateLimitError('Too many requests', {
        retryAfter: 60,
      });

      expect(error.statusCode).toBe(429);
      expect(error.isRetryable).toBe(true);
      expect(error.retryAfter).toBe(60);
    });
  });

  describe('ExternalServiceError', () => {
    test('should include service name', () => {
      const originalError = new Error('Connection refused');
      const error = new ExternalServiceError('OpenAI', 'API call failed', {
        originalError,
      });

      expect(error.statusCode).toBe(502);
      expect(error.serviceName).toBe('OpenAI');
      expect(error.message).toBe('OpenAI: API call failed');
      expect(error.isRetryable).toBe(true);
    });
  });

  describe('TimeoutError', () => {
    test('should include operation and timeout', () => {
      const error = new TimeoutError('Database query', 5000);

      expect(error.statusCode).toBe(504);
      expect(error.message).toBe("Operation 'Database query' timed out after 5000ms");
      expect(error.operation).toBe('Database query');
      expect(error.timeoutMs).toBe(5000);
      expect(error.isRetryable).toBe(true);
    });
  });

  describe('CircuitBreakerError', () => {
    test('should include service name and retry after', () => {
      const error = new CircuitBreakerError('Shopify', { retryAfter: 30 });

      expect(error.statusCode).toBe(503);
      expect(error.serviceName).toBe('Shopify');
      expect(error.retryAfter).toBe(30);
      expect(error.isRetryable).toBe(true);
    });
  });
});

describe('Error Utilities', () => {
  describe('isRetryableError', () => {
    test('should identify retryable platform errors', () => {
      expect(isRetryableError(new RateLimitError())).toBe(true);
      expect(isRetryableError(new TimeoutError('test', 1000))).toBe(true);
      expect(isRetryableError(new ValidationError('test'))).toBe(false);
    });

    test('should identify retryable network errors', () => {
      const networkError = new Error('Connection failed');
      networkError.code = 'ECONNREFUSED';

      expect(isRetryableError(networkError)).toBe(true);
    });

    test('should identify retryable HTTP status codes', () => {
      const error429 = new Error('Rate limited');
      error429.statusCode = 429;

      const error503 = new Error('Service unavailable');
      error503.statusCode = 503;

      const error400 = new Error('Bad request');
      error400.statusCode = 400;

      expect(isRetryableError(error429)).toBe(true);
      expect(isRetryableError(error503)).toBe(true);
      expect(isRetryableError(error400)).toBe(false);
    });
  });

  describe('wrapError', () => {
    test('should add context to platform errors', () => {
      const error = new ValidationError('Invalid');
      const wrapped = wrapError(error, { userId: '123' });

      expect(wrapped.context.userId).toBe('123');
    });

    test('should wrap non-platform errors', () => {
      const error = new Error('Generic error');
      const wrapped = wrapError(error, { userId: '123' });

      expect(wrapped).toBeInstanceOf(PlatformError);
      expect(wrapped.cause).toBe(error);
      expect(wrapped.context.userId).toBe('123');
    });
  });

  describe('asyncHandler', () => {
    test('should catch async errors and pass to next', async () => {
      const error = new Error('Async error');
      const asyncFn = async () => {
        throw error;
      };

      const handler = asyncHandler(asyncFn);
      const next = jest.fn();

      await handler({}, {}, next);

      expect(next).toHaveBeenCalledWith(error);
    });

    test('should not call next for successful handlers', async () => {
      const asyncFn = async (req, res) => {
        res.json({ success: true });
      };

      const handler = asyncHandler(asyncFn);
      const next = jest.fn();
      const res = { json: jest.fn() };

      await handler({}, res, next);

      expect(res.json).toHaveBeenCalledWith({ success: true });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
