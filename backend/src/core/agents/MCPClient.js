/**
 * MCPClient - Model Context Protocol Client
 *
 * Connects to MCP servers to provide tools for AI agents.
 * Supports both stdio-based and HTTP-based MCP servers.
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

class MCPClient extends EventEmitter {
  constructor(config) {
    super();

    this.name = config.name;
    this.type = config.type || 'stdio'; // 'stdio' or 'http'
    this.command = config.command; // For stdio: command to run
    this.args = config.args || [];
    this.env = config.env || {};
    this.url = config.url; // For HTTP-based servers

    this.process = null;
    this.connected = false;
    this.tools = [];
    this.resources = [];
    this.prompts = [];

    this.pendingRequests = new Map();
    this.requestTimeout = config.timeout || 30000;

    this.buffer = '';
    this.logger = null;
  }

  /**
   * Connect to the MCP server
   */
  async connect() {
    if (this.type === 'stdio') {
      return this._connectStdio();
    } else if (this.type === 'http') {
      return this._connectHttp();
    }
    throw new Error(`Unknown MCP server type: ${this.type}`);
  }

  /**
   * Connect via stdio (spawn subprocess)
   */
  async _connectStdio() {
    return new Promise((resolve, reject) => {
      try {
        // Spawn the MCP server process
        this.process = spawn(this.command, this.args, {
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.process.stdout.on('data', (data) => {
          this._handleStdioData(data);
        });

        this.process.stderr.on('data', (data) => {
          if (this.logger) {
            this.logger.warn({ server: this.name, stderr: data.toString() }, 'MCP server stderr');
          }
        });

        this.process.on('error', (error) => {
          this.emit('error', error);
          if (!this.connected) {
            reject(error);
          }
        });

        this.process.on('close', (code) => {
          this.connected = false;
          this.emit('disconnected', { code });
        });

        // Initialize the connection
        this._sendRequest('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          clientInfo: {
            name: 'Agent5',
            version: '2.0.0',
          },
        }).then((response) => {
          this.connected = true;

          // Send initialized notification
          this._sendNotification('notifications/initialized', {});

          // Discover available tools, resources, prompts
          return this._discoverCapabilities();
        }).then(() => {
          this.emit('connected');
          resolve();
        }).catch(reject);

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Connect via HTTP
   */
  async _connectHttp() {
    // For HTTP-based MCP servers (future implementation)
    const response = await fetch(`${this.url}/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'Agent5', version: '2.0.0' },
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to connect to MCP server: ${response.statusText}`);
    }

    this.connected = true;
    await this._discoverCapabilities();
    this.emit('connected');
  }

  /**
   * Handle incoming data from stdio
   */
  _handleStdioData(data) {
    this.buffer += data.toString();

    // Process complete JSON-RPC messages
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this._handleMessage(message);
        } catch (error) {
          if (this.logger) {
            this.logger.error({ error: error.message, line }, 'Failed to parse MCP message');
          }
        }
      }
    }
  }

  /**
   * Handle a JSON-RPC message
   */
  _handleMessage(message) {
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      // This is a response to a request
      const { resolve, reject, timer } = this.pendingRequests.get(message.id);
      clearTimeout(timer);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message || 'MCP request failed'));
      } else {
        resolve(message.result);
      }
    } else if (message.method) {
      // This is a notification or request from the server
      this.emit('notification', message);
    }
  }

  /**
   * Send a JSON-RPC request
   */
  async _sendRequest(method, params = {}) {
    const id = uuidv4();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }) + '\n';

      if (this.type === 'stdio' && this.process) {
        this.process.stdin.write(message);
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  _sendNotification(method, params = {}) {
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    }) + '\n';

    if (this.type === 'stdio' && this.process) {
      this.process.stdin.write(message);
    }
  }

  /**
   * Discover server capabilities (tools, resources, prompts)
   */
  async _discoverCapabilities() {
    try {
      // Get tools
      const toolsResponse = await this._sendRequest('tools/list', {});
      this.tools = toolsResponse.tools || [];

      // Get resources
      try {
        const resourcesResponse = await this._sendRequest('resources/list', {});
        this.resources = resourcesResponse.resources || [];
      } catch (e) {
        // Resources might not be supported
        this.resources = [];
      }

      // Get prompts
      try {
        const promptsResponse = await this._sendRequest('prompts/list', {});
        this.prompts = promptsResponse.prompts || [];
      } catch (e) {
        // Prompts might not be supported
        this.prompts = [];
      }
    } catch (error) {
      if (this.logger) {
        this.logger.error({ error: error.message }, 'Failed to discover MCP capabilities');
      }
    }
  }

  /**
   * List available tools
   */
  async listTools() {
    if (!this.connected) {
      throw new Error('MCP client not connected');
    }
    return this.tools;
  }

  /**
   * Call a tool
   */
  async callTool(name, args = {}) {
    if (!this.connected) {
      throw new Error('MCP client not connected');
    }

    const result = await this._sendRequest('tools/call', {
      name,
      arguments: args,
    });

    return result;
  }

  /**
   * Read a resource
   */
  async readResource(uri) {
    if (!this.connected) {
      throw new Error('MCP client not connected');
    }

    const result = await this._sendRequest('resources/read', { uri });
    return result;
  }

  /**
   * Get a prompt
   */
  async getPrompt(name, args = {}) {
    if (!this.connected) {
      throw new Error('MCP client not connected');
    }

    const result = await this._sendRequest('prompts/get', {
      name,
      arguments: args,
    });
    return result;
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect() {
    this.connected = false;

    // Clear pending requests
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error('Client disconnected'));
    }
    this.pendingRequests.clear();

    // Kill the process if stdio
    if (this.type === 'stdio' && this.process) {
      this.process.kill();
      this.process = null;
    }

    this.emit('disconnected');
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Get server info
   */
  getInfo() {
    return {
      name: this.name,
      type: this.type,
      connected: this.connected,
      toolCount: this.tools.length,
      resourceCount: this.resources.length,
      promptCount: this.prompts.length,
    };
  }
}

