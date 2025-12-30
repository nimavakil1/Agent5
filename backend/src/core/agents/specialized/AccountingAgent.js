/**
 * AccountingAgent - Full-service accounting operations for AP/AR, invoices, and reporting
 *
 * Capabilities:
 * - Invoice processing from email (PDF parsing via Vision LLM)
 * - AP/AR workflow automation
 * - Invoice booking & reconciliation in Odoo
 * - Aging reports and financial reporting
 * - Voice interaction via LiveKit
 */

const { LLMAgent } = require('../LLMAgent');
const { createOdooMCPConfig, OdooDirectClient } = require('../integrations/OdooMCP');
const { MicrosoftDirectClient } = require('../integrations/MicrosoftMCP');

// Invoice processing states
const InvoiceProcessingStatus = {
  PENDING: 'pending',
  PARSING: 'parsing',
  MATCHING: 'matching',
  AWAITING_APPROVAL: 'awaiting_approval',
  APPROVED: 'approved',
  BOOKING: 'booking',
  BOOKED: 'booked',
  REJECTED: 'rejected',
  ERROR: 'error',
};

// Transaction types
const TransactionType = {
  AP: 'accounts_payable',
  AR: 'accounts_receivable',
  PAYMENT: 'payment',
  REFUND: 'refund',
  ADJUSTMENT: 'adjustment',
};

class AccountingAgent extends LLMAgent {
  constructor(config = {}) {
    super({
      name: 'AccountingAgent',
      role: 'accounting',
      taskType: 'finance', // Routes to Claude Opus 4.5 for reliable tool use
      description: 'Full-service accounting agent for AP/AR, invoice processing, and financial reporting',
      capabilities: [
        'invoice_processing',
        'ap_workflow',
        'ar_workflow',
        'invoice_reconciliation',
        'email_invoice_extraction',
        'aging_reports',
        'financial_reporting',
        'payment_tracking',
        'voice_interaction',
      ],
      systemPrompt: `You are the Accounting Agent for ACROPAQ, a Belgian e-commerce company.

## Your Identity
You are the accounts payable/receivable specialist, handling all invoice processing, payment tracking, and financial reconciliation with meticulous accuracy.

## Your Capabilities
- **Invoice Processing**: Extract, validate, and book invoices from emails
- **AP Workflow**: Full accounts payable cycle from receipt to payment
- **AR Workflow**: Customer invoicing, aging tracking, collections
- **Reconciliation**: Match invoices to POs, payments to invoices
- **Reporting**: Aging reports, cash flow, financial summaries

## Your Responsibilities

1. **Invoice Processing Pipeline**
   - Monitor email for incoming invoices (PDF attachments)
   - Extract invoice data using OCR/parsing
   - Match to existing POs or supplier records
   - Validate amounts, VAT, and payment terms
   - Route for approval if over threshold
   - Book to Odoo once approved

2. **Accounts Payable**
   - Track vendor invoices and payment due dates
   - Generate aged payables reports
   - Schedule payments based on due dates
   - Reconcile payments with invoices

3. **Accounts Receivable**
   - Track customer payments
   - Generate aged receivables reports
   - Flag overdue accounts for follow-up
   - Process customer credit notes

4. **Compliance & Accuracy**
   - Belgian VAT rules (21%, 12%, 6%, 0%)
   - EU OSS for cross-border sales
   - Always double-check amounts
   - Document all decisions

## Decision Guidelines
- Amounts over €5000 require human approval
- New vendors require approval before first payment
- Any VAT discrepancy must be flagged
- Always verify bank account details before payment

When answering queries, always provide context with numbers (e.g., "3 unpaid invoices totaling €15,000").`,

      // Uses Claude Opus 4.5 for reliable structured data handling
      llmProvider: 'anthropic',
      llmModel: 'opus',
      temperature: 0.2, // Very low for accounting precision

      // Require approval for sensitive operations
      requiresApproval: [
        'book_invoice',
        'create_payment',
        'reconcile_invoice',
        'write_off_balance',
      ],
      approvalThresholds: {
        amount: 5000, // EUR threshold for approval
      },

      ...config,
    });

    // Integration clients
    this.odooClient = null;
    this.msClient = null;
    this.useMCP = true;

    // Configuration
    this.config = {
      defaultPaymentTerms: 30,
      autoMatchThreshold: 0.95, // 95% confidence for auto-matching
      approvalAmountThreshold: config.approvalAmountThreshold || 5000,
      invoiceMonitoringEnabled: config.invoiceMonitoringEnabled !== false,
      monitoredFolders: config.monitoredFolders || ['Invoices', 'Factures'],
    };

    // Processing queues
    this.pendingApprovals = new Map();
    this.voiceSessions = new Map();
  }

