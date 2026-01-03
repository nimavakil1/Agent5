/**
 * ModuleAssistantTools - Tool definitions and implementations for the Module Assistant
 *
 * These tools allow the assistant to query real data from:
 * - Odoo ERP (orders, products, inventory, invoices)
 * - MongoDB (Amazon orders, Bol orders, sync status)
 */

const { OdooDirectClient } = require('../integrations/OdooMCP');
const { getDb } = require('../../../db');

// Tool definitions for Claude function calling
const TOOL_DEFINITIONS = [
  {
    name: 'query_odoo_orders',
    description: 'Query sale orders from Odoo ERP. Can filter by order name prefix (FBM, FBA, FBB, BOL), date range, state, and customer. Returns order details including totals and status.',
    input_schema: {
      type: 'object',
      properties: {
        prefix: {
          type: 'string',
          description: 'Order name prefix to filter (e.g., "FBM", "FBA", "FBB", "BOL"). Leave empty for all orders.',
        },
        date_from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        date_to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        state: {
          type: 'string',
          enum: ['draft', 'sent', 'sale', 'done', 'cancel'],
          description: 'Order state to filter by',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of orders to return (default 50, max 500)',
        },
        count_only: {
          type: 'boolean',
          description: 'If true, only return the count of matching orders',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_odoo_invoices',
    description: 'Query invoices from Odoo ERP. Can filter by journal, date range, state, and partner.',
    input_schema: {
      type: 'object',
      properties: {
        journal_code: {
          type: 'string',
          description: 'Journal code (e.g., "VFR", "VDE", "INV")',
        },
        date_from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        date_to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        state: {
          type: 'string',
          enum: ['draft', 'posted', 'cancel'],
          description: 'Invoice state',
        },
        move_type: {
          type: 'string',
          enum: ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'],
          description: 'Move type (out_invoice = customer invoice, in_invoice = vendor bill)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of invoices to return (default 50, max 500)',
        },
        count_only: {
          type: 'boolean',
          description: 'If true, only return the count',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_odoo_products',
    description: 'Query products from Odoo ERP. Can search by SKU, name, or category.',
    input_schema: {
      type: 'object',
      properties: {
        sku: {
          type: 'string',
          description: 'Product SKU (default_code) to search for',
        },
        name: {
          type: 'string',
          description: 'Product name to search for (partial match)',
        },
        category: {
          type: 'string',
          description: 'Product category name to filter by',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of products to return (default 50)',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_odoo_stock',
    description: 'Query stock/inventory levels from Odoo. Can filter by product, warehouse, or location.',
    input_schema: {
      type: 'object',
      properties: {
        product_sku: {
          type: 'string',
          description: 'Product SKU to check stock for',
        },
        warehouse_code: {
          type: 'string',
          description: 'Warehouse code (e.g., "CW", "BOL")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of stock records to return',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_odoo_deliveries',
    description: 'Query delivery orders (stock.picking) from Odoo. Can filter by state and type.',
    input_schema: {
      type: 'object',
      properties: {
        picking_type: {
          type: 'string',
          description: 'Picking type prefix (e.g., "CW/OUT", "BOL/OUT")',
        },
        state: {
          type: 'string',
          enum: ['draft', 'waiting', 'confirmed', 'assigned', 'done', 'cancel'],
          description: 'Delivery state',
        },
        date_from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        date_to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        limit: {
          type: 'number',
          description: 'Maximum number to return (default 50)',
        },
        count_only: {
          type: 'boolean',
          description: 'If true, only return the count',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_amazon_orders',
    description: 'Query Amazon seller orders from MongoDB. Can filter by status, fulfillment channel, and date.',
    input_schema: {
      type: 'object',
      properties: {
        fulfillment_channel: {
          type: 'string',
          enum: ['AFN', 'MFN'],
          description: 'AFN = FBA (Fulfilled by Amazon), MFN = FBM (Fulfilled by Merchant)',
        },
        order_status: {
          type: 'string',
          enum: ['Pending', 'Unshipped', 'Shipped', 'Canceled', 'Unfulfillable'],
          description: 'Order status to filter by',
        },
        date_from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        date_to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of orders to return (default 50)',
        },
        count_only: {
          type: 'boolean',
          description: 'If true, only return the count',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_bol_orders',
    description: 'Query Bol.com orders from MongoDB. Can filter by fulfillment type and date.',
    input_schema: {
      type: 'object',
      properties: {
        fulfillment_type: {
          type: 'string',
          enum: ['FBB', 'FBR'],
          description: 'FBB = Fulfilled by Bol, FBR = Fulfilled by Retailer',
        },
        date_from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        date_to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of orders to return (default 50)',
        },
        count_only: {
          type: 'boolean',
          description: 'If true, only return the count',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_sync_status',
    description: 'Get the synchronization status for a module (Amazon, Bol.com, etc.). Shows last sync time and any errors.',
    input_schema: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          enum: ['amazon_seller', 'amazon_vendor', 'bol', 'odoo'],
          description: 'Module to check sync status for',
        },
      },
      required: ['module'],
    },
  },
  {
    name: 'get_order_details',
    description: 'Get detailed information about a specific order by its ID or reference number.',
    input_schema: {
      type: 'object',
      properties: {
        order_ref: {
          type: 'string',
          description: 'Order reference (e.g., Amazon order ID "123-4567890-1234567" or Odoo order name "FBM12345")',
        },
        source: {
          type: 'string',
          enum: ['odoo', 'amazon', 'bol'],
          description: 'Where to look for the order',
        },
      },
      required: ['order_ref'],
    },
  },
];

/**
 * Tool implementations
 */
class ModuleAssistantToolExecutor {
  constructor() {
    this.odoo = null;
  }

  async getOdoo() {
    if (!this.odoo) {
      this.odoo = new OdooDirectClient();
      await this.odoo.authenticate();
    }
    return this.odoo;
  }

  /**
   * Execute a tool by name
   */
  async execute(toolName, params) {
    const method = this[toolName];
    if (!method) {
      return { error: `Unknown tool: ${toolName}` };
    }

    try {
      return await method.call(this, params);
    } catch (error) {
      console.error(`[ModuleAssistantTools] Error executing ${toolName}:`, error);
      return { error: error.message };
    }
  }

  /**
   * Query Odoo sale orders
   */
  async query_odoo_orders(params) {
    const odoo = await this.getOdoo();
    const domain = [];

    if (params.prefix) {
      domain.push(['name', 'like', `${params.prefix}%`]);
    }
    if (params.date_from) {
      domain.push(['date_order', '>=', `${params.date_from} 00:00:00`]);
    }
    if (params.date_to) {
      domain.push(['date_order', '<=', `${params.date_to} 23:59:59`]);
    }
    if (params.state) {
      domain.push(['state', '=', params.state]);
    }

    const limit = Math.min(params.limit || 50, 500);

    if (params.count_only) {
      const ids = await odoo.search('sale.order', domain);
      return { count: ids.length, filters: params };
    }

    const orders = await odoo.searchRead(
      'sale.order',
      domain,
      ['id', 'name', 'date_order', 'partner_id', 'amount_total', 'state', 'invoice_status', 'client_order_ref'],
      { limit, order: 'date_order desc' }
    );

    return {
      orders: orders.map(o => ({
        id: o.id,
        name: o.name,
        date: o.date_order,
        customer: o.partner_id ? o.partner_id[1] : null,
        total: o.amount_total,
        state: o.state,
        invoice_status: o.invoice_status,
        external_ref: o.client_order_ref,
      })),
      count: orders.length,
      filters: params,
    };
  }

  /**
   * Query Odoo invoices
   */
  async query_odoo_invoices(params) {
    const odoo = await this.getOdoo();
    const domain = [['move_type', '=', params.move_type || 'out_invoice']];

    if (params.journal_code) {
      domain.push(['journal_id.code', '=', params.journal_code]);
    }
    if (params.date_from) {
      domain.push(['invoice_date', '>=', params.date_from]);
    }
    if (params.date_to) {
      domain.push(['invoice_date', '<=', params.date_to]);
    }
    if (params.state) {
      domain.push(['state', '=', params.state]);
    }

    const limit = Math.min(params.limit || 50, 500);

    if (params.count_only) {
      const ids = await odoo.search('account.move', domain);
      return { count: ids.length, filters: params };
    }

    const invoices = await odoo.searchRead(
      'account.move',
      domain,
      ['id', 'name', 'invoice_date', 'partner_id', 'amount_total', 'state', 'journal_id', 'invoice_origin'],
      { limit, order: 'invoice_date desc' }
    );

    return {
      invoices: invoices.map(i => ({
        id: i.id,
        name: i.name,
        date: i.invoice_date,
        customer: i.partner_id ? i.partner_id[1] : null,
        total: i.amount_total,
        state: i.state,
        journal: i.journal_id ? i.journal_id[1] : null,
        origin: i.invoice_origin,
      })),
      count: invoices.length,
      filters: params,
    };
  }

  /**
   * Query Odoo products
   */
  async query_odoo_products(params) {
    const odoo = await this.getOdoo();
    const domain = [];

    if (params.sku) {
      domain.push(['default_code', 'ilike', params.sku]);
    }
    if (params.name) {
      domain.push(['name', 'ilike', params.name]);
    }
    if (params.category) {
      domain.push(['categ_id.name', 'ilike', params.category]);
    }

    const limit = Math.min(params.limit || 50, 200);

    const products = await odoo.searchRead(
      'product.product',
      domain,
      ['id', 'name', 'default_code', 'list_price', 'qty_available', 'categ_id', 'active'],
      { limit }
    );

    return {
      products: products.map(p => ({
        id: p.id,
        name: p.name,
        sku: p.default_code,
        price: p.list_price,
        qty_available: p.qty_available,
        category: p.categ_id ? p.categ_id[1] : null,
        active: p.active,
      })),
      count: products.length,
    };
  }

  /**
   * Query Odoo stock levels
   */
  async query_odoo_stock(params) {
    const odoo = await this.getOdoo();
    const domain = [['quantity', '>', 0]];

    if (params.product_sku) {
      // Find product first
      const products = await odoo.searchRead(
        'product.product',
        [['default_code', '=', params.product_sku]],
        ['id']
      );
      if (products.length > 0) {
        domain.push(['product_id', '=', products[0].id]);
      } else {
        return { error: `Product with SKU ${params.product_sku} not found` };
      }
    }

    if (params.warehouse_code) {
      domain.push(['location_id.name', 'ilike', `${params.warehouse_code}%`]);
    }

    const limit = Math.min(params.limit || 100, 500);

    const quants = await odoo.searchRead(
      'stock.quant',
      domain,
      ['id', 'product_id', 'location_id', 'quantity', 'reserved_quantity'],
      { limit }
    );

    return {
      stock: quants.map(q => ({
        product: q.product_id ? q.product_id[1] : null,
        location: q.location_id ? q.location_id[1] : null,
        quantity: q.quantity,
        reserved: q.reserved_quantity,
        available: q.quantity - q.reserved_quantity,
      })),
      count: quants.length,
    };
  }

  /**
   * Query Odoo deliveries
   */
  async query_odoo_deliveries(params) {
    const odoo = await this.getOdoo();
    const domain = [];

    if (params.picking_type) {
      domain.push(['name', 'like', `${params.picking_type}%`]);
    }
    if (params.state) {
      domain.push(['state', '=', params.state]);
    }
    if (params.date_from) {
      domain.push(['scheduled_date', '>=', `${params.date_from} 00:00:00`]);
    }
    if (params.date_to) {
      domain.push(['scheduled_date', '<=', `${params.date_to} 23:59:59`]);
    }

    const limit = Math.min(params.limit || 50, 500);

    if (params.count_only) {
      const ids = await odoo.search('stock.picking', domain);
      return { count: ids.length, filters: params };
    }

    const pickings = await odoo.searchRead(
      'stock.picking',
      domain,
      ['id', 'name', 'origin', 'partner_id', 'scheduled_date', 'state', 'location_id', 'location_dest_id'],
      { limit, order: 'scheduled_date desc' }
    );

    return {
      deliveries: pickings.map(p => ({
        id: p.id,
        name: p.name,
        origin: p.origin,
        partner: p.partner_id ? p.partner_id[1] : null,
        scheduled_date: p.scheduled_date,
        state: p.state,
        from_location: p.location_id ? p.location_id[1] : null,
        to_location: p.location_dest_id ? p.location_dest_id[1] : null,
      })),
      count: pickings.length,
      filters: params,
    };
  }

  /**
   * Query Amazon orders from MongoDB
   */
  async query_amazon_orders(params) {
    const db = getDb();
    if (!db) {
      return { error: 'Database not connected' };
    }

    const query = {};

    if (params.fulfillment_channel) {
      query.fulfillmentChannel = params.fulfillment_channel;
    }
    if (params.order_status) {
      query.orderStatus = params.order_status;
    }
    if (params.date_from || params.date_to) {
      query.purchaseDate = {};
      if (params.date_from) {
        query.purchaseDate.$gte = new Date(params.date_from);
      }
      if (params.date_to) {
        query.purchaseDate.$lte = new Date(params.date_to + 'T23:59:59Z');
      }
    }

    const limit = Math.min(params.limit || 50, 500);

    if (params.count_only) {
      const count = await db.collection('seller_orders').countDocuments(query);
      return { count, filters: params };
    }

    const orders = await db.collection('seller_orders')
      .find(query)
      .sort({ purchaseDate: -1 })
      .limit(limit)
      .toArray();

    return {
      orders: orders.map(o => ({
        amazonOrderId: o.amazonOrderId,
        purchaseDate: o.purchaseDate,
        orderStatus: o.orderStatus,
        fulfillmentChannel: o.fulfillmentChannel,
        orderTotal: o.orderTotal,
        buyerName: o.buyerName,
        odooSynced: !!o.odoo?.saleOrderId,
      })),
      count: orders.length,
      filters: params,
    };
  }

  /**
   * Query Bol.com orders from MongoDB
   */
  async query_bol_orders(params) {
    const db = getDb();
    if (!db) {
      return { error: 'Database not connected' };
    }

    const query = {};

    if (params.fulfillment_type) {
      query['fulfilment.method'] = params.fulfillment_type;
    }
    if (params.date_from || params.date_to) {
      query.orderPlacedDateTime = {};
      if (params.date_from) {
        query.orderPlacedDateTime.$gte = new Date(params.date_from);
      }
      if (params.date_to) {
        query.orderPlacedDateTime.$lte = new Date(params.date_to + 'T23:59:59Z');
      }
    }

    const limit = Math.min(params.limit || 50, 500);

    if (params.count_only) {
      const count = await db.collection('bol_orders').countDocuments(query);
      return { count, filters: params };
    }

    const orders = await db.collection('bol_orders')
      .find(query)
      .sort({ orderPlacedDateTime: -1 })
      .limit(limit)
      .toArray();

    return {
      orders: orders.map(o => ({
        orderId: o.orderId,
        orderPlacedDateTime: o.orderPlacedDateTime,
        fulfilmentMethod: o.fulfilment?.method,
        orderItems: o.orderItems?.length || 0,
      })),
      count: orders.length,
      filters: params,
    };
  }

  /**
   * Get sync status for a module
   */
  async get_sync_status(params) {
    const db = getDb();
    if (!db) {
      return { error: 'Database not connected' };
    }

    const status = await db.collection('sync_status').findOne({ module: params.module });

    if (!status) {
      return { module: params.module, status: 'No sync status found' };
    }

    return {
      module: params.module,
      lastSync: status.lastSync,
      lastSuccess: status.lastSuccess,
      lastError: status.lastError,
      errorMessage: status.errorMessage,
      syncCount: status.syncCount,
    };
  }

  /**
   * Get details for a specific order
   */
  async get_order_details(params) {
    const orderRef = params.order_ref;
    const source = params.source;

    // Try to auto-detect source from order format
    let detectedSource = source;
    if (!detectedSource) {
      if (/^\d{3}-\d{7}-\d{7}$/.test(orderRef)) {
        detectedSource = 'amazon';
      } else if (/^FBM|^FBA|^FBB|^BOL/.test(orderRef)) {
        detectedSource = 'odoo';
      } else if (/^\d{10}$/.test(orderRef)) {
        detectedSource = 'bol';
      } else {
        detectedSource = 'odoo';
      }
    }

    if (detectedSource === 'odoo') {
      const odoo = await this.getOdoo();

      // Search by name or client_order_ref
      let orders = await odoo.searchRead(
        'sale.order',
        [['name', '=', orderRef]],
        ['id', 'name', 'date_order', 'partner_id', 'amount_total', 'state', 'invoice_status', 'client_order_ref', 'order_line', 'picking_ids', 'invoice_ids']
      );

      if (orders.length === 0) {
        orders = await odoo.searchRead(
          'sale.order',
          [['client_order_ref', '=', orderRef]],
          ['id', 'name', 'date_order', 'partner_id', 'amount_total', 'state', 'invoice_status', 'client_order_ref', 'order_line', 'picking_ids', 'invoice_ids']
        );
      }

      if (orders.length === 0) {
        return { error: `Order ${orderRef} not found in Odoo` };
      }

      const order = orders[0];

      // Get order lines
      const lines = await odoo.searchRead(
        'sale.order.line',
        [['order_id', '=', order.id]],
        ['product_id', 'product_uom_qty', 'price_unit', 'price_subtotal']
      );

      return {
        source: 'odoo',
        order: {
          id: order.id,
          name: order.name,
          date: order.date_order,
          customer: order.partner_id ? order.partner_id[1] : null,
          total: order.amount_total,
          state: order.state,
          invoice_status: order.invoice_status,
          external_ref: order.client_order_ref,
          lines: lines.map(l => ({
            product: l.product_id ? l.product_id[1] : null,
            quantity: l.product_uom_qty,
            unit_price: l.price_unit,
            subtotal: l.price_subtotal,
          })),
          delivery_count: order.picking_ids?.length || 0,
          invoice_count: order.invoice_ids?.length || 0,
        },
      };
    }

    if (detectedSource === 'amazon') {
      const db = getDb();
      if (!db) {
        return { error: 'Database not connected' };
      }

      const order = await db.collection('seller_orders').findOne({ amazonOrderId: orderRef });

      if (!order) {
        return { error: `Amazon order ${orderRef} not found` };
      }

      return {
        source: 'amazon',
        order: {
          amazonOrderId: order.amazonOrderId,
          purchaseDate: order.purchaseDate,
          orderStatus: order.orderStatus,
          fulfillmentChannel: order.fulfillmentChannel,
          orderTotal: order.orderTotal,
          buyerName: order.buyerName,
          shippingAddress: order.shippingAddress ? {
            city: order.shippingAddress.city,
            countryCode: order.shippingAddress.countryCode,
          } : null,
          items: order.items,
          odoo: order.odoo,
        },
      };
    }

    if (detectedSource === 'bol') {
      const db = getDb();
      if (!db) {
        return { error: 'Database not connected' };
      }

      const order = await db.collection('bol_orders').findOne({ orderId: orderRef });

      if (!order) {
        return { error: `Bol.com order ${orderRef} not found` };
      }

      return {
        source: 'bol',
        order: {
          orderId: order.orderId,
          orderPlacedDateTime: order.orderPlacedDateTime,
          fulfilmentMethod: order.fulfilment?.method,
          orderItems: order.orderItems,
        },
      };
    }

    return { error: `Unknown source: ${detectedSource}` };
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  ModuleAssistantToolExecutor,
};
