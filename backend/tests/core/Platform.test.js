/**
 * Platform Core Tests
 */

const { Platform } = require('../../src/core/Platform');

describe('Platform', () => {
  let platform;

  beforeEach(() => {
    platform = new Platform({ name: 'test-platform' });
  });

  afterEach(async () => {
    if (platform && platform.state === 'running') {
      await platform.stop();
    }
  });

  describe('Service Registration', () => {
    test('should register a service', () => {
      const mockService = { foo: 'bar' };
      platform.registerService('test-service', mockService);

      expect(platform.hasService('test-service')).toBe(true);
      expect(platform.getService('test-service')).toBe(mockService);
    });

    test('should throw when registering duplicate service', () => {
      platform.registerService('test-service', {});

      expect(() => {
        platform.registerService('test-service', {});
      }).toThrow("Service 'test-service' is already registered");
    });

    test('should throw when getting non-existent service', () => {
      expect(() => {
        platform.getService('non-existent');
      }).toThrow("Service 'non-existent' not found");
    });
  });

  describe('Module Registration', () => {
    test('should register a module', async () => {
      const mockModule = {
        init: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      };

      await platform.registerModule('test-module', mockModule);

      expect(platform.modules.has('test-module')).toBe(true);
    });

    test('should throw when registering duplicate module', async () => {
      await platform.registerModule('test-module', {});

      await expect(platform.registerModule('test-module', {})).rejects.toThrow(
        "Module 'test-module' is already registered"
      );
    });
  });

  describe('Provider Registration', () => {
    test('should register a provider', () => {
      const mockProvider = { synthesize: jest.fn() };

      platform.registerProvider('tts', 'test-provider', mockProvider, {
        isDefault: true,
        languages: ['en', 'es'],
      });

      expect(platform.providers.has('tts:test-provider')).toBe(true);
      expect(platform.getProvider('tts')).toBe(mockProvider);
    });

    test('should get provider by type and name', () => {
      const provider1 = { name: 'provider1' };
      const provider2 = { name: 'provider2' };

      platform.registerProvider('tts', 'elevenlabs', provider1);
      platform.registerProvider('tts', 'cartesia', provider2);

      expect(platform.getProvider('tts', 'elevenlabs')).toBe(provider1);
      expect(platform.getProvider('tts', 'cartesia')).toBe(provider2);
    });

    test('should get all providers by type', () => {
      platform.registerProvider('tts', 'provider1', {}, { priority: 2 });
      platform.registerProvider('tts', 'provider2', {}, { priority: 1 });

      const providers = platform.getProvidersByType('tts');

      expect(providers).toHaveLength(2);
      expect(providers[0].priority).toBe(1); // Sorted by priority
    });
  });

  describe('Lifecycle', () => {
    test('should initialize modules in dependency order', async () => {
      const initOrder = [];

      const moduleA = {
        init: jest.fn().mockImplementation(() => initOrder.push('A')),
        start: jest.fn(),
      };

      const moduleB = {
        init: jest.fn().mockImplementation(() => initOrder.push('B')),
        start: jest.fn(),
      };

      await platform.registerModule('moduleA', moduleA, { dependencies: ['moduleB'] });
      await platform.registerModule('moduleB', moduleB);

      await platform.initialize();

      expect(initOrder).toEqual(['B', 'A']);
    });

    test('should start all modules', async () => {
      const mockModule = {
        init: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      };

      await platform.registerModule('test-module', mockModule);
      await platform.initialize();
      await platform.start();

      expect(mockModule.init).toHaveBeenCalled();
      expect(mockModule.start).toHaveBeenCalled();
      expect(platform.state).toBe('running');
    });

    test('should stop modules in reverse order', async () => {
      const stopOrder = [];

      const moduleA = {
        init: jest.fn(),
        start: jest.fn(),
        stop: jest.fn().mockImplementation(() => stopOrder.push('A')),
      };

      const moduleB = {
        init: jest.fn(),
        start: jest.fn(),
        stop: jest.fn().mockImplementation(() => stopOrder.push('B')),
      };

      await platform.registerModule('moduleA', moduleA, { dependencies: ['moduleB'] });
      await platform.registerModule('moduleB', moduleB);

      await platform.initialize();
      await platform.start();
      await platform.stop();

      expect(stopOrder).toEqual(['A', 'B']); // Reverse of init order
    });
  });

  describe('Health Checks', () => {
    test('should aggregate health check results', async () => {
      platform.registerService('healthy-service', {}, {
        healthCheck: async () => ({ status: 'healthy' }),
      });

      platform.registerService('degraded-service', {}, {
        healthCheck: async () => ({ status: 'degraded' }),
      });

      const health = await platform.checkHealth();

      expect(health.status).toBe('degraded');
      expect(health.services['healthy-service'].status).toBe('healthy');
      expect(health.services['degraded-service'].status).toBe('degraded');
    });

    test('should mark as unhealthy when check fails', async () => {
      platform.registerService('failing-service', {}, {
        healthCheck: async () => {
          throw new Error('Check failed');
        },
      });

      const health = await platform.checkHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.services['failing-service'].error).toBe('Check failed');
    });
  });

  describe('Shutdown Handlers', () => {
    test('should run shutdown handlers', async () => {
      const handler = jest.fn();
      platform.onShutdown(handler);

      await platform.stop();

      expect(handler).toHaveBeenCalled();
    });
  });
});
