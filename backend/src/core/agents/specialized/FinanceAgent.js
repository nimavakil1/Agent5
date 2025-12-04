/**
 * FinanceAgent - Handles all financial operations
 *
 * Capabilities:
 * - Invoice management (view, create, process)
 * - Payment tracking
 * - Financial reporting
 * - Natural language Odoo queries
 * - PDF invoice processing
 */

const { LLMAgent } = require('../LLMAgent');
const { createOdooMCPConfig, OdooDirectClient } = require('../integrations/OdooMCP');

class FinanceAgent extends LLMAgent {
  constructor(config = {}) {
    super({
      name: 'FinanceAgent',
      role: 'finance',
      description: 'Handles all financial operations including invoices, payments, and reporting',
      capabilities: [
        'invoice_management',
        'payment_tracking',
        'financial_reporting',
        'natural_language_queries',
        'pdf_processing',
        'expense_tracking',
        'budget_analysis',
      ],
      systemPrompt: `You are the Finance Agent, responsible for all financial operations.

Your responsibilities include:
1. Managing invoices (viewing, creating, sending)
2. Tracking payments and receivables
3. Generating financial reports
4. Answering questions about financial data
5. Processing PDF invoices
6. Monitoring cash flow

When handling requests:
- Always verify amounts before any financial actions
- Flag any discrepancies or unusual patterns
- Provide clear summaries of financial data
- Use proper currency formatting
- Escalate large transactions for approval

For queries about Odoo data, use the available tools to fetch real-time information.
Always provide context with numbers (e.g., "3 unpaid invoices totaling €15,000").`,

      // Require approval for sensitive operations
      requiresApproval: ['create_invoice', 'process_payment', 'write_off'],
      approvalThresholds: {
        amount: 5000, // Require approval for amounts over €5000
      },

      ...config,
    });

    // Odoo client for direct queries
    this.odooClient = null;
    this.useMCP = true; // Prefer MCP when available
  }

  /**
   * Initialize the Finance Agent
   */
  async init(platform) {
    await super.init(platform);

    // Initialize Odoo client
    try {
      this.odooClient = new OdooDirectClient();
      await this.odooClient.authenticate();
      this.logger.info('Odoo direct client authenticated');
    } catch (error) {
      this.logger.warn({ error: error.message }, 'Odoo direct client not available, will use MCP only');
    }

    this.logger.info('Finance Agent initialized');
  }

