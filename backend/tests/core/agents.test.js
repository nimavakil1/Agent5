/**
 * Tests for Agent Framework
 */

const { BaseAgent, AgentRegistry, createAgentRegistry } = require('../../src/core/agents');

// Mock logger for testing
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => mockLogger,
};

// Mock platform
const mockPlatform = {
  logger: mockLogger,
  registerService: jest.fn(),
  getService: jest.fn(),
};

describe('AgentRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = createAgentRegistry();
  });

  afterEach(async () => {
    if (registry) {
      await registry.shutdown();
    }
  });

  test('should initialize successfully', async () => {
    await registry.init(mockPlatform);
    expect(mockLogger.info).toHaveBeenCalled();
  });

  test('should register an agent', async () => {
    await registry.init(mockPlatform);

    const agent = new TestAgent({ name: 'TestAgent', role: 'test' });
    await registry.register(agent);

    expect(registry.list().length).toBe(1);
    expect(registry.getByName('TestAgent')).toBe(agent);
  });

  test('should find agents by role', async () => {
    await registry.init(mockPlatform);

    const agent1 = new TestAgent({ name: 'Agent1', role: 'worker' });
    const agent2 = new TestAgent({ name: 'Agent2', role: 'worker' });
    const agent3 = new TestAgent({ name: 'Agent3', role: 'manager' });

    await registry.register(agent1);
    await registry.register(agent2);
    await registry.register(agent3);

    const workers = registry.getByRole('worker');
    expect(workers.length).toBe(2);

    const managers = registry.getByRole('manager');
    expect(managers.length).toBe(1);
  });

  test('should report health status', async () => {
    await registry.init(mockPlatform);

    const agent = new TestAgent({ name: 'TestAgent', role: 'test' });
    await registry.register(agent);

    const health = registry.getHealth();
    expect(health.totalAgents).toBe(1);
    expect(health.byRole.test).toBe(1);
  });

  test('should unregister an agent', async () => {
    await registry.init(mockPlatform);

    const agent = new TestAgent({ name: 'TestAgent', role: 'test' });
    await registry.register(agent);
    expect(registry.list().length).toBe(1);

    await registry.unregister(agent.id);
    expect(registry.list().length).toBe(0);
  });
});

describe('BaseAgent', () => {
  test('should create an agent with default values', () => {
    const agent = new TestAgent({ name: 'MyAgent' });

    expect(agent.name).toBe('MyAgent');
    expect(agent.state).toBe('idle');
    expect(agent.capabilities).toEqual([]);
  });

  test('should register tools', async () => {
    const agent = new TestAgent({ name: 'MyAgent' });
    await agent.init(mockPlatform);

    agent.registerTool('myTool', () => 'result', { description: 'A test tool' });
    expect(agent.tools.size).toBe(1);
    expect(agent.tools.has('myTool')).toBe(true);
  });

  test('should track metrics', () => {
    const agent = new TestAgent({ name: 'MyAgent' });

    expect(agent.metrics.tasksCompleted).toBe(0);
    expect(agent.metrics.tasksFailed).toBe(0);
  });

  test('should return status', () => {
    const agent = new TestAgent({
      name: 'MyAgent',
      role: 'worker',
      capabilities: ['cap1', 'cap2'],
    });

    const status = agent.getStatus();

    expect(status.name).toBe('MyAgent');
    expect(status.role).toBe('worker');
    expect(status.state).toBe('idle');
    expect(status.capabilities).toEqual(['cap1', 'cap2']);
  });
});

// Test implementation of BaseAgent
class TestAgent extends BaseAgent {
  async init(platform) {
    this.platform = platform;
    this.logger = platform.logger.child({ agent: this.name });
  }

  async _think(task, _previousResult) {
    return { action: 'complete', result: `Processed: ${JSON.stringify(task)}` };
  }
}