/**
 * MCPRegistry - Manages multiple MCP server connections
 */
class MCPRegistry {
  constructor() {
    this.clients = new Map();
    this.logger = null;
  }

  /**
   * Register and connect to an MCP server
   */
  async register(config) {
    if (this.clients.has(config.name)) {
      throw new Error(`MCP server already registered: ${config.name}`);
    }

    const client = new MCPClient(config);
    client.logger = this.logger;

    await client.connect();
    this.clients.set(config.name, client);

    if (this.logger) {
      this.logger.info({ server: config.name }, 'MCP server registered');
    }

    return client;
  }

  /**
   * Get a registered MCP client
   */
  get(name) {
    return this.clients.get(name);
  }

  /**
   * List all registered MCP servers
   */
  list() {
    return Array.from(this.clients.values()).map(c => c.getInfo());
  }

  /**
   * Get all available tools across all MCP servers
   */
  async getAllTools() {
    const allTools = [];
    for (const [name, client] of this.clients) {
      const tools = await client.listTools();
      for (const tool of tools) {
        allTools.push({
          ...tool,
          server: name,
          fullName: `${name}:${tool.name}`,
        });
      }
    }
    return allTools;
  }

  /**
   * Call a tool by full name (server:toolName)
   */
  async callTool(fullName, args = {}) {
    const [serverName, toolName] = fullName.split(':');
    const client = this.clients.get(serverName);

    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    return client.callTool(toolName, args);
  }

  /**
   * Disconnect all MCP servers
   */
  async disconnectAll() {
    for (const [name, client] of this.clients) {
      await client.disconnect();
    }
    this.clients.clear();
  }
}

module.exports = { MCPClient, MCPRegistry };
