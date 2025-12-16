/**
 * OdooMCP - Odoo MCP Server Integration
 *
 * Configures and manages the connection to the Odoo MCP server.
 * Uses mcp-server-odoo for natural language Odoo queries.
 * Uses odoo-xmlrpc package for reliable XML-RPC communication.
 */

const Odoo = require('odoo-xmlrpc');

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
 * OdooDirectClient - Direct Odoo XML-RPC integration
 *
 * Uses odoo-xmlrpc package for reliable XML-RPC communication.
 * Provides both generic execute() and convenience methods.
 */
class OdooDirectClient {
  constructor(config = {}) {
    const url = config.url || process.env.ODOO_URL || '';
    const parsedUrl = new URL(url);

    this.config = {
      url: `${parsedUrl.protocol}//${parsedUrl.hostname}`,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 8069),
      db: config.db || process.env.ODOO_DB,
      username: config.username || process.env.ODOO_USERNAME,
      password: config.password || process.env.ODOO_PASSWORD,
    };

    this.client = null;
    this.authenticated = false;
  }

  /**
   * Connect and authenticate with Odoo
   */
  async authenticate() {
    return new Promise((resolve, reject) => {
      this.client = new Odoo(this.config);

      this.client.connect((err) => {
        if (err) {
          reject(new Error(`Odoo authentication failed: ${err.message}`));
          return;
        }

        this.authenticated = true;
        resolve(this.client.uid);
      });
    });
  }

  /**
   * Execute an Odoo model method
   */
  async execute(model, method, args = [], kwargs = {}) {
    if (!this.authenticated) {
      await this.authenticate();
    }

    return new Promise((resolve, reject) => {
      this.client.execute_kw(model, method, [args, kwargs], (err, result) => {
        if (err) {
          reject(new Error(`Odoo execute error: ${err.message}`));
          return;
        }
        resolve(result);
      });
    });
  }

  /**
   * Count records matching domain
   */
  async searchCount(model, domain = []) {
    return this.execute(model, 'search_count', [domain], {});
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

  // ==================== CRM ====================

  /**
   * Get CRM leads
   */
  async getLeads(domain = [], options = {}) {
    return this.searchRead('crm.lead', [
      ['type', '=', 'lead'],
      ...domain,
    ], [
      'name',
      'partner_id',
      'email_from',
      'phone',
      'expected_revenue',
      'probability',
      'stage_id',
      'user_id',
      'team_id',
      'create_date',
      'date_deadline',
      'description',
      'source_id',
      'medium_id',
      'campaign_id',
    ], options);
  }

  /**
   * Get CRM opportunities
   */
  async getOpportunities(domain = [], options = {}) {
    return this.searchRead('crm.lead', [
      ['type', '=', 'opportunity'],
      ...domain,
    ], [
      'name',
      'partner_id',
      'email_from',
      'phone',
      'expected_revenue',
      'probability',
      'stage_id',
      'user_id',
      'team_id',
      'create_date',
      'date_deadline',
      'date_closed',
      'description',
      'source_id',
      'medium_id',
      'campaign_id',
    ], options);
  }

  /**
   * Create a CRM lead
   */
  async createLead(data) {
    return this.create('crm.lead', {
      type: 'lead',
      name: data.name,
      partner_id: data.partnerId || false,
      email_from: data.email || false,
      phone: data.phone || false,
      expected_revenue: data.expectedRevenue || 0,
      description: data.description || false,
      source_id: data.sourceId || false,
      medium_id: data.mediumId || false,
      campaign_id: data.campaignId || false,
      user_id: data.userId || false,
      team_id: data.teamId || false,
    });
  }

  /**
   * Convert lead to opportunity
   */
  async convertLeadToOpportunity(leadId, partnerId = false) {
    return this.execute('crm.lead', 'convert_opportunity', [[leadId]], {
      partner_id: partnerId,
    });
  }

  /**
   * Update lead/opportunity stage
   */
  async updateLeadStage(leadId, stageId) {
    return this.write('crm.lead', [leadId], { stage_id: stageId });
  }

  /**
   * Get CRM pipeline stages
   */
  async getPipelineStages(domain = [], options = {}) {
    return this.searchRead('crm.stage', domain, [
      'name',
      'sequence',
      'is_won',
      'probability',
      'team_id',
    ], options);
  }

  /**
   * Get scheduled activities
   */
  async getActivities(domain = [], options = {}) {
    return this.searchRead('mail.activity', domain, [
      'res_model',
      'res_id',
      'res_name',
      'activity_type_id',
      'summary',
      'note',
      'date_deadline',
      'user_id',
      'state',
    ], options);
  }

  /**
   * Create an activity
   */
  async createActivity(data) {
    return this.create('mail.activity', {
      res_model: data.model,
      res_id: data.recordId,
      activity_type_id: data.activityTypeId,
      summary: data.summary || false,
      note: data.note || false,
      date_deadline: data.deadline,
      user_id: data.userId || false,
    });
  }

  // ==================== ACCOUNTING ====================

  /**
   * Get journal entries (account move lines)
   */
  async getJournalEntries(domain = [], options = {}) {
    return this.searchRead('account.move.line', domain, [
      'move_id',
      'account_id',
      'partner_id',
      'name',
      'ref',
      'date',
      'debit',
      'credit',
      'balance',
      'amount_currency',
      'currency_id',
      'reconciled',
      'journal_id',
    ], options);
  }

  /**
   * Get payments
   */
  async getPayments(domain = [], options = {}) {
    return this.searchRead('account.payment', domain, [
      'name',
      'partner_id',
      'payment_type',
      'partner_type',
      'amount',
      'currency_id',
      'date',
      'ref',
      'journal_id',
      'payment_method_id',
      'state',
      'reconciled_invoices_count',
    ], options);
  }

  /**
   * Create a payment
   */
  async createPayment(data) {
    const paymentId = await this.create('account.payment', {
      partner_id: data.partnerId,
      payment_type: data.paymentType || 'inbound', // 'inbound' or 'outbound'
      partner_type: data.partnerType || 'customer', // 'customer' or 'supplier'
      amount: data.amount,
      currency_id: data.currencyId || false,
      date: data.date || new Date().toISOString().split('T')[0],
      ref: data.reference || false,
      journal_id: data.journalId,
      payment_method_id: data.paymentMethodId || false,
    });

    // Optionally confirm the payment
    if (data.confirm) {
      await this.execute('account.payment', 'action_post', [[paymentId]]);
    }

    return paymentId;
  }

  /**
   * Get bank statements
   */
  async getBankStatements(domain = [], options = {}) {
    return this.searchRead('account.bank.statement', domain, [
      'name',
      'journal_id',
      'date',
      'balance_start',
      'balance_end',
      'balance_end_real',
      'state',
      'line_ids',
    ], options);
  }

  /**
   * Get bank statement lines
   */
  async getBankStatementLines(domain = [], options = {}) {
    return this.searchRead('account.bank.statement.line', domain, [
      'statement_id',
      'date',
      'payment_ref',
      'partner_id',
      'amount',
      'amount_currency',
      'currency_id',
      'is_reconciled',
    ], options);
  }

  /**
   * Get accounts with balances
   */
  async getAccountBalances(domain = [], options = {}) {
    return this.searchRead('account.account', domain, [
      'code',
      'name',
      'account_type',
      'current_balance',
      'reconcile',
      'deprecated',
    ], options);
  }

  /**
   * Get account types summary (for financial reports)
   */
  async getAccountTypeSummary() {
    const accounts = await this.searchRead('account.account', [
      ['deprecated', '=', false],
    ], [
      'code',
      'name',
      'account_type',
      'current_balance',
    ], { limit: 1000 });

    // Group by account type
    const summary = {};
    for (const account of accounts) {
      const type = account.account_type || 'other';
      if (!summary[type]) {
        summary[type] = { accounts: [], total: 0 };
      }
      summary[type].accounts.push(account);
      summary[type].total += account.current_balance || 0;
    }

    return summary;
  }

  /**
   * Get aged receivables
   */
  async getAgedReceivables(partnerId = null) {
    const domain = [
      ['account_id.account_type', '=', 'asset_receivable'],
      ['reconciled', '=', false],
      ['move_id.state', '=', 'posted'],
    ];

    if (partnerId) {
      domain.push(['partner_id', '=', partnerId]);
    }

    return this.searchRead('account.move.line', domain, [
      'partner_id',
      'move_id',
      'date',
      'date_maturity',
      'debit',
      'credit',
      'amount_residual',
      'ref',
    ], { limit: 500, order: 'date_maturity asc' });
  }

  /**
   * Get aged payables
   */
  async getAgedPayables(partnerId = null) {
    const domain = [
      ['account_id.account_type', '=', 'liability_payable'],
      ['reconciled', '=', false],
      ['move_id.state', '=', 'posted'],
    ];

    if (partnerId) {
      domain.push(['partner_id', '=', partnerId]);
    }

    return this.searchRead('account.move.line', domain, [
      'partner_id',
      'move_id',
      'date',
      'date_maturity',
      'debit',
      'credit',
      'amount_residual',
      'ref',
    ], { limit: 500, order: 'date_maturity asc' });
  }

  /**
   * Reconcile invoice with payment
   */
  async reconcileInvoicePayment(invoiceId, paymentId) {
    // Get the receivable/payable lines from invoice and payment
    const invoiceLines = await this.searchRead('account.move.line', [
      ['move_id', '=', invoiceId],
      ['account_id.reconcile', '=', true],
      ['reconciled', '=', false],
    ], ['id']);

    const paymentLines = await this.searchRead('account.move.line', [
      ['payment_id', '=', paymentId],
      ['account_id.reconcile', '=', true],
      ['reconciled', '=', false],
    ], ['id']);

    if (invoiceLines.length === 0 || paymentLines.length === 0) {
      throw new Error('No reconcilable lines found');
    }

    const lineIds = [
      ...invoiceLines.map(l => l.id),
      ...paymentLines.map(l => l.id),
    ];

    return this.execute('account.move.line', 'reconcile', [lineIds]);
  }
}

module.exports = {
  createOdooMCPConfig,
  OdooDirectClient,
};