  /**
   * Load finance-specific tools
   */
  async _loadTools() {
    // Invoice tools
    this.registerTool('get_invoices', this._getInvoices.bind(this), {
      description: 'Get invoices from Odoo with optional filters',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'posted', 'paid', 'cancelled', 'all'] },
          type: { type: 'string', enum: ['customer', 'vendor', 'all'] },
          partner: { type: 'string', description: 'Partner/customer name to filter by' },
          date_from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
          date_to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          limit: { type: 'number', default: 50 },
        },
      },
    });

    this.registerTool('get_invoice_details', this._getInvoiceDetails.bind(this), {
      description: 'Get detailed information about a specific invoice',
      inputSchema: {
        type: 'object',
        properties: {
          invoice_id: { type: 'number', description: 'Invoice ID' },
          invoice_number: { type: 'string', description: 'Invoice number' },
        },
      },
    });

    this.registerTool('get_unpaid_invoices', this._getUnpaidInvoices.bind(this), {
      description: 'Get all unpaid invoices with aging information',
      inputSchema: {
        type: 'object',
        properties: {
          days_overdue: { type: 'number', description: 'Filter by minimum days overdue' },
        },
      },
    });

    // Financial summary tools
    this.registerTool('get_financial_summary', this._getFinancialSummary.bind(this), {
      description: 'Get a summary of financial status including receivables, payables, and cash flow',
      inputSchema: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['today', 'week', 'month', 'quarter', 'year'] },
        },
      },
    });

    this.registerTool('get_revenue_report', this._getRevenueReport.bind(this), {
      description: 'Get revenue breakdown by period, product, or customer',
      inputSchema: {
        type: 'object',
        properties: {
          group_by: { type: 'string', enum: ['month', 'product', 'customer', 'category'] },
          date_from: { type: 'string' },
          date_to: { type: 'string' },
        },
      },
    });

    // Partner/Customer tools
    this.registerTool('get_partner_balance', this._getPartnerBalance.bind(this), {
      description: 'Get the outstanding balance for a partner (customer or supplier)',
      inputSchema: {
        type: 'object',
        properties: {
          partner_name: { type: 'string', description: 'Name of the partner' },
          partner_id: { type: 'number', description: 'Partner ID' },
        },
      },
    });

    // Product tools
    this.registerTool('search_product', this._searchProduct.bind(this), {
      description: 'Search for a product by reference code, name, or barcode and get its cost/price',
      inputSchema: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'Product reference/SKU code (e.g., 18009)' },
          name: { type: 'string', description: 'Product name to search for' },
          barcode: { type: 'string', description: 'Product barcode' },
        },
      },
    });

    // Natural language query
    this.registerTool('query_odoo', this._queryOdoo.bind(this), {
      description: 'Run a natural language query against Odoo data',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language query about Odoo data' },
        },
        required: ['query'],
      },
    });

    // PDF processing
    this.registerTool('process_invoice_pdf', this._processInvoicePDF.bind(this), {
      description: 'Extract data from a PDF invoice',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the PDF file' },
          file_url: { type: 'string', description: 'URL to the PDF file' },
        },
      },
    });

    this.logger.debug({ toolCount: this.tools.size }, 'Finance tools loaded');
  }

  /**
   * Connect to MCP servers
   */
  async _connectMCPServers() {
    try {
      const odooConfig = createOdooMCPConfig();
      await this.connectMCP(odooConfig);
      this.logger.info('Connected to Odoo MCP server');
    } catch (error) {
      this.logger.warn({ error: error.message }, 'Could not connect to Odoo MCP server, using direct client');
      this.useMCP = false;
    }
  }

  // ============ Tool Implementations ============

  async _getInvoices(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const domain = [];

    // Filter by status
    if (params.status && params.status !== 'all') {
      if (params.status === 'paid') {
        domain.push(['payment_state', '=', 'paid']);
      } else {
        domain.push(['state', '=', params.status]);
      }
    }

    // Filter by type
    if (params.type && params.type !== 'all') {
      domain.push(['move_type', '=', params.type === 'customer' ? 'out_invoice' : 'in_invoice']);
    }

    // Filter by date
    if (params.date_from) {
      domain.push(['invoice_date', '>=', params.date_from]);
    }
    if (params.date_to) {
      domain.push(['invoice_date', '<=', params.date_to]);
    }

    const invoices = await this.odooClient.getInvoices(domain, { limit: params.limit || 50 });

    return {
      count: invoices.length,
      invoices: invoices.map(inv => ({
        id: inv.id,
        number: inv.name,
        partner: inv.partner_id?.[1] || 'Unknown',
        date: inv.invoice_date,
        due_date: inv.invoice_date_due,
        total: inv.amount_total,
        remaining: inv.amount_residual,
        status: inv.state,
        payment_status: inv.payment_state,
        type: inv.move_type === 'out_invoice' ? 'customer' : 'vendor',
      })),
      total_amount: invoices.reduce((sum, inv) => sum + inv.amount_total, 0),
      total_remaining: invoices.reduce((sum, inv) => sum + inv.amount_residual, 0),
    };
  }

  async _getInvoiceDetails(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    let invoiceId = params.invoice_id;

    // Find by number if no ID provided
    if (!invoiceId && params.invoice_number) {
      const results = await this.odooClient.searchRead('account.move', [
        ['name', '=', params.invoice_number],
      ], ['id'], { limit: 1 });

      if (results.length === 0) {
        throw new Error(`Invoice not found: ${params.invoice_number}`);
      }
      invoiceId = results[0].id;
    }

    // Get invoice with full details
    const invoice = await this.odooClient.read('account.move', [invoiceId], [
      'name', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual', 'amount_tax', 'amount_untaxed',
      'state', 'payment_state', 'move_type', 'narration',
      'invoice_line_ids', 'currency_id', 'ref',
    ]);

    if (!invoice || invoice.length === 0) {
      throw new Error(`Invoice not found: ${invoiceId}`);
    }

    const inv = invoice[0];

    // Get line items
    let lines = [];
    if (inv.invoice_line_ids && inv.invoice_line_ids.length > 0) {
      lines = await this.odooClient.read('account.move.line', inv.invoice_line_ids, [
        'name', 'product_id', 'quantity', 'price_unit', 'price_subtotal',
        'tax_ids', 'discount',
      ]);
    }

    return {
      id: inv.id,
      number: inv.name,
      reference: inv.ref,
      partner: inv.partner_id?.[1] || 'Unknown',
      partner_id: inv.partner_id?.[0],
      date: inv.invoice_date,
      due_date: inv.invoice_date_due,
      currency: inv.currency_id?.[1] || 'EUR',
      subtotal: inv.amount_untaxed,
      tax: inv.amount_tax,
      total: inv.amount_total,
      remaining: inv.amount_residual,
      status: inv.state,
      payment_status: inv.payment_state,
      type: inv.move_type === 'out_invoice' ? 'customer' : 'vendor',
      notes: inv.narration,
      lines: lines.map(line => ({
        product: line.product_id?.[1] || line.name,
        description: line.name,
        quantity: line.quantity,
        unit_price: line.price_unit,
        discount: line.discount,
        subtotal: line.price_subtotal,
      })),
    };
  }

  async _getUnpaidInvoices(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const domain = [
      ['state', '=', 'posted'],
      ['payment_state', 'in', ['not_paid', 'partial']],
      ['amount_residual', '>', 0],
    ];

    const invoices = await this.odooClient.getInvoices(domain, { limit: 100 });

    const today = new Date();
    const unpaidWithAging = invoices.map(inv => {
      const dueDate = new Date(inv.invoice_date_due);
      const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));

      return {
        id: inv.id,
        number: inv.name,
        partner: inv.partner_id?.[1] || 'Unknown',
        due_date: inv.invoice_date_due,
        total: inv.amount_total,
        remaining: inv.amount_residual,
        days_overdue: daysOverdue > 0 ? daysOverdue : 0,
        type: inv.move_type === 'out_invoice' ? 'receivable' : 'payable',
      };
    });

    // Filter by days overdue if specified
    let filtered = unpaidWithAging;
    if (params.days_overdue) {
      filtered = unpaidWithAging.filter(inv => inv.days_overdue >= params.days_overdue);
    }

    // Sort by days overdue (descending)
    filtered.sort((a, b) => b.days_overdue - a.days_overdue);

    // Group by aging buckets
    const agingBuckets = {
      current: [],
      '1-30': [],
      '31-60': [],
      '61-90': [],
      'over_90': [],
    };

    for (const inv of filtered) {
      if (inv.days_overdue <= 0) {
        agingBuckets.current.push(inv);
      } else if (inv.days_overdue <= 30) {
        agingBuckets['1-30'].push(inv);
      } else if (inv.days_overdue <= 60) {
        agingBuckets['31-60'].push(inv);
      } else if (inv.days_overdue <= 90) {
        agingBuckets['61-90'].push(inv);
      } else {
        agingBuckets.over_90.push(inv);
      }
    }

    return {
      total_count: filtered.length,
      total_outstanding: filtered.reduce((sum, inv) => sum + inv.remaining, 0),
      receivables: filtered.filter(i => i.type === 'receivable').reduce((sum, inv) => sum + inv.remaining, 0),
      payables: filtered.filter(i => i.type === 'payable').reduce((sum, inv) => sum + inv.remaining, 0),
      aging_summary: {
        current: {
          count: agingBuckets.current.length,
          amount: agingBuckets.current.reduce((s, i) => s + i.remaining, 0),
        },
        '1-30_days': {
          count: agingBuckets['1-30'].length,
          amount: agingBuckets['1-30'].reduce((s, i) => s + i.remaining, 0),
        },
        '31-60_days': {
          count: agingBuckets['31-60'].length,
          amount: agingBuckets['31-60'].reduce((s, i) => s + i.remaining, 0),
        },
        '61-90_days': {
          count: agingBuckets['61-90'].length,
          amount: agingBuckets['61-90'].reduce((s, i) => s + i.remaining, 0),
        },
        'over_90_days': {
          count: agingBuckets.over_90.length,
          amount: agingBuckets.over_90.reduce((s, i) => s + i.remaining, 0),
        },
      },
      invoices: filtered,
    };
  }

  async _getFinancialSummary(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const period = params.period || 'month';
    const today = new Date();
    let dateFrom;

    switch (period) {
      case 'today':
        dateFrom = today.toISOString().split('T')[0];
        break;
      case 'week':
        dateFrom = new Date(today - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        break;
      case 'month':
        dateFrom = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
        break;
      case 'quarter': {
        const quarter = Math.floor(today.getMonth() / 3);
        dateFrom = new Date(today.getFullYear(), quarter * 3, 1).toISOString().split('T')[0];
        break;
      }
      case 'year':
        dateFrom = new Date(today.getFullYear(), 0, 1).toISOString().split('T')[0];
        break;
    }

    // Get customer invoices (revenue)
    const customerInvoices = await this.odooClient.getInvoices([
      ['move_type', '=', 'out_invoice'],
      ['invoice_date', '>=', dateFrom],
      ['state', '=', 'posted'],
    ], { limit: 1000 });

    // Get vendor invoices (expenses)
    const vendorInvoices = await this.odooClient.getInvoices([
      ['move_type', '=', 'in_invoice'],
      ['invoice_date', '>=', dateFrom],
      ['state', '=', 'posted'],
    ], { limit: 1000 });

    // Get unpaid amounts
    const unpaidReceivables = await this.odooClient.getInvoices([
      ['move_type', '=', 'out_invoice'],
      ['payment_state', 'in', ['not_paid', 'partial']],
      ['state', '=', 'posted'],
    ], { limit: 1000 });

    const unpaidPayables = await this.odooClient.getInvoices([
      ['move_type', '=', 'in_invoice'],
      ['payment_state', 'in', ['not_paid', 'partial']],
      ['state', '=', 'posted'],
    ], { limit: 1000 });

    const revenue = customerInvoices.reduce((sum, inv) => sum + inv.amount_total, 0);
    const expenses = vendorInvoices.reduce((sum, inv) => sum + inv.amount_total, 0);
    const receivables = unpaidReceivables.reduce((sum, inv) => sum + inv.amount_residual, 0);
    const payables = unpaidPayables.reduce((sum, inv) => sum + inv.amount_residual, 0);

    return {
      period,
      date_from: dateFrom,
      date_to: today.toISOString().split('T')[0],
      revenue: {
        total: revenue,
        invoice_count: customerInvoices.length,
        average_invoice: customerInvoices.length > 0 ? revenue / customerInvoices.length : 0,
      },
      expenses: {
        total: expenses,
        invoice_count: vendorInvoices.length,
        average_invoice: vendorInvoices.length > 0 ? expenses / vendorInvoices.length : 0,
      },
      gross_profit: revenue - expenses,
      profit_margin: revenue > 0 ? ((revenue - expenses) / revenue * 100).toFixed(2) + '%' : '0%',
      receivables: {
        total: receivables,
        invoice_count: unpaidReceivables.length,
      },
      payables: {
        total: payables,
        invoice_count: unpaidPayables.length,
      },
      net_cash_position: receivables - payables,
    };
  }

  async _getRevenueReport(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const groupBy = params.group_by || 'month';
    const dateFrom = params.date_from || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const dateTo = params.date_to || new Date().toISOString().split('T')[0];

    const invoices = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['invoice_date', '>=', dateFrom],
      ['invoice_date', '<=', dateTo],
    ], [
      'name', 'invoice_date', 'amount_total', 'partner_id', 'invoice_line_ids',
    ], { limit: 1000 });

    const report = {};

    if (groupBy === 'month') {
      for (const inv of invoices) {
        const month = inv.invoice_date.substring(0, 7); // YYYY-MM
        if (!report[month]) {
          report[month] = { count: 0, total: 0 };
        }
        report[month].count++;
        report[month].total += inv.amount_total;
      }
    } else if (groupBy === 'customer') {
      for (const inv of invoices) {
        const customer = inv.partner_id?.[1] || 'Unknown';
        if (!report[customer]) {
          report[customer] = { count: 0, total: 0 };
        }
        report[customer].count++;
        report[customer].total += inv.amount_total;
      }
    }

    // Convert to sorted array
    const sortedReport = Object.entries(report)
      .map(([key, data]) => ({ [groupBy]: key, ...data }))
      .sort((a, b) => b.total - a.total);

    return {
      group_by: groupBy,
      date_from: dateFrom,
      date_to: dateTo,
      total_revenue: invoices.reduce((sum, inv) => sum + inv.amount_total, 0),
      invoice_count: invoices.length,
      breakdown: sortedReport,
    };
  }

  async _getPartnerBalance(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    let partnerId = params.partner_id;

    if (!partnerId && params.partner_name) {
      const partners = await this.odooClient.getPartners([
        ['name', 'ilike', params.partner_name],
      ], { limit: 1 });

      if (partners.length === 0) {
        throw new Error(`Partner not found: ${params.partner_name}`);
      }
      partnerId = partners[0].id;
    }

    // Get partner details
    const partner = await this.odooClient.read('res.partner', [partnerId], [
      'name', 'email', 'phone', 'credit', 'debit', 'total_invoiced',
      'customer_rank', 'supplier_rank',
    ]);

    if (!partner || partner.length === 0) {
      throw new Error(`Partner not found: ${partnerId}`);
    }

    const p = partner[0];

    // Get unpaid invoices for this partner
    const unpaidInvoices = await this.odooClient.getInvoices([
      ['partner_id', '=', partnerId],
      ['payment_state', 'in', ['not_paid', 'partial']],
      ['state', '=', 'posted'],
    ], { limit: 100 });

    return {
      partner: {
        id: p.id,
        name: p.name,
        email: p.email,
        phone: p.phone,
        is_customer: p.customer_rank > 0,
        is_supplier: p.supplier_rank > 0,
      },
      balance: {
        receivable: p.credit,
        payable: p.debit,
        net: p.credit - p.debit,
        total_invoiced: p.total_invoiced,
      },
      unpaid_invoices: unpaidInvoices.map(inv => ({
        number: inv.name,
        date: inv.invoice_date,
        due_date: inv.invoice_date_due,
        total: inv.amount_total,
        remaining: inv.amount_residual,
        type: inv.move_type === 'out_invoice' ? 'receivable' : 'payable',
      })),
    };
  }

  async _searchProduct(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const domain = [];

    if (params.reference) {
      domain.push('|', '|');
      domain.push(['default_code', 'ilike', params.reference]);
      domain.push(['default_code', '=', params.reference]);
      domain.push(['name', 'ilike', params.reference]);
    }
    if (params.name) {
      domain.push(['name', 'ilike', params.name]);
    }
    if (params.barcode) {
      domain.push(['barcode', '=', params.barcode]);
    }

    const products = await this.odooClient.searchRead('product.product', domain, [
      'id', 'name', 'default_code', 'barcode', 'list_price', 'standard_price',
      'qty_available', 'virtual_available', 'type', 'categ_id', 'uom_id'
    ], { limit: 10 });

    if (products.length === 0) {
      return {
        found: false,
        message: `No product found matching: ${params.reference || params.name || params.barcode}`,
      };
    }

    return {
      found: true,
      count: products.length,
      products: products.map(p => ({
        id: p.id,
        name: p.name,
        reference: p.default_code,
        barcode: p.barcode,
        sale_price: p.list_price,
        cost_price: p.standard_price,
        qty_on_hand: p.qty_available,
        qty_forecast: p.virtual_available,
        type: p.type,
        category: p.categ_id?.[1],
        uom: p.uom_id?.[1],
      })),
    };
  }

  async _queryOdoo(params) {
    // Use MCP for natural language queries if available
    if (this.useMCP && this.mcpServers.has('odoo')) {
      const client = this.mcpServers.get('odoo');
      return client.callTool('query', { query: params.query });
    }

    // Otherwise, use LLM to translate to Odoo operations
    const translationPrompt = `Translate this natural language query into Odoo operations:
Query: "${params.query}"

Available methods:
- searchRead(model, domain, fields, options)
- getInvoices(domain, options)
- getProducts(domain, options)
- getSalesOrders(domain, options)
- getPurchaseOrders(domain, options)
- getPartners(domain, options)

Return a JSON object with:
- method: the method to call
- args: arguments for the method`;

    const translation = await this.generateStructured(translationPrompt, {
      type: 'object',
      properties: {
        method: { type: 'string' },
        args: { type: 'object' },
      },
    });

    // Execute the translated query
    const method = this.odooClient[translation.method];
    if (!method) {
      throw new Error(`Unknown method: ${translation.method}`);
    }

    const result = await method.call(this.odooClient, ...Object.values(translation.args));
    return result;
  }

  async _processInvoicePDF(params) {
    // This would integrate with a PDF processing service
    // For now, return a placeholder
    return {
      status: 'pending_implementation',
      message: 'PDF invoice processing will be implemented with document AI integration',
      file: params.file_path || params.file_url,
    };
  }
}

module.exports = { FinanceAgent };
