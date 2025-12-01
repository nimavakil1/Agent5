/**
 * OdooMCP - Odoo MCP Server Integration
 *
 * Configures and manages the connection to the Odoo MCP server.
 * Uses mcp-server-odoo for natural language Odoo queries.
 */

// MCPClient import available when needed for MCP server integration
// const { MCPClient } = require('../MCPClient');

/**
 * Create Odoo MCP configuration
 */
function createOdooMCPConfig() {
  // Validate required environment variables
  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing Odoo configuration: ${missing.join(', ')}`);
  }

  return {
    name: 'odoo',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-odoo'],
    env: {
      ODOO_URL: process.env.ODOO_URL,
      ODOO_DB: process.env.ODOO_DB,
      ODOO_USERNAME: process.env.ODOO_USERNAME,
      ODOO_PASSWORD: process.env.ODOO_PASSWORD,
      // Optional: API key if using Odoo.sh
      ODOO_API_KEY: process.env.ODOO_API_KEY || '',
    },
    timeout: 60000,
  };
}

/**
 * OdooTools - Direct Odoo XML-RPC integration as fallback
 *
 * If MCP server is not available, these tools provide direct access.
 */
class OdooDirectClient {
  constructor(config = {}) {
    this.url = config.url || process.env.ODOO_URL;
    this.db = config.db || process.env.ODOO_DB;
    this.username = config.username || process.env.ODOO_USERNAME;
    this.password = config.password || process.env.ODOO_PASSWORD;

    this.uid = null;
    this.authenticated = false;
  }

  /**
   * Authenticate with Odoo
   */
  async authenticate() {
    const response = await this._xmlRpcCall('/xmlrpc/2/common', 'authenticate', [
      this.db,
      this.username,
      this.password,
      {},
    ]);

    if (!response) {
      throw new Error('Odoo authentication failed');
    }

    this.uid = response;
    this.authenticated = true;
    return this.uid;
  }

  /**
   * Execute an Odoo model method
   */
  async execute(model, method, args = [], kwargs = {}) {
    if (!this.authenticated) {
      await this.authenticate();
    }

    return this._xmlRpcCall('/xmlrpc/2/object', 'execute_kw', [
      this.db,
      this.uid,
      this.password,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  /**
   * Search records
   */
  async search(model, domain = [], options = {}) {
    return this.execute(model, 'search', [domain], {
      limit: options.limit || 100,
      offset: options.offset || 0,
      order: options.order || '',
    });
  }

  /**
   * Search and read records
   */
  async searchRead(model, domain = [], fields = [], options = {}) {
    return this.execute(model, 'search_read', [domain], {
      fields,
      limit: options.limit || 100,
      offset: options.offset || 0,
      order: options.order || '',
    });
  }

  /**
   * Read specific records
   */
  async read(model, ids, fields = []) {
    return this.execute(model, 'read', [ids], { fields });
  }

  /**
   * Create a record
   */
  async create(model, values) {
    return this.execute(model, 'create', [values]);
  }

  /**
   * Update records
   */
  async write(model, ids, values) {
    return this.execute(model, 'write', [ids, values]);
  }

  /**
   * Delete records
   */
  async unlink(model, ids) {
    return this.execute(model, 'unlink', [ids]);
  }

  /**
   * Get invoices
   */
  async getInvoices(domain = [], options = {}) {
    return this.searchRead('account.move', [
      ['move_type', 'in', ['out_invoice', 'in_invoice']],
      ...domain,
    ], [
      'name',
      'partner_id',
      'invoice_date',
      'invoice_date_due',
      'amount_total',
      'amount_residual',
      'state',
      'payment_state',
      'move_type',
    ], options);
  }

  /**
   * Get products
   */
  async getProducts(domain = [], options = {}) {
    return this.searchRead('product.product', domain, [
      'name',
      'default_code',
      'list_price',
      'qty_available',
      'virtual_available',
      'categ_id',
    ], options);
  }

  /**
   * Get sales orders
   */
  async getSalesOrders(domain = [], options = {}) {
    return this.searchRead('sale.order', domain, [
      'name',
      'partner_id',
      'date_order',
      'amount_total',
      'state',
      'invoice_status',
    ], options);
  }

  /**
   * Get purchase orders
   */
  async getPurchaseOrders(domain = [], options = {}) {
    return this.searchRead('purchase.order', domain, [
      'name',
      'partner_id',
      'date_order',
      'amount_total',
      'state',
      'invoice_status',
    ], options);
  }

  /**
   * Get partners (customers/suppliers)
   */
  async getPartners(domain = [], options = {}) {
    return this.searchRead('res.partner', domain, [
      'name',
      'email',
      'phone',
      'is_company',
      'customer_rank',
      'supplier_rank',
      'credit',
      'debit',
    ], options);
  }

  /**
   * Make XML-RPC call
   */
  async _xmlRpcCall(endpoint, method, params) {
    const fetch = (await import('node-fetch')).default;

    const body = this._buildXmlRpcRequest(method, params);

    const response = await fetch(`${this.url}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body,
    });

    if (!response.ok) {
      throw new Error(`Odoo API error: ${response.statusText}`);
    }

    const text = await response.text();
    return this._parseXmlRpcResponse(text);
  }

  /**
   * Build XML-RPC request body
   */
  _buildXmlRpcRequest(method, params) {
    const serializeValue = (value) => {
      if (value === null || value === undefined) {
        return '<nil/>';
      }
      if (typeof value === 'boolean') {
        return `<boolean>${value ? '1' : '0'}</boolean>`;
      }
      if (typeof value === 'number') {
        if (Number.isInteger(value)) {
          return `<int>${value}</int>`;
        }
        return `<double>${value}</double>`;
      }
      if (typeof value === 'string') {
        return `<string>${this._escapeXml(value)}</string>`;
      }
      if (Array.isArray(value)) {
        const items = value.map(v => `<value>${serializeValue(v)}</value>`).join('');
        return `<array><data>${items}</data></array>`;
      }
      if (typeof value === 'object') {
        const members = Object.entries(value).map(([k, v]) =>
          `<member><name>${k}</name><value>${serializeValue(v)}</value></member>`
        ).join('');
        return `<struct>${members}</struct>`;
      }
      return `<string>${value}</string>`;
    };

    const paramsXml = params.map(p => `<param><value>${serializeValue(p)}</value></param>`).join('');

    return `<?xml version="1.0"?>
<methodCall>
  <methodName>${method}</methodName>
  <params>${paramsXml}</params>
</methodCall>`;
  }

  /**
   * Parse XML-RPC response
   */
  _parseXmlRpcResponse(xml) {
    // Simple XML-RPC parser
    const parseValue = (xml) => {
      // Handle nil
      if (xml.includes('<nil/>') || xml.includes('<nil></nil>')) {
        return null;
      }

      // Handle boolean
      const boolMatch = xml.match(/<boolean>(\d)<\/boolean>/);
      if (boolMatch) {
        return boolMatch[1] === '1';
      }

      // Handle integer
      const intMatch = xml.match(/<(?:int|i4)>(-?\d+)<\/(?:int|i4)>/);
      if (intMatch) {
        return parseInt(intMatch[1], 10);
      }

      // Handle double
      const doubleMatch = xml.match(/<double>(-?[\d.]+)<\/double>/);
      if (doubleMatch) {
        return parseFloat(doubleMatch[1]);
      }

      // Handle string
      const stringMatch = xml.match(/<string>([\s\S]*?)<\/string>/);
      if (stringMatch) {
        return this._unescapeXml(stringMatch[1]);
      }

      // Handle array
      if (xml.includes('<array>')) {
        const values = [];
        const valueMatches = xml.match(/<value>([\s\S]*?)<\/value>/g) || [];
        for (const match of valueMatches) {
          const inner = match.replace(/<\/?value>/g, '');
          values.push(parseValue(inner));
        }
        return values;
      }

      // Handle struct
      if (xml.includes('<struct>')) {
        const obj = {};
        const memberRegex = /<member>\s*<name>([\s\S]*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g;
        let match;
        while ((match = memberRegex.exec(xml)) !== null) {
          obj[match[1]] = parseValue(match[2]);
        }
        return obj;
      }

      // Default: try to extract plain content
      const plainMatch = xml.match(/>([^<]*)</);
      if (plainMatch) {
        return plainMatch[1];
      }

      return xml;
    };

    // Check for fault
    if (xml.includes('<fault>')) {
      const faultMatch = xml.match(/<fault>([\s\S]*?)<\/fault>/);
      if (faultMatch) {
        const fault = parseValue(faultMatch[1]);
        throw new Error(`Odoo fault: ${fault.faultString || JSON.stringify(fault)}`);
      }
    }

    // Extract value from params
    const valueMatch = xml.match(/<param>\s*<value>([\s\S]*?)<\/value>\s*<\/param>/);
    if (valueMatch) {
      return parseValue(valueMatch[1]);
    }

    return null;
  }

  _escapeXml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  _unescapeXml(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }
}

module.exports = {
  createOdooMCPConfig,
  OdooDirectClient,
};