  /**
   * Initialize the Accounting Agent
   */
  async init(platform) {
    await super.init(platform);

    // Initialize Odoo client
    try {
      this.odooClient = new OdooDirectClient();
      await this.odooClient.authenticate();
      this.logger.info('Odoo direct client authenticated');
    } catch (error) {
      this.logger.warn({ error: error.message }, 'Odoo direct client not available');
    }

    // Initialize Microsoft client for email access
    try {
      this.msClient = new MicrosoftDirectClient();
      this.logger.info('Microsoft client initialized');
    } catch (error) {
      this.logger.warn({ error: error.message }, 'Microsoft client not available, email features disabled');
    }

    this.logger.info('Accounting Agent initialized');
  }

  /**
   * Load accounting-specific tools
   */
  async _loadTools() {
    // ============ Invoice Management Tools ============

    this.registerTool('get_vendor_invoices', this._getVendorInvoices.bind(this), {
      description: 'Get vendor invoices (accounts payable) from Odoo',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'posted', 'paid', 'cancelled', 'all'], description: 'Invoice status filter' },
          vendor: { type: 'string', description: 'Vendor/supplier name to filter by' },
          date_from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
          date_to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          days_overdue: { type: 'number', description: 'Filter by minimum days overdue' },
          limit: { type: 'number', default: 50 },
        },
      },
    });

    this.registerTool('get_customer_invoices', this._getCustomerInvoices.bind(this), {
      description: 'Get customer invoices (accounts receivable) from Odoo',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'posted', 'paid', 'cancelled', 'all'] },
          customer: { type: 'string', description: 'Customer name to filter by' },
          date_from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
          date_to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          days_overdue: { type: 'number', description: 'Filter by minimum days overdue' },
          limit: { type: 'number', default: 50 },
        },
      },
    });

    this.registerTool('get_invoice_details', this._getInvoiceDetails.bind(this), {
      description: 'Get detailed information about a specific invoice including line items',
      inputSchema: {
        type: 'object',
        properties: {
          invoice_id: { type: 'number', description: 'Odoo invoice ID' },
          invoice_number: { type: 'string', description: 'Invoice number' },
        },
      },
    });

    // ============ Invoice Processing Tools ============

    this.registerTool('get_pending_invoices', this._getPendingInvoices.bind(this), {
      description: 'Get invoices pending processing from the queue',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['received', 'parsed', 'matched', 'manual_review', 'all'] },
          limit: { type: 'number', default: 20 },
        },
      },
    });

    this.registerTool('process_invoice', this._processInvoice.bind(this), {
      description: 'Process a pending invoice (parse, match, and book)',
      inputSchema: {
        type: 'object',
        properties: {
          invoice_id: { type: 'string', description: 'MongoDB invoice ID' },
        },
        required: ['invoice_id'],
      },
    });

    this.registerTool('book_invoice', this._bookInvoice.bind(this), {
      description: 'Book a validated invoice to Odoo (requires approval for amounts over threshold)',
      inputSchema: {
        type: 'object',
        properties: {
          invoice_id: { type: 'string', description: 'MongoDB invoice ID' },
          force: { type: 'boolean', description: 'Force booking even without PO match' },
        },
        required: ['invoice_id'],
      },
    });

    // ============ Matching & Reconciliation Tools ============

    this.registerTool('match_invoice_to_po', this._matchInvoiceToPO.bind(this), {
      description: 'Match a vendor invoice to a purchase order',
      inputSchema: {
        type: 'object',
        properties: {
          invoice_id: { type: 'string', description: 'MongoDB invoice ID or Odoo invoice ID' },
          po_id: { type: 'number', description: 'Odoo purchase order ID' },
          po_name: { type: 'string', description: 'Purchase order name/number' },
        },
        required: ['invoice_id'],
      },
    });

    this.registerTool('reconcile_payment', this._reconcilePayment.bind(this), {
      description: 'Reconcile a payment with one or more invoices',
      inputSchema: {
        type: 'object',
        properties: {
          payment_id: { type: 'number', description: 'Odoo payment ID' },
          invoice_ids: { type: 'array', items: { type: 'number' }, description: 'Invoice IDs to reconcile' },
        },
        required: ['payment_id', 'invoice_ids'],
      },
    });

    this.registerTool('get_unreconciled_items', this._getUnreconciledItems.bind(this), {
      description: 'Get invoices or payments that need reconciliation',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['invoices', 'payments', 'all'] },
          partner_id: { type: 'number', description: 'Filter by partner' },
          days_old: { type: 'number', description: 'Minimum days since creation' },
        },
      },
    });

    // ============ Reporting Tools ============

    this.registerTool('get_aging_report', this._getAgingReport.bind(this), {
      description: 'Get AP or AR aging report with bucket breakdown',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['ap', 'ar'], description: 'Accounts Payable or Receivable' },
          as_of_date: { type: 'string', description: 'Date for aging calculation (default: today)' },
          group_by: { type: 'string', enum: ['vendor', 'customer', 'currency'], default: 'vendor' },
        },
        required: ['type'],
      },
    });

    this.registerTool('get_cash_flow_forecast', this._getCashFlowForecast.bind(this), {
      description: 'Get cash flow projection based on due dates',
      inputSchema: {
        type: 'object',
        properties: {
          days_ahead: { type: 'number', default: 30, description: 'Days to forecast' },
          include_draft: { type: 'boolean', default: false, description: 'Include draft invoices' },
        },
      },
    });

    this.registerTool('get_vat_summary', this._getVATSummary.bind(this), {
      description: 'Get VAT summary for a period',
      inputSchema: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['month', 'quarter', 'year'] },
          year: { type: 'number' },
          quarter: { type: 'number', description: 'Quarter number (1-4)' },
          month: { type: 'number', description: 'Month number (1-12)' },
        },
      },
    });

    // ============ Email Integration Tools ============

    this.registerTool('scan_email_for_invoices', this._scanEmailForInvoices.bind(this), {
      description: 'Scan email inbox for new invoice emails',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Email folder to scan', default: 'Inbox' },
          hours_back: { type: 'number', description: 'Look back this many hours', default: 24 },
          process_immediately: { type: 'boolean', description: 'Start processing found invoices', default: false },
        },
      },
    });

    this.registerTool('extract_invoice_from_email', this._extractInvoiceFromEmail.bind(this), {
      description: 'Extract invoice data from a specific email message',
      inputSchema: {
        type: 'object',
        properties: {
          email_id: { type: 'string', description: 'Email message ID' },
          user_id: { type: 'string', description: 'User ID for email access' },
        },
        required: ['email_id'],
      },
    });

    this.logger.debug({ toolCount: this.tools.size }, 'Accounting tools loaded');
  }

  // ============ Tool Implementations ============

  async _getVendorInvoices(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const domain = [['move_type', '=', 'in_invoice']];

    if (params.status && params.status !== 'all') {
      if (params.status === 'paid') {
        domain.push(['payment_state', '=', 'paid']);
      } else {
        domain.push(['state', '=', params.status]);
      }
    }

    if (params.vendor) {
      domain.push(['partner_id.name', 'ilike', params.vendor]);
    }

    if (params.date_from) {
      domain.push(['invoice_date', '>=', params.date_from]);
    }

    if (params.date_to) {
      domain.push(['invoice_date', '<=', params.date_to]);
    }

    const invoices = await this.odooClient.searchRead('account.move', domain, [
      'id', 'name', 'ref', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual', 'state', 'payment_state', 'currency_id',
    ], { limit: params.limit || 50, order: 'invoice_date desc' });

    // Filter by days overdue if specified
    let filteredInvoices = invoices;
    if (params.days_overdue) {
      const today = new Date();
      filteredInvoices = invoices.filter(inv => {
        if (!inv.invoice_date_due) return false;
        const dueDate = new Date(inv.invoice_date_due);
        const daysOver = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
        return daysOver >= params.days_overdue;
      });
    }

    return {
      count: filteredInvoices.length,
      invoices: filteredInvoices.map(inv => ({
        id: inv.id,
        number: inv.name,
        reference: inv.ref,
        vendor: inv.partner_id?.[1] || 'Unknown',
        vendor_id: inv.partner_id?.[0],
        date: inv.invoice_date,
        due_date: inv.invoice_date_due,
        total: inv.amount_total,
        remaining: inv.amount_residual,
        currency: inv.currency_id?.[1] || 'EUR',
        status: inv.state,
        payment_status: inv.payment_state,
      })),
      total_amount: filteredInvoices.reduce((sum, inv) => sum + inv.amount_total, 0),
      total_remaining: filteredInvoices.reduce((sum, inv) => sum + inv.amount_residual, 0),
    };
  }

  async _getCustomerInvoices(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const domain = [['move_type', '=', 'out_invoice']];

    if (params.status && params.status !== 'all') {
      if (params.status === 'paid') {
        domain.push(['payment_state', '=', 'paid']);
      } else {
        domain.push(['state', '=', params.status]);
      }
    }

    if (params.customer) {
      domain.push(['partner_id.name', 'ilike', params.customer]);
    }

    if (params.date_from) {
      domain.push(['invoice_date', '>=', params.date_from]);
    }

    if (params.date_to) {
      domain.push(['invoice_date', '<=', params.date_to]);
    }

    const invoices = await this.odooClient.searchRead('account.move', domain, [
      'id', 'name', 'ref', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual', 'state', 'payment_state', 'currency_id',
    ], { limit: params.limit || 50, order: 'invoice_date desc' });

    // Filter by days overdue if specified
    let filteredInvoices = invoices;
    if (params.days_overdue) {
      const today = new Date();
      filteredInvoices = invoices.filter(inv => {
        if (!inv.invoice_date_due || inv.payment_state === 'paid') return false;
        const dueDate = new Date(inv.invoice_date_due);
        const daysOver = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
        return daysOver >= params.days_overdue;
      });
    }

    return {
      count: filteredInvoices.length,
      invoices: filteredInvoices.map(inv => ({
        id: inv.id,
        number: inv.name,
        reference: inv.ref,
        customer: inv.partner_id?.[1] || 'Unknown',
        customer_id: inv.partner_id?.[0],
        date: inv.invoice_date,
        due_date: inv.invoice_date_due,
        total: inv.amount_total,
        remaining: inv.amount_residual,
        currency: inv.currency_id?.[1] || 'EUR',
        status: inv.state,
        payment_status: inv.payment_state,
      })),
      total_amount: filteredInvoices.reduce((sum, inv) => sum + inv.amount_total, 0),
      total_remaining: filteredInvoices.reduce((sum, inv) => sum + inv.amount_residual, 0),
    };
  }

  async _getInvoiceDetails(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    let invoiceId = params.invoice_id;

    if (!invoiceId && params.invoice_number) {
      const results = await this.odooClient.searchRead('account.move', [
        ['name', '=', params.invoice_number],
      ], ['id'], { limit: 1 });

      if (results.length === 0) {
        throw new Error(`Invoice not found: ${params.invoice_number}`);
      }
      invoiceId = results[0].id;
    }

    const invoice = await this.odooClient.read('account.move', [invoiceId], [
      'name', 'ref', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual', 'amount_tax', 'amount_untaxed',
      'state', 'payment_state', 'move_type', 'narration',
      'invoice_line_ids', 'currency_id', 'invoice_origin',
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
        'tax_ids', 'discount', 'purchase_line_id',
      ]);
    }

    return {
      id: inv.id,
      number: inv.name,
      reference: inv.ref,
      origin: inv.invoice_origin,
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
      lines: lines.filter(l => l.price_subtotal !== 0).map(line => ({
        id: line.id,
        product: line.product_id?.[1] || line.name,
        product_id: line.product_id?.[0],
        description: line.name,
        quantity: line.quantity,
        unit_price: line.price_unit,
        discount: line.discount,
        subtotal: line.price_subtotal,
        linked_po_line: line.purchase_line_id?.[0],
      })),
    };
  }

  async _getPendingInvoices(params) {
    const VendorInvoice = require('../../../models/VendorInvoice');

    const query = {};
    if (params.status && params.status !== 'all') {
      query.status = params.status;
    } else {
      query.status = { $in: ['received', 'parsed', 'matched', 'manual_review'] };
    }

    const invoices = await VendorInvoice.find(query)
      .sort({ createdAt: -1 })
      .limit(params.limit || 20)
      .lean();

    return {
      count: invoices.length,
      invoices: invoices.map(inv => ({
        id: inv._id.toString(),
        invoice_number: inv.invoice?.number,
        vendor: inv.vendor?.name,
        vendor_vat: inv.vendor?.vatNumber,
        total: inv.totals?.totalAmount,
        currency: inv.invoice?.currency || 'EUR',
        date: inv.invoice?.date,
        due_date: inv.invoice?.dueDate,
        status: inv.status,
        matching_status: inv.matching?.status,
        match_confidence: inv.matching?.matchedPurchaseOrders?.[0]?.matchConfidence,
        source: inv.source?.type,
        received_at: inv.createdAt,
        errors: inv.errors?.length > 0 ? inv.errors[inv.errors.length - 1].message : null,
      })),
    };
  }

  async _processInvoice(params) {
    const VendorInvoice = require('../../../models/VendorInvoice');

    const invoice = await VendorInvoice.findById(params.invoice_id);
    if (!invoice) {
      throw new Error(`Invoice not found: ${params.invoice_id}`);
    }

    // Processing logic would be handled by the InvoiceProcessor service
    // This tool triggers the processing
    const InvoiceProcessor = require('../../../services/accounting/InvoiceProcessor');
    const result = await InvoiceProcessor.processInvoice(invoice._id);

    return result;
  }

  async _bookInvoice(params) {
    const VendorInvoice = require('../../../models/VendorInvoice');

    const invoice = await VendorInvoice.findById(params.invoice_id);
    if (!invoice) {
      throw new Error(`Invoice not found: ${params.invoice_id}`);
    }

    // Check if approval is required
    if (invoice.totals.totalAmount > this.config.approvalAmountThreshold) {
      if (!invoice.approval?.approvedAt) {
        throw new Error(`Invoice requires approval (amount: €${invoice.totals.totalAmount})`);
      }
    }

    // Book via the OdooVendorBillCreator service
    const OdooVendorBillCreator = require('../../../services/accounting/OdooVendorBillCreator');
    const result = await OdooVendorBillCreator.createVendorBill(invoice, { force: params.force });

    return result;
  }

  async _matchInvoiceToPO(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const VendorInvoice = require('../../../models/VendorInvoice');

    // Find the invoice
    const invoice = await VendorInvoice.findById(params.invoice_id);
    if (!invoice) {
      throw new Error(`Invoice not found: ${params.invoice_id}`);
    }

    // Find the PO
    let poId = params.po_id;
    if (!poId && params.po_name) {
      const pos = await this.odooClient.searchRead('purchase.order', [
        ['name', '=', params.po_name],
      ], ['id', 'name', 'partner_id', 'amount_total'], { limit: 1 });

      if (pos.length === 0) {
        throw new Error(`Purchase order not found: ${params.po_name}`);
      }
      poId = pos[0].id;
    }

    // Get PO details
    const po = await this.odooClient.read('purchase.order', [poId], [
      'name', 'partner_id', 'amount_total', 'state', 'order_line',
    ]);

    if (!po || po.length === 0) {
      throw new Error(`Purchase order not found: ${poId}`);
    }

    const poData = po[0];

    // Update the invoice with match info
    invoice.matching = invoice.matching || {};
    invoice.matching.status = 'matched';
    invoice.matching.matchedPurchaseOrders = [{
      odooPoId: poData.id,
      poName: poData.name,
      matchConfidence: 100, // Manual match
    }];
    invoice.matching.matchAttemptedAt = new Date();

    await invoice.save();

    return {
      success: true,
      invoice_id: invoice._id.toString(),
      matched_po: {
        id: poData.id,
        name: poData.name,
        vendor: poData.partner_id?.[1],
        amount: poData.amount_total,
      },
    };
  }

  async _reconcilePayment(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    // This would use Odoo's reconciliation methods
    const result = await this.odooClient.reconcileInvoicePayment(
      params.invoice_ids,
      params.payment_id
    );

    return {
      success: true,
      reconciled_invoices: params.invoice_ids,
      payment_id: params.payment_id,
    };
  }

  async _getUnreconciledItems(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const result = { invoices: [], payments: [] };
    const today = new Date().toISOString().split('T')[0];

    if (params.type === 'invoices' || params.type === 'all') {
      const domain = [
        ['state', '=', 'posted'],
        ['payment_state', 'in', ['not_paid', 'partial']],
      ];

      if (params.partner_id) {
        domain.push(['partner_id', '=', params.partner_id]);
      }

      const invoices = await this.odooClient.searchRead('account.move', domain, [
        'id', 'name', 'partner_id', 'invoice_date', 'amount_residual', 'move_type',
      ], { limit: 100 });

      result.invoices = invoices.map(inv => ({
        id: inv.id,
        number: inv.name,
        partner: inv.partner_id?.[1],
        date: inv.invoice_date,
        remaining: inv.amount_residual,
        type: inv.move_type === 'out_invoice' ? 'customer' : 'vendor',
      }));
    }

    if (params.type === 'payments' || params.type === 'all') {
      const domain = [
        ['state', '=', 'posted'],
        ['is_reconciled', '=', false],
      ];

      if (params.partner_id) {
        domain.push(['partner_id', '=', params.partner_id]);
      }

      const payments = await this.odooClient.searchRead('account.payment', domain, [
        'id', 'name', 'partner_id', 'date', 'amount', 'payment_type',
      ], { limit: 100 });

      result.payments = payments.map(pmt => ({
        id: pmt.id,
        name: pmt.name,
        partner: pmt.partner_id?.[1],
        date: pmt.date,
        amount: pmt.amount,
        type: pmt.payment_type,
      }));
    }

    return result;
  }

  async _getAgingReport(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const asOfDate = params.as_of_date ? new Date(params.as_of_date) : new Date();
    const moveType = params.type === 'ap' ? 'in_invoice' : 'out_invoice';

    // Get unpaid invoices
    const invoices = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', moveType],
      ['state', '=', 'posted'],
      ['payment_state', 'in', ['not_paid', 'partial']],
    ], [
      'id', 'name', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual',
    ], { limit: 1000 });

    // Calculate aging buckets
    const buckets = {
      current: { count: 0, amount: 0, invoices: [] },
      '1-30': { count: 0, amount: 0, invoices: [] },
      '31-60': { count: 0, amount: 0, invoices: [] },
      '61-90': { count: 0, amount: 0, invoices: [] },
      '90+': { count: 0, amount: 0, invoices: [] },
    };

    for (const inv of invoices) {
      const dueDate = new Date(inv.invoice_date_due || inv.invoice_date);
      const daysOverdue = Math.floor((asOfDate - dueDate) / (1000 * 60 * 60 * 24));

      let bucket;
      if (daysOverdue <= 0) bucket = 'current';
      else if (daysOverdue <= 30) bucket = '1-30';
      else if (daysOverdue <= 60) bucket = '31-60';
      else if (daysOverdue <= 90) bucket = '61-90';
      else bucket = '90+';

      buckets[bucket].count += 1;
      buckets[bucket].amount += inv.amount_residual;
      buckets[bucket].invoices.push({
        id: inv.id,
        number: inv.name,
        partner: inv.partner_id?.[1],
        due_date: inv.invoice_date_due,
        days_overdue: daysOverdue,
        remaining: inv.amount_residual,
      });
    }

    return {
      type: params.type,
      as_of_date: asOfDate.toISOString().split('T')[0],
      total_count: invoices.length,
      total_amount: invoices.reduce((sum, inv) => sum + inv.amount_residual, 0),
      buckets,
    };
  }

  async _getCashFlowForecast(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const daysAhead = params.days_ahead || 30;
    const today = new Date();
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + daysAhead);

    const todayStr = today.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    const stateFilter = params.include_draft
      ? ['state', 'in', ['draft', 'posted']]
      : ['state', '=', 'posted'];

    // Get receivables (inflows)
    const receivables = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'out_invoice'],
      stateFilter,
      ['payment_state', 'in', ['not_paid', 'partial']],
      ['invoice_date_due', '>=', todayStr],
      ['invoice_date_due', '<=', endDateStr],
    ], [
      'invoice_date_due', 'amount_residual', 'partner_id',
    ], { limit: 500 });

    // Get payables (outflows)
    const payables = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'in_invoice'],
      stateFilter,
      ['payment_state', 'in', ['not_paid', 'partial']],
      ['invoice_date_due', '>=', todayStr],
      ['invoice_date_due', '<=', endDateStr],
    ], [
      'invoice_date_due', 'amount_residual', 'partner_id',
    ], { limit: 500 });

    // Group by week
    const weeks = [];
    let currentDate = new Date(today);
    while (currentDate <= endDate) {
      const weekStart = new Date(currentDate);
      const weekEnd = new Date(currentDate);
      weekEnd.setDate(weekEnd.getDate() + 6);

      const weekReceivables = receivables.filter(r => {
        const due = new Date(r.invoice_date_due);
        return due >= weekStart && due <= weekEnd;
      });

      const weekPayables = payables.filter(p => {
        const due = new Date(p.invoice_date_due);
        return due >= weekStart && due <= weekEnd;
      });

      weeks.push({
        week_start: weekStart.toISOString().split('T')[0],
        week_end: weekEnd.toISOString().split('T')[0],
        inflows: weekReceivables.reduce((sum, r) => sum + r.amount_residual, 0),
        outflows: weekPayables.reduce((sum, p) => sum + p.amount_residual, 0),
        net: weekReceivables.reduce((sum, r) => sum + r.amount_residual, 0) -
             weekPayables.reduce((sum, p) => sum + p.amount_residual, 0),
      });

      currentDate.setDate(currentDate.getDate() + 7);
    }

    return {
      period: `${daysAhead} days`,
      total_inflows: receivables.reduce((sum, r) => sum + r.amount_residual, 0),
      total_outflows: payables.reduce((sum, p) => sum + p.amount_residual, 0),
      net_cash_flow: receivables.reduce((sum, r) => sum + r.amount_residual, 0) -
                     payables.reduce((sum, p) => sum + p.amount_residual, 0),
      weekly_breakdown: weeks,
    };
  }

  async _getVATSummary(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const year = params.year || new Date().getFullYear();
    let dateFrom, dateTo;

    if (params.period === 'month') {
      const month = params.month || new Date().getMonth() + 1;
      dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      dateTo = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    } else if (params.period === 'quarter') {
      const quarter = params.quarter || Math.ceil((new Date().getMonth() + 1) / 3);
      const startMonth = (quarter - 1) * 3 + 1;
      const endMonth = quarter * 3;
      dateFrom = `${year}-${String(startMonth).padStart(2, '0')}-01`;
      const lastDay = new Date(year, endMonth, 0).getDate();
      dateTo = `${year}-${String(endMonth).padStart(2, '0')}-${lastDay}`;
    } else {
      dateFrom = `${year}-01-01`;
      dateTo = `${year}-12-31`;
    }

    // Get sales invoices (output VAT)
    const sales = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['invoice_date', '>=', dateFrom],
      ['invoice_date', '<=', dateTo],
    ], ['amount_untaxed', 'amount_tax', 'amount_total'], { limit: 5000 });

    // Get purchase invoices (input VAT)
    const purchases = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'in_invoice'],
      ['state', '=', 'posted'],
      ['invoice_date', '>=', dateFrom],
      ['invoice_date', '<=', dateTo],
    ], ['amount_untaxed', 'amount_tax', 'amount_total'], { limit: 5000 });

    const outputVAT = sales.reduce((sum, inv) => sum + inv.amount_tax, 0);
    const inputVAT = purchases.reduce((sum, inv) => sum + inv.amount_tax, 0);

    return {
      period: params.period || 'year',
      date_from: dateFrom,
      date_to: dateTo,
      sales: {
        count: sales.length,
        base_amount: sales.reduce((sum, inv) => sum + inv.amount_untaxed, 0),
        vat_amount: outputVAT,
        total: sales.reduce((sum, inv) => sum + inv.amount_total, 0),
      },
      purchases: {
        count: purchases.length,
        base_amount: purchases.reduce((sum, inv) => sum + inv.amount_untaxed, 0),
        vat_amount: inputVAT,
        total: purchases.reduce((sum, inv) => sum + inv.amount_total, 0),
      },
      vat_payable: outputVAT - inputVAT,
    };
  }

  async _scanEmailForInvoices(params) {
    if (!this.msClient) {
      throw new Error('Microsoft client not available, email features disabled');
    }

    const InvoiceEmailPoller = require('../../../services/accounting/InvoiceEmailPoller');
    const result = await InvoiceEmailPoller.scanForInvoices({
      folder: params.folder || 'Inbox',
      hoursBack: params.hours_back || 24,
      processImmediately: params.process_immediately || false,
    });

    return result;
  }

  async _extractInvoiceFromEmail(params) {
    if (!this.msClient) {
      throw new Error('Microsoft client not available');
    }

    const InvoiceEmailPoller = require('../../../services/accounting/InvoiceEmailPoller');
    const result = await InvoiceEmailPoller.extractInvoiceFromEmail(
      params.email_id,
      params.user_id
    );

    return result;
  }

  // ============ Voice Session Handling ============

  async handleVoiceSession(roomName, userIdentity) {
    const { AccessToken } = require('livekit-server-sdk');

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: `accounting-agent-${this.id}` }
    );
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    const session = {
      roomName,
      userIdentity,
      agentToken: token,
      startedAt: new Date(),
    };

    this.voiceSessions.set(roomName, session);

    return {
      agentToken: token,
      roomName,
      serverUrl: process.env.LIVEKIT_SERVER_URL,
    };
  }

  async processVoiceInput(roomName, transcript) {
    const session = this.voiceSessions.get(roomName);
    if (!session) throw new Error('Voice session not found');

    // Process as a task
    const response = await this.execute({
      type: 'voice_query',
      description: transcript,
    });

    return {
      text: response.result,
    };
  }
}

module.exports = {
  AccountingAgent,
  InvoiceProcessingStatus,
  TransactionType,
};
