/**
 * DataIngestionPipeline - Unified data collection from multiple sources
 *
 * Collects and normalizes data from:
 * - Odoo (invoices, orders, products, partners)
 * - Amazon Seller Central (future)
 * - Bol.com Partner API (future)
 * - Microsoft Teams (future)
 * - Internal databases
 */

const EventEmitter = require('events');
const { OdooDirectClient } = require('../integrations/OdooMCP');

class DataIngestionPipeline extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = config;
    this.sources = new Map();
    this.cache = new Map();
    this.cacheTTL = config.cacheTTL || 5 * 60 * 1000; // 5 minutes default

    this.logger = null;
    this.running = false;
    this.syncInterval = null;
  }

  /**
   * Initialize the pipeline
   */
  async init(platform) {
    this.logger = platform.logger.child({ service: 'DataIngestionPipeline' });

    // Initialize data sources
    await this._initializeSources();

    this.logger.info('Data ingestion pipeline initialized');
  }

  /**
   * Start periodic data sync
   */
  async start() {
    this.running = true;

    // Initial sync
    await this.syncAll();

    // Setup periodic sync (every 15 minutes)
    this.syncInterval = setInterval(() => {
      if (this.running) {
        this.syncAll().catch(err => {
          this.logger.error({ error: err.message }, 'Periodic sync failed');
        });
      }
    }, 15 * 60 * 1000);

    this.logger.info('Data ingestion pipeline started');
  }

  /**
   * Stop the pipeline
   */
  async stop() {
    this.running = false;

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    this.cache.clear();
    this.logger.info('Data ingestion pipeline stopped');
  }

  /**
   * Initialize data sources
   */
  async _initializeSources() {
    // Odoo
    if (process.env.ODOO_URL) {
      try {
        const odoo = new OdooDirectClient();
        await odoo.authenticate();
        this.sources.set('odoo', {
          client: odoo,
          type: 'odoo',
          status: 'connected',
          lastSync: null,
        });
        this.logger.info('Odoo data source connected');
      } catch (error) {
        this.logger.warn({ error: error.message }, 'Odoo data source not available');
      }
    }

    // Amazon (placeholder for future)
    if (process.env.AMAZON_SELLER_ID) {
      this.sources.set('amazon', {
        client: null, // Will be implemented
        type: 'amazon',
        status: 'pending',
        lastSync: null,
      });
    }

    // Bol.com (placeholder for future)
    if (process.env.BOLCOM_CLIENT_ID) {
      this.sources.set('bolcom', {
        client: null, // Will be implemented
        type: 'bolcom',
        status: 'pending',
        lastSync: null,
      });
    }
  }

  /**
   * Sync all data sources
   */
  async syncAll() {
    this.logger.info('Starting full data sync');
    const results = {};

    for (const [name, source] of this.sources) {
      if (source.status !== 'connected') continue;

      try {
        results[name] = await this._syncSource(name, source);
        source.lastSync = new Date();
        this.emit('sourceSync', { source: name, success: true });
      } catch (error) {
        results[name] = { error: error.message };
        this.emit('sourceSync', { source: name, success: false, error: error.message });
        this.logger.error({ source: name, error: error.message }, 'Source sync failed');
      }
    }

    this.emit('syncComplete', results);
    return results;
  }

  /**
   * Sync a specific source
   */
  async _syncSource(name, source) {
    switch (source.type) {
      case 'odoo':
        return this._syncOdoo(source.client);
      case 'amazon':
        return this._syncAmazon(source.client);
      case 'bolcom':
        return this._syncBolcom(source.client);
      default:
        throw new Error(`Unknown source type: ${source.type}`);
    }
  }

  /**
   * Sync Odoo data
   */
  async _syncOdoo(client) {
    const data = {
      syncedAt: new Date(),
      invoices: { count: 0 },
      orders: { count: 0 },
      products: { count: 0 },
      partners: { count: 0 },
    };

    // Sync recent invoices (last 90 days)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const invoices = await client.getInvoices([
      ['invoice_date', '>=', ninetyDaysAgo.toISOString().split('T')[0]],
    ], { limit: 500 });
    data.invoices.count = invoices.length;
    data.invoices.totalAmount = invoices.reduce((sum, i) => sum + i.amount_total, 0);
    this._setCache('odoo:invoices', invoices);

    // Sync sales orders
    const orders = await client.getSalesOrders([
      ['date_order', '>=', ninetyDaysAgo.toISOString().split('T')[0]],
    ], { limit: 500 });
    data.orders.count = orders.length;
    data.orders.totalAmount = orders.reduce((sum, o) => sum + o.amount_total, 0);
    this._setCache('odoo:sales_orders', orders);

    // Sync products with stock
    const products = await client.getProducts([
      ['qty_available', '>', 0],
    ], { limit: 1000 });
    data.products.count = products.length;
    data.products.totalStock = products.reduce((sum, p) => sum + p.qty_available, 0);
    this._setCache('odoo:products', products);

    // Sync active partners
    const partners = await client.getPartners([
      ['active', '=', true],
      '|',
      ['customer_rank', '>', 0],
      ['supplier_rank', '>', 0],
    ], { limit: 1000 });
    data.partners.count = partners.length;
    this._setCache('odoo:partners', partners);

    // Calculate summary stats
    data.summary = {
      unpaidReceivables: invoices
        .filter(i => i.move_type === 'out_invoice' && i.amount_residual > 0)
        .reduce((sum, i) => sum + i.amount_residual, 0),
      unpaidPayables: invoices
        .filter(i => i.move_type === 'in_invoice' && i.amount_residual > 0)
        .reduce((sum, i) => sum + i.amount_residual, 0),
      lowStockProducts: products.filter(p => p.qty_available < 10).length,
    };

    this._setCache('odoo:summary', data.summary);

    return data;
  }

  /**
   * Sync Amazon data (placeholder)
   */
  async _syncAmazon(client) {
    // TODO: Implement Amazon Seller Central sync
    return { status: 'not_implemented' };
  }

  /**
   * Sync Bol.com data (placeholder)
   */
  async _syncBolcom(client) {
    // TODO: Implement Bol.com Partner API sync
    return { status: 'not_implemented' };
  }

  /**
   * Get cached data
   */
  getData(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;

    // Check if expired
    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }

    return cached.data;
  }

  /**
   * Set cache data
   */
  _setCache(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Get summary from all sources
   */
  async getSummary() {
    const summary = {
      timestamp: new Date(),
      sources: {},
    };

    for (const [name, source] of this.sources) {
      summary.sources[name] = {
        status: source.status,
        lastSync: source.lastSync,
      };

      // Add cached summary if available
      const cachedSummary = this.getData(`${name}:summary`);
      if (cachedSummary) {
        summary.sources[name].summary = cachedSummary;
      }
    }

    return summary;
  }

  /**
   * Query data across sources
   */
  async query(options = {}) {
    const { source, type, filters = {} } = options;

    // If specific source requested
    if (source) {
      const cacheKey = `${source}:${type}`;
      let data = this.getData(cacheKey);

      if (!data) {
        // Trigger sync for this source
        const sourceConfig = this.sources.get(source);
        if (sourceConfig && sourceConfig.status === 'connected') {
          await this._syncSource(source, sourceConfig);
          data = this.getData(cacheKey);
        }
      }

      return this._applyFilters(data || [], filters);
    }

    // Query all sources
    const results = {};
    for (const [name] of this.sources) {
      const cacheKey = `${name}:${type}`;
      const data = this.getData(cacheKey);
      if (data) {
        results[name] = this._applyFilters(data, filters);
      }
    }

    return results;
  }

  /**
   * Apply filters to data
   */
  _applyFilters(data, filters) {
    if (!Array.isArray(data)) return data;
    if (Object.keys(filters).length === 0) return data;

    return data.filter(item => {
      for (const [key, value] of Object.entries(filters)) {
        if (typeof value === 'object' && value !== null) {
          // Range filter
          if (value.gte !== undefined && item[key] < value.gte) return false;
          if (value.lte !== undefined && item[key] > value.lte) return false;
          if (value.gt !== undefined && item[key] <= value.gt) return false;
          if (value.lt !== undefined && item[key] >= value.lt) return false;
        } else {
          // Exact match
          if (item[key] !== value) return false;
        }
      }
      return true;
    });
  }

  /**
   * Get source status
   */
  getSourceStatus() {
    const status = {};
    for (const [name, source] of this.sources) {
      status[name] = {
        type: source.type,
        status: source.status,
        lastSync: source.lastSync,
        cacheKeys: Array.from(this.cache.keys()).filter(k => k.startsWith(name)),
      };
    }
    return status;
  }
}

// Singleton
let pipelineInstance = null;

function getDataPipeline() {
  if (!pipelineInstance) {
    pipelineInstance = new DataIngestionPipeline();
  }
  return pipelineInstance;
}

function createDataPipeline(config = {}) {
  pipelineInstance = new DataIngestionPipeline(config);
  return pipelineInstance;
}

module.exports = {
  DataIngestionPipeline,
  getDataPipeline,
  createDataPipeline,
};
