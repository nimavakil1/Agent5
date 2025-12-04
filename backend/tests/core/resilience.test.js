/**
 * Resilience Patterns Tests
 */

const {
  RetryPolicy,
  CircuitBreaker,
  Bulkhead,
  withTimeout,
  createResilientFunction,
} = require('../../src/core/resilience');
const { TimeoutError, CircuitBreakerError } = require('../../src/core/errors');

describe('RetryPolicy', () => {
  test('should succeed on first attempt', async () => {
    const retry = new RetryPolicy({ maxAttempts: 3 });
    const fn = jest.fn().mockResolvedValue('success');

    const result = await retry.execute(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('should retry on failure', async () => {
    const retry = new RetryPolicy({
      maxAttempts: 3,
      baseDelayMs: 10,
    });

    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const result = await retry.execute(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('should throw after max attempts', async () => {
    const retry = new RetryPolicy({
      maxAttempts: 2,
      baseDelayMs: 10,
    });

    const fn = jest.fn().mockRejectedValue(new Error('always fails'));

    await expect(retry.execute(fn)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('should not retry non-retryable errors', async () => {
    const retry = new RetryPolicy({
      maxAttempts: 3,
      shouldRetry: (error) => error.isRetryable,
    });

    const error = new Error('non-retryable');
    error.isRetryable = false;

    const fn = jest.fn().mockRejectedValue(error);

    await expect(retry.execute(fn)).rejects.toThrow('non-retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('should call onRetry callback', async () => {
    const onRetry = jest.fn();
    const retry = new RetryPolicy({
      maxAttempts: 3,
      baseDelayMs: 10,
      onRetry,
    });

    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');

    await retry.execute(fn);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
    }));
  });
});

describe('CircuitBreaker', () => {
  test('should allow requests when closed', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    const fn = jest.fn().mockResolvedValue('success');

    const result = await breaker.execute(fn);

    expect(result).toBe('success');
    expect(breaker.state).toBe('closed');
  });

  test('should open after failure threshold', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      timeout: 100,
    });

    const fn = jest.fn().mockRejectedValue(new Error('fail'));

    // First failure
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    expect(breaker.state).toBe('closed');

    // Second failure - opens circuit
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    expect(breaker.state).toBe('open');
  });

  test('should throw CircuitBreakerError when open', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      timeout: 1000,
    });

    const fn = jest.fn().mockRejectedValue(new Error('fail'));

    // Open the circuit
    await expect(breaker.execute(fn)).rejects.toThrow();

    // Should throw CircuitBreakerError
    await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitBreakerError);
  });

  test('should transition to half-open after timeout', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      timeout: 50,
    });

    const fn = jest.fn().mockRejectedValue(new Error('fail'));

    // Open the circuit
    await expect(breaker.execute(fn)).rejects.toThrow();
    expect(breaker.state).toBe('open');

    // Wait for timeout
    await new Promise(resolve => setTimeout(resolve, 60));

    // Should be half-open now
    fn.mockResolvedValue('success');
    await breaker.execute(fn);

    expect(breaker.state).toBe('half-open');
  });

  test('should close after success threshold in half-open', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      timeout: 50,
    });

    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');

    // Open the circuit
    await expect(breaker.execute(fn)).rejects.toThrow();

    // Wait for timeout
    await new Promise(resolve => setTimeout(resolve, 60));

    // Two successes to close
    await breaker.execute(fn);
    expect(breaker.state).toBe('half-open');

    await breaker.execute(fn);
    expect(breaker.state).toBe('closed');
  });

  test('should reset state', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });

    breaker._transition('open');
    expect(breaker.state).toBe('open');

    breaker.reset();
    expect(breaker.state).toBe('closed');
    expect(breaker.failures).toBe(0);
  });
});

describe('withTimeout', () => {
  test('should resolve within timeout', async () => {
    const fn = async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'success';
    };

    const result = await withTimeout(fn, 100, 'test');
    expect(result).toBe('success');
  });

  test('should throw TimeoutError when timeout exceeded', async () => {
    const fn = async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return 'success';
    };

    await expect(withTimeout(fn, 10, 'test operation')).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('Bulkhead', () => {
  test('should allow requests within limit', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 2 });

    const fn1 = jest.fn().mockResolvedValue('result1');
    const fn2 = jest.fn().mockResolvedValue('result2');

    const [result1, result2] = await Promise.all([
      bulkhead.execute(fn1),
      bulkhead.execute(fn2),
    ]);

    expect(result1).toBe('result1');
    expect(result2).toBe('result2');
  });

  test('should queue requests when at capacity', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 10 });

    let resolve1;
    const promise1 = new Promise(r => { resolve1 = r; });
    const fn1 = jest.fn().mockReturnValue(promise1);
    const fn2 = jest.fn().mockResolvedValue('result2');

    const exec1 = bulkhead.execute(fn1);
    const exec2 = bulkhead.execute(fn2);

    // fn2 should be queued
    expect(bulkhead.running).toBe(1);
    expect(bulkhead.queue.length).toBe(1);

    // Complete fn1
    resolve1('result1');
    await exec1;

    // fn2 should now execute
    const result2 = await exec2;
    expect(result2).toBe('result2');
  });

  test('should reject when queue is full', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 1 });

    const fn = () => new Promise(resolve => setTimeout(resolve, 100));

    // Fill concurrent slot
    bulkhead.execute(fn);

    // Fill queue
    bulkhead.execute(fn);

    // Should reject
    await expect(bulkhead.execute(fn)).rejects.toThrow('Bulkhead queue full');
  });
});

describe('createResilientFunction', () => {
  test('should combine retry and timeout', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('fail');
      }
      return 'success';
    };

    const resilientFn = createResilientFunction(fn, {
      name: 'test',
      retry: { maxAttempts: 3, baseDelayMs: 10 },
      timeout: 1000,
    });

    const result = await resilientFn();
    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  test('should combine circuit breaker and retry', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));

    const resilientFn = createResilientFunction(fn, {
      retry: { maxAttempts: 2, baseDelayMs: 10 },
      circuitBreaker: { failureThreshold: 3, timeout: 1000 },
    });

    // Should retry twice, then fail
    await expect(resilientFn()).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
