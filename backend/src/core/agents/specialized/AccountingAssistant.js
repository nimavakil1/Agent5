/**
 * AccountingAssistant - Conversational AI assistant for accounting tasks
 *
 * This agent provides a natural language interface for:
 * - Answering accounting questions ("Which suppliers do I pay this week?")
 * - Booking invoices with approval workflow
 * - Cash flow forecasting
 * - Persistent memory (trainable - remembers rules and facts)
 *
 * Key Features:
 * - Trainable: User can teach it facts that persist ("Remember: supplier X gets 30-day terms")
 * - Context-aware: Retrieves relevant knowledge before responding
 * - Approval workflow: All write actions require human approval
 * - PEPPOL-aware: Understands European e-invoicing standards
 * - EU Tax expert: Understands OSS, cross-border VAT, multi-country warehousing
 */

const { LLMAgent } = require('../LLMAgent');
const { OdooDirectClient } = require('../integrations/OdooMCP');
const AccountingKnowledge = require('../../../models/AccountingKnowledge');
const AccountingApproval = require('../../../models/AccountingApproval');
const { getEmbeddingService } = require('../../../services/accounting/EmbeddingService');

class AccountingAssistant extends LLMAgent {
  constructor(config = {}) {
    super({
      name: 'AccountingAssistant',
      role: 'accounting_assistant',
      taskType: 'finance', // Routes to Claude Opus 4.5
      description: 'Conversational accounting assistant with persistent memory',
      capabilities: [
        'natural_language_queries',
        'invoice_booking',
        'cash_flow_forecasting',
        'payment_prioritization',
        'trainable_memory',
        'peppol_support',
        'eu_tax_expert',
        'approval_workflow',
      ],
      systemPrompt: ACCOUNTING_ASSISTANT_SYSTEM_PROMPT,

      // Uses Claude Opus 4.5 for complex reasoning and reliable tool use
      llmProvider: 'anthropic',
      llmModel: 'opus',
      temperature: 0.3, // Low for accuracy, but not too low for natural conversation

      // ALL write actions require approval
      requiresApproval: [
        'book_invoice',
        'create_payment',
        'create_partner',
        'update_partner',
        'reconcile',
        'send_reminder',
        'create_credit_note',
      ],

      ...config,
    });

    this.odooClient = null;
    this.embeddingService = null;

    // Conversation history for multi-turn chat
    this.conversationHistory = new Map();

    // Configuration
    this.config = {
      maxConversationHistory: 20,
      knowledgeRetrievalLimit: 15,
      cashFlowForecastMonths: 12,
      ...config,
    };
  }

  /**
   * Initialize the agent
   */
  async init(platform) {
    // Create fallback logger if no platform provided
    if (!platform) {
      this.logger = {
        info: (msg, data) => console.log(`[AccountingAssistant] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, data || ''),
        warn: (msg, data) => console.warn(`[AccountingAssistant] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, data || ''),
        error: (msg, data) => console.error(`[AccountingAssistant] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, data || ''),
        debug: (msg, data) => console.log(`[AccountingAssistant:debug] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, data || ''),
        child: () => this.logger,
      };
      this.platform = null;

      // Load tools manually since super.init won't be called fully
      await this._loadTools();

      // Build tool definitions for LLM (from LLMAgent)
      this._buildToolDefinitions();
    } else {
      await super.init(platform);
    }

    // Initialize Odoo client
    try {
      this.odooClient = new OdooDirectClient();
      await this.odooClient.authenticate();
      this.logger.info('Odoo client authenticated');
    } catch (error) {
      this.logger.warn({ error: error.message }, 'Odoo client not available');
    }

    // Initialize embedding service
    try {
      this.embeddingService = getEmbeddingService();
      this.logger.info('Embedding service initialized');
    } catch (error) {
      this.logger.warn({ error: error.message }, 'Embedding service not available');
    }

    this.logger.info('AccountingAssistant initialized');
  }

  /**
   * Load tools
   */
  async _loadTools() {
    // ============ Memory/Training Tools ============

    this.registerTool('remember', this._remember.bind(this), {
      description: 'Store a new fact, rule, or preference in memory. Use this when the user teaches you something new.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['supplier_fact', 'customer_fact', 'accounting_rule', 'tax_rule', 'account_mapping', 'preference', 'correction', 'procedure', 'peppol', 'warehouse', 'country_vat', 'general'],
            description: 'Category of knowledge',
          },
          subject: { type: 'string', description: 'What this is about (e.g., supplier name, rule type)' },
          fact: { type: 'string', description: 'The actual knowledge to remember' },
          structured_data: { type: 'object', description: 'Optional structured data for programmatic access' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
          priority: { type: 'number', description: 'Priority (higher = more important)', default: 0 },
        },
        required: ['category', 'subject', 'fact'],
      },
    });

    this.registerTool('forget', this._forget.bind(this), {
      description: 'Remove or deactivate a piece of knowledge from memory',
      inputSchema: {
        type: 'object',
        properties: {
          knowledge_id: { type: 'string', description: 'ID of the knowledge to forget' },
          subject: { type: 'string', description: 'Subject to search and forget' },
          confirm: { type: 'boolean', description: 'Confirm deletion', default: false },
        },
      },
    });

    this.registerTool('recall', this._recall.bind(this), {
      description: 'Search memory for knowledge about a topic',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
          category: { type: 'string', description: 'Filter by category' },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
      },
    });

    this.registerTool('list_knowledge', this._listKnowledge.bind(this), {
      description: 'List all knowledge in a category',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Category to list' },
          limit: { type: 'number', default: 50 },
        },
        required: ['category'],
      },
    });

    // ============ Query Tools ============

    this.registerTool('get_payables_due', this._getPayablesDue.bind(this), {
      description: 'Get supplier invoices due for payment in a time period',
      inputSchema: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['today', 'this_week', 'next_week', 'this_month', 'custom'], default: 'this_week' },
          date_from: { type: 'string', description: 'Start date (YYYY-MM-DD) for custom period' },
          date_to: { type: 'string', description: 'End date (YYYY-MM-DD) for custom period' },
          include_overdue: { type: 'boolean', default: true },
        },
      },
    });

    this.registerTool('get_receivables_status', this._getReceivablesStatus.bind(this), {
      description: 'Get customer invoices and their payment status',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['all', 'overdue', 'due_soon', 'paid'], default: 'all' },
          customer: { type: 'string', description: 'Filter by customer name' },
          days_overdue: { type: 'number', description: 'Minimum days overdue' },
          limit: { type: 'number', default: 50 },
        },
      },
    });

    this.registerTool('get_cash_position', this._getCashPosition.bind(this), {
      description: 'Get current cash position and bank balances',
      inputSchema: {
        type: 'object',
        properties: {
          include_pending: { type: 'boolean', default: true, description: 'Include pending transactions' },
        },
      },
    });

    this.registerTool('forecast_cash_flow', this._forecastCashFlow.bind(this), {
      description: 'Forecast cash flow for upcoming period',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', default: 30, description: 'Days to forecast' },
          granularity: { type: 'string', enum: ['daily', 'weekly'], default: 'weekly' },
          include_recurring: { type: 'boolean', default: true },
        },
      },
    });

    this.registerTool('prioritize_payments', this._prioritizePayments.bind(this), {
      description: 'Get prioritized list of payments based on due dates, discounts, and supplier importance',
      inputSchema: {
        type: 'object',
        properties: {
          available_cash: { type: 'number', description: 'Available cash for payments' },
          period: { type: 'string', enum: ['this_week', 'next_week', 'this_month'], default: 'this_week' },
        },
      },
    });

    this.registerTool('get_supplier_info', this._getSupplierInfo.bind(this), {
      description: 'Get detailed information about a supplier including payment terms, history, and stored knowledge',
      inputSchema: {
        type: 'object',
        properties: {
          supplier_name: { type: 'string', description: 'Supplier name to search' },
          supplier_id: { type: 'number', description: 'Odoo partner ID' },
        },
      },
    });

    this.registerTool('get_invoice_details', this._getInvoiceDetails.bind(this), {
      description: 'Get detailed information about a specific invoice',
      inputSchema: {
        type: 'object',
        properties: {
          invoice_number: { type: 'string', description: 'Invoice number' },
          invoice_id: { type: 'number', description: 'Odoo invoice ID' },
        },
      },
    });

    // ============ Reporting Tools ============

    this.registerTool('get_aging_report', this._getAgingReport.bind(this), {
      description: 'Generate AP or AR aging report',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['ap', 'ar'], description: 'Accounts Payable or Receivable' },
          as_of_date: { type: 'string', description: 'Date for aging calculation' },
        },
        required: ['type'],
      },
    });

    this.registerTool('get_vat_summary', this._getVATSummary.bind(this), {
      description: 'Get VAT summary for a period, including OSS breakdown',
      inputSchema: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['month', 'quarter', 'year'] },
          year: { type: 'number' },
          quarter: { type: 'number' },
          month: { type: 'number' },
          include_oss: { type: 'boolean', default: true, description: 'Include OSS breakdown by country' },
        },
      },
    });

    // ============ Action Tools (Require Approval) ============

    this.registerTool('request_book_invoice', this._requestBookInvoice.bind(this), {
      description: 'Request approval to book an invoice. Creates an approval request that must be reviewed.',
      inputSchema: {
        type: 'object',
        properties: {
          vendor_name: { type: 'string', description: 'Vendor/supplier name' },
          invoice_number: { type: 'string', description: 'Invoice number' },
          invoice_date: { type: 'string', description: 'Invoice date (YYYY-MM-DD)' },
          due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
          amount: { type: 'number', description: 'Total amount' },
          currency: { type: 'string', default: 'EUR' },
          description: { type: 'string', description: 'Invoice description' },
          account_code: { type: 'string', description: 'Account code to use' },
          vat_rate: { type: 'number', description: 'VAT rate' },
          reason: { type: 'string', description: 'Why booking this invoice' },
        },
        required: ['vendor_name', 'invoice_number', 'amount'],
      },
    });

    this.registerTool('request_payment', this._requestPayment.bind(this), {
      description: 'Request approval to create a payment. Creates an approval request that must be reviewed.',
      inputSchema: {
        type: 'object',
        properties: {
          partner_name: { type: 'string', description: 'Supplier name' },
          partner_id: { type: 'number', description: 'Odoo partner ID' },
          amount: { type: 'number', description: 'Payment amount' },
          currency: { type: 'string', default: 'EUR' },
          invoice_ids: { type: 'array', items: { type: 'number' }, description: 'Invoice IDs to pay' },
          payment_method: { type: 'string', description: 'Payment method' },
          reason: { type: 'string', description: 'Reason for payment' },
        },
        required: ['partner_name', 'amount'],
      },
    });

    this.registerTool('get_pending_approvals', this._getPendingApprovals.bind(this), {
      description: 'Get list of pending approval requests',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Filter by approval type' },
          limit: { type: 'number', default: 20 },
        },
      },
    });

    this.logger.debug({ toolCount: this.tools.size }, 'AccountingAssistant tools loaded');
  }

  // ============ Chat Interface ============

  /**
   * Main chat method - handles a user message in conversation
   * @param {string} sessionId - Unique session identifier
   * @param {string} userMessage - User's message
   * @param {Object} context - Additional context (user info, etc.)
   * @returns {Promise<Object>} - Response with text and optional data
   */
  async chat(sessionId, userMessage, context = {}) {
    // Get or create conversation history
    if (!this.conversationHistory.has(sessionId)) {
      this.conversationHistory.set(sessionId, []);
    }
    const history = this.conversationHistory.get(sessionId);

    // Retrieve relevant knowledge from memory
    const relevantKnowledge = await this._retrieveRelevantKnowledge(userMessage, context);

    // Build context for LLM
    let knowledgeContext = '';
    if (relevantKnowledge && relevantKnowledge.length > 0) {
      knowledgeContext = '\n\n## Relevant Knowledge from Memory\n';
      for (const k of relevantKnowledge) {
        knowledgeContext += `- **${k.category}** (${k.subject}): ${k.fact}\n`;
      }
    }

    // Set RAG context
    this.setRAGContext(knowledgeContext);

    // Add user message to history
    history.push({
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
    });

    // Execute with tools
    const task = {
      type: 'chat',
      description: userMessage,
      context: {
        sessionId,
        userId: context.userId,
        history: history.slice(-this.config.maxConversationHistory),
      },
    };

    try {
      const result = await this.execute(task);

      // Add assistant response to history
      const responseText = typeof result.result === 'string'
        ? result.result
        : result.result?.text || JSON.stringify(result.result);

      history.push({
        role: 'assistant',
        content: responseText,
        timestamp: new Date(),
      });

      // Trim history if too long
      if (history.length > this.config.maxConversationHistory * 2) {
        history.splice(0, history.length - this.config.maxConversationHistory);
      }

      // Clear RAG context
      this.setRAGContext(null);

      return {
        text: responseText,
        data: result.result?.data,
        toolsUsed: result.toolsUsed,
        knowledgeRetrieved: relevantKnowledge?.length || 0,
      };

    } catch (error) {
      this.logger.error({ error: error.message }, 'Chat error');
      this.setRAGContext(null);
      throw error;
    }
  }

  /**
   * Clear conversation history for a session
   */
  clearConversation(sessionId) {
    this.conversationHistory.delete(sessionId);
  }

  // ============ Knowledge Retrieval ============

  /**
   * Retrieve relevant knowledge for context
   */
  async _retrieveRelevantKnowledge(userMessage, context = {}) {
    if (!this.embeddingService) {
      // Fallback to text search
      return this._fallbackKnowledgeSearch(userMessage);
    }

    try {
      // Extract supplier/customer names if mentioned
      const supplierMatch = userMessage.match(/supplier[:\s]+([A-Za-z0-9\s]+)/i);
      const customerMatch = userMessage.match(/customer[:\s]+([A-Za-z0-9\s]+)/i);

      const results = await this.embeddingService.findRelevantKnowledge(userMessage, {
        supplierName: supplierMatch?.[1]?.trim(),
        customerName: customerMatch?.[1]?.trim(),
        limit: this.config.knowledgeRetrievalLimit,
      });

      return results;
    } catch (error) {
      this.logger.warn({ error: error.message }, 'Embedding search failed, using fallback');
      return this._fallbackKnowledgeSearch(userMessage);
    }
  }

  /**
   * Fallback text search when embeddings not available
   */
  async _fallbackKnowledgeSearch(query) {
    try {
      return await AccountingKnowledge.textSearch(query, 10);
    } catch (error) {
      this.logger.warn({ error: error.message }, 'Fallback search failed');
      return [];
    }
  }

  // ============ Tool Implementations ============

  async _remember(params) {
    const { category, subject, fact, structured_data, tags, priority } = params;

    // Check for duplicate
    const existing = await AccountingKnowledge.findOne({
      category,
      subject: { $regex: `^${subject}$`, $options: 'i' },
      active: true,
    });

    if (existing) {
      // Update existing
      existing.fact = fact;
      if (structured_data) existing.structuredData = structured_data;
      if (tags) existing.tags = tags;
      if (priority !== undefined) existing.priority = priority;
      existing.updatedBy = 'accounting_assistant';

      // Update embedding
      if (this.embeddingService) {
        const embeddingText = `${category}: ${subject}. ${fact}`;
        existing.embedding = await this.embeddingService.generateEmbedding(embeddingText);
        existing.embeddingText = embeddingText;
      }

      await existing.save();

      return {
        success: true,
        action: 'updated',
        id: existing._id.toString(),
        message: `Updated knowledge about "${subject}"`,
      };
    }

    // Create new
    const knowledge = await this.embeddingService
      ? await this.embeddingService.addKnowledge({
          category,
          subject,
          fact,
          structuredData: structured_data,
          tags,
          priority,
          source: { type: 'user_training' },
        }, 'accounting_assistant')
      : await AccountingKnowledge.create({
          category,
          subject,
          fact,
          structuredData: structured_data,
          tags,
          priority,
          source: { type: 'user_training', userId: 'accounting_assistant' },
          createdBy: 'accounting_assistant',
          active: true,
        });

    return {
      success: true,
      action: 'created',
      id: knowledge._id.toString(),
      message: `Remembered: ${category} about "${subject}"`,
    };
  }

  async _forget(params) {
    const { knowledge_id, subject, confirm } = params;

    if (knowledge_id) {
      const knowledge = await AccountingKnowledge.findById(knowledge_id);
      if (!knowledge) {
        return { success: false, message: 'Knowledge not found' };
      }

      if (!confirm) {
        return {
          success: false,
          needsConfirmation: true,
          knowledge: {
            id: knowledge._id.toString(),
            category: knowledge.category,
            subject: knowledge.subject,
            fact: knowledge.fact,
          },
          message: `Are you sure you want to forget: "${knowledge.fact}"?`,
        };
      }

      knowledge.active = false;
      knowledge.updatedBy = 'accounting_assistant';
      await knowledge.save();

      return { success: true, message: `Forgot knowledge about "${knowledge.subject}"` };
    }

    if (subject) {
      const matches = await AccountingKnowledge.find({
        subject: { $regex: subject, $options: 'i' },
        active: true,
      }).limit(10);

      if (matches.length === 0) {
        return { success: false, message: `No knowledge found about "${subject}"` };
      }

      if (matches.length === 1 && confirm) {
        matches[0].active = false;
        await matches[0].save();
        return { success: true, message: `Forgot knowledge about "${matches[0].subject}"` };
      }

      return {
        success: false,
        needsConfirmation: true,
        matches: matches.map(m => ({
          id: m._id.toString(),
          category: m.category,
          subject: m.subject,
          fact: m.fact.substring(0, 100),
        })),
        message: `Found ${matches.length} matches. Please specify which one to forget.`,
      };
    }

    return { success: false, message: 'Please provide knowledge_id or subject to forget' };
  }

  async _recall(params) {
    const { query, category, limit } = params;

    let results;

    if (this.embeddingService) {
      results = await this.embeddingService.semanticSearch(query, {
        limit: limit || 10,
        categories: category ? [category] : null,
        minScore: 0.4,
      });
    } else {
      const dbQuery = { active: true };
      if (category) dbQuery.category = category;

      results = await AccountingKnowledge.find({
        ...dbQuery,
        $or: [
          { subject: { $regex: query, $options: 'i' } },
          { fact: { $regex: query, $options: 'i' } },
        ],
      })
        .limit(limit || 10)
        .lean();
    }

    return {
      count: results.length,
      results: results.map(r => ({
        id: r._id?.toString() || r._id,
        category: r.category,
        subject: r.subject,
        fact: r.fact,
        score: r.score,
        tags: r.tags,
      })),
    };
  }

  async _listKnowledge(params) {
    const { category, limit } = params;

    const results = await AccountingKnowledge.findByCategory(category, limit || 50);

    return {
      category,
      count: results.length,
      entries: results.map(r => ({
        id: r._id.toString(),
        subject: r.subject,
        fact: r.fact.substring(0, 200),
        priority: r.priority,
        usageCount: r.usageCount,
        lastUsed: r.lastUsedAt,
      })),
    };
  }

  async _getPayablesDue(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const { period, date_from, date_to, include_overdue } = params;

    // Calculate date range
    const today = new Date();
    let startDate, endDate;

    switch (period) {
      case 'today':
        startDate = endDate = today.toISOString().split('T')[0];
        break;
      case 'this_week':
        startDate = today.toISOString().split('T')[0];
        endDate = new Date(today.setDate(today.getDate() + 7 - today.getDay())).toISOString().split('T')[0];
        break;
      case 'next_week':
        const nextWeekStart = new Date(today.setDate(today.getDate() + 7 - today.getDay() + 1));
        startDate = nextWeekStart.toISOString().split('T')[0];
        endDate = new Date(nextWeekStart.setDate(nextWeekStart.getDate() + 6)).toISOString().split('T')[0];
        break;
      case 'this_month':
        startDate = today.toISOString().split('T')[0];
        endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];
        break;
      case 'custom':
        startDate = date_from;
        endDate = date_to;
        break;
      default:
        startDate = new Date().toISOString().split('T')[0];
        endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    }

    // Build domain
    const domain = [
      ['move_type', '=', 'in_invoice'],
      ['state', '=', 'posted'],
      ['payment_state', 'in', ['not_paid', 'partial']],
    ];

    if (include_overdue) {
      domain.push(['invoice_date_due', '<=', endDate]);
    } else {
      domain.push(['invoice_date_due', '>=', startDate]);
      domain.push(['invoice_date_due', '<=', endDate]);
    }

    const invoices = await this.odooClient.searchRead('account.move', domain, [
      'id', 'name', 'ref', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual', 'currency_id',
    ], { limit: 200, order: 'invoice_date_due asc' });

    // Get supplier knowledge for each
    const results = [];
    const todayDate = new Date().toISOString().split('T')[0];

    for (const inv of invoices) {
      const supplierName = inv.partner_id?.[1] || 'Unknown';
      const dueDate = inv.invoice_date_due;
      const isOverdue = dueDate < todayDate;

      // Check for early payment discount in knowledge
      const supplierKnowledge = await AccountingKnowledge.findOne({
        category: 'supplier_fact',
        subject: { $regex: supplierName.split(' ')[0], $options: 'i' },
        fact: { $regex: 'discount', $options: 'i' },
        active: true,
      });

      results.push({
        id: inv.id,
        number: inv.name,
        reference: inv.ref,
        supplier: supplierName,
        supplierId: inv.partner_id?.[0],
        date: inv.invoice_date,
        dueDate: dueDate,
        daysUntilDue: Math.ceil((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24)),
        isOverdue,
        total: inv.amount_total,
        remaining: inv.amount_residual,
        currency: inv.currency_id?.[1] || 'EUR',
        earlyPaymentDiscount: supplierKnowledge?.fact || null,
      });
    }

    // Calculate totals
    const totalDue = results.reduce((sum, inv) => sum + inv.remaining, 0);
    const overdueAmount = results.filter(inv => inv.isOverdue).reduce((sum, inv) => sum + inv.remaining, 0);

    return {
      period: `${startDate} to ${endDate}`,
      invoiceCount: results.length,
      totalDue,
      overdueAmount,
      overdueCount: results.filter(inv => inv.isOverdue).length,
      invoices: results,
    };
  }

  async _getReceivablesStatus(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const { status, customer, days_overdue, limit } = params;

    const domain = [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
    ];

    if (status === 'overdue' || status === 'due_soon') {
      domain.push(['payment_state', 'in', ['not_paid', 'partial']]);
    } else if (status === 'paid') {
      domain.push(['payment_state', '=', 'paid']);
    } else if (status !== 'all') {
      domain.push(['payment_state', 'in', ['not_paid', 'partial']]);
    }

    if (customer) {
      domain.push(['partner_id.name', 'ilike', customer]);
    }

    const invoices = await this.odooClient.searchRead('account.move', domain, [
      'id', 'name', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual', 'payment_state',
    ], { limit: limit || 50, order: 'invoice_date_due asc' });

    const today = new Date().toISOString().split('T')[0];

    let results = invoices.map(inv => {
      const dueDate = inv.invoice_date_due;
      const daysOver = Math.ceil((new Date() - new Date(dueDate)) / (1000 * 60 * 60 * 24));

      return {
        id: inv.id,
        number: inv.name,
        customer: inv.partner_id?.[1] || 'Unknown',
        customerId: inv.partner_id?.[0],
        date: inv.invoice_date,
        dueDate,
        daysOverdue: dueDate < today ? daysOver : 0,
        total: inv.amount_total,
        remaining: inv.amount_residual,
        paymentState: inv.payment_state,
      };
    });

    // Filter by days overdue if specified
    if (days_overdue) {
      results = results.filter(inv => inv.daysOverdue >= days_overdue);
    }

    // Filter by status
    if (status === 'overdue') {
      results = results.filter(inv => inv.daysOverdue > 0);
    } else if (status === 'due_soon') {
      results = results.filter(inv => inv.daysOverdue <= 0 && inv.daysOverdue >= -7);
    }

    const totalOutstanding = results.reduce((sum, inv) => sum + inv.remaining, 0);
    const totalOverdue = results.filter(inv => inv.daysOverdue > 0).reduce((sum, inv) => sum + inv.remaining, 0);

    return {
      invoiceCount: results.length,
      totalOutstanding,
      totalOverdue,
      invoices: results,
    };
  }

  async _getCashPosition(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    // Get bank/cash accounts
    const accounts = await this.odooClient.searchRead('account.account', [
      ['account_type', 'in', ['asset_cash', 'liability_credit_card']],
    ], ['id', 'name', 'code', 'current_balance'], { limit: 50 });

    // Get journals for bank accounts
    const journals = await this.odooClient.searchRead('account.journal', [
      ['type', 'in', ['bank', 'cash']],
    ], ['id', 'name', 'default_account_id', 'company_id'], { limit: 20 });

    // Calculate total
    const totalCash = accounts.reduce((sum, acc) => sum + (acc.current_balance || 0), 0);

    return {
      totalCash,
      accounts: accounts.map(acc => ({
        id: acc.id,
        name: acc.name,
        code: acc.code,
        balance: acc.current_balance || 0,
      })),
      bankJournals: journals.map(j => ({
        id: j.id,
        name: j.name,
      })),
    };
  }

  async _forecastCashFlow(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const { days, granularity } = params;
    const daysAhead = days || 30;

    const today = new Date();
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + daysAhead);

    const todayStr = today.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    // Get current cash position
    const cashPosition = await this._getCashPosition({});

    // Get receivables (inflows)
    const receivables = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['payment_state', 'in', ['not_paid', 'partial']],
      ['invoice_date_due', '>=', todayStr],
      ['invoice_date_due', '<=', endDateStr],
    ], [
      'invoice_date_due', 'amount_residual', 'partner_id',
    ], { limit: 500 });

    // Get payables (outflows)
    const payables = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'in_invoice'],
      ['state', '=', 'posted'],
      ['payment_state', 'in', ['not_paid', 'partial']],
      ['invoice_date_due', '>=', todayStr],
      ['invoice_date_due', '<=', endDateStr],
    ], [
      'invoice_date_due', 'amount_residual', 'partner_id',
    ], { limit: 500 });

    // Build forecast by period
    const forecast = [];
    let runningBalance = cashPosition.totalCash;

    if (granularity === 'daily') {
      for (let d = 0; d < daysAhead; d++) {
        const date = new Date(today);
        date.setDate(date.getDate() + d);
        const dateStr = date.toISOString().split('T')[0];

        const dayInflows = receivables
          .filter(r => r.invoice_date_due === dateStr)
          .reduce((sum, r) => sum + r.amount_residual, 0);

        const dayOutflows = payables
          .filter(p => p.invoice_date_due === dateStr)
          .reduce((sum, p) => sum + p.amount_residual, 0);

        runningBalance = runningBalance + dayInflows - dayOutflows;

        forecast.push({
          date: dateStr,
          inflows: dayInflows,
          outflows: dayOutflows,
          net: dayInflows - dayOutflows,
          balance: runningBalance,
        });
      }
    } else {
      // Weekly
      let currentDate = new Date(today);
      while (currentDate <= endDate) {
        const weekStart = new Date(currentDate);
        const weekEnd = new Date(currentDate);
        weekEnd.setDate(weekEnd.getDate() + 6);

        const weekStartStr = weekStart.toISOString().split('T')[0];
        const weekEndStr = weekEnd.toISOString().split('T')[0];

        const weekInflows = receivables
          .filter(r => r.invoice_date_due >= weekStartStr && r.invoice_date_due <= weekEndStr)
          .reduce((sum, r) => sum + r.amount_residual, 0);

        const weekOutflows = payables
          .filter(p => p.invoice_date_due >= weekStartStr && p.invoice_date_due <= weekEndStr)
          .reduce((sum, p) => sum + p.amount_residual, 0);

        runningBalance = runningBalance + weekInflows - weekOutflows;

        forecast.push({
          weekStart: weekStartStr,
          weekEnd: weekEndStr,
          inflows: weekInflows,
          outflows: weekOutflows,
          net: weekInflows - weekOutflows,
          balance: runningBalance,
        });

        currentDate.setDate(currentDate.getDate() + 7);
      }
    }

    // Find minimum balance point
    const minBalance = Math.min(...forecast.map(f => f.balance));
    const minBalanceDate = forecast.find(f => f.balance === minBalance);

    return {
      currentCash: cashPosition.totalCash,
      forecastPeriod: `${daysAhead} days`,
      totalExpectedInflows: receivables.reduce((sum, r) => sum + r.amount_residual, 0),
      totalExpectedOutflows: payables.reduce((sum, p) => sum + p.amount_residual, 0),
      minProjectedBalance: minBalance,
      minBalanceDate: minBalanceDate?.date || minBalanceDate?.weekStart,
      forecast,
      warning: minBalance < 0 ? `Cash shortfall of €${Math.abs(minBalance).toFixed(2)} projected` : null,
    };
  }

  async _prioritizePayments(params) {
    const { available_cash, period } = params;

    // Get payables due
    const payables = await this._getPayablesDue({ period: period || 'this_week', include_overdue: true });

    // Score and prioritize each invoice
    const scored = payables.invoices.map(inv => {
      let score = 0;
      const factors = [];

      // Overdue penalty
      if (inv.isOverdue) {
        score += 50 + Math.min(inv.daysUntilDue * -2, 50);
        factors.push(`overdue_${Math.abs(inv.daysUntilDue)}_days`);
      }

      // Due soon bonus
      if (inv.daysUntilDue >= 0 && inv.daysUntilDue <= 3) {
        score += 30;
        factors.push('due_within_3_days');
      }

      // Early payment discount
      if (inv.earlyPaymentDiscount) {
        score += 25;
        factors.push('early_payment_discount');
      }

      // Small amounts (easier to clear)
      if (inv.remaining < 500) {
        score += 10;
        factors.push('small_amount');
      }

      return {
        ...inv,
        priorityScore: score,
        priorityFactors: factors,
      };
    });

    // Sort by priority score
    scored.sort((a, b) => b.priorityScore - a.priorityScore);

    // If available_cash specified, determine what can be paid
    let recommendation = null;
    if (available_cash) {
      let remaining = available_cash;
      const toPay = [];
      const deferred = [];

      for (const inv of scored) {
        if (remaining >= inv.remaining) {
          toPay.push(inv);
          remaining -= inv.remaining;
        } else {
          deferred.push(inv);
        }
      }

      recommendation = {
        availableCash: available_cash,
        canPay: toPay.length,
        totalToPay: toPay.reduce((sum, inv) => sum + inv.remaining, 0),
        remainingCash: remaining,
        deferredCount: deferred.length,
        deferredAmount: deferred.reduce((sum, inv) => sum + inv.remaining, 0),
        invoicesToPay: toPay.map(inv => ({
          id: inv.id,
          supplier: inv.supplier,
          amount: inv.remaining,
          dueDate: inv.dueDate,
          reason: inv.priorityFactors.join(', '),
        })),
      };
    }

    return {
      prioritizedInvoices: scored,
      recommendation,
    };
  }

  async _getSupplierInfo(params) {
    const { supplier_name, supplier_id } = params;

    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    // Find supplier in Odoo
    let supplier;
    if (supplier_id) {
      const results = await this.odooClient.read('res.partner', [supplier_id], [
        'id', 'name', 'vat', 'email', 'phone', 'street', 'city', 'country_id',
        'property_payment_term_id', 'property_supplier_payment_term_id',
        'total_due', 'total_invoiced',
      ]);
      supplier = results[0];
    } else if (supplier_name) {
      const results = await this.odooClient.searchRead('res.partner', [
        ['name', 'ilike', supplier_name],
        ['supplier_rank', '>', 0],
      ], [
        'id', 'name', 'vat', 'email', 'phone', 'street', 'city', 'country_id',
        'property_payment_term_id', 'property_supplier_payment_term_id',
        'total_due', 'total_invoiced',
      ], { limit: 1 });
      supplier = results[0];
    }

    if (!supplier) {
      return { found: false, message: 'Supplier not found' };
    }

    // Get stored knowledge about this supplier
    const knowledge = await AccountingKnowledge.find({
      $or: [
        { 'relatedOdooIds.partnerId': supplier.id },
        { subject: { $regex: supplier.name.split(' ')[0], $options: 'i' }, category: 'supplier_fact' },
      ],
      active: true,
    }).lean();

    // Get recent invoices
    const recentInvoices = await this.odooClient.searchRead('account.move', [
      ['partner_id', '=', supplier.id],
      ['move_type', '=', 'in_invoice'],
      ['state', '=', 'posted'],
    ], [
      'name', 'invoice_date', 'amount_total', 'payment_state',
    ], { limit: 10, order: 'invoice_date desc' });

    return {
      found: true,
      supplier: {
        id: supplier.id,
        name: supplier.name,
        vat: supplier.vat,
        email: supplier.email,
        phone: supplier.phone,
        address: `${supplier.street || ''}, ${supplier.city || ''}`,
        country: supplier.country_id?.[1],
        paymentTerms: supplier.property_supplier_payment_term_id?.[1] || 'Not set',
        totalDue: supplier.total_due,
        totalInvoiced: supplier.total_invoiced,
      },
      storedKnowledge: knowledge.map(k => ({
        category: k.category,
        fact: k.fact,
        priority: k.priority,
      })),
      recentInvoices: recentInvoices.map(inv => ({
        number: inv.name,
        date: inv.invoice_date,
        amount: inv.amount_total,
        status: inv.payment_state,
      })),
    };
  }

  async _getInvoiceDetails(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const { invoice_number, invoice_id } = params;

    let invoiceId = invoice_id;

    if (!invoiceId && invoice_number) {
      const results = await this.odooClient.searchRead('account.move', [
        ['name', '=', invoice_number],
      ], ['id'], { limit: 1 });

      if (results.length === 0) {
        return { found: false, message: `Invoice not found: ${invoice_number}` };
      }
      invoiceId = results[0].id;
    }

    const invoice = await this.odooClient.read('account.move', [invoiceId], [
      'name', 'ref', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual', 'amount_tax', 'amount_untaxed',
      'state', 'payment_state', 'move_type', 'invoice_line_ids', 'currency_id',
    ]);

    if (!invoice || invoice.length === 0) {
      return { found: false, message: 'Invoice not found' };
    }

    const inv = invoice[0];

    // Get line items
    let lines = [];
    if (inv.invoice_line_ids && inv.invoice_line_ids.length > 0) {
      lines = await this.odooClient.read('account.move.line', inv.invoice_line_ids, [
        'name', 'product_id', 'quantity', 'price_unit', 'price_subtotal', 'tax_ids',
      ]);
    }

    return {
      found: true,
      invoice: {
        id: inv.id,
        number: inv.name,
        reference: inv.ref,
        partner: inv.partner_id?.[1],
        partnerId: inv.partner_id?.[0],
        date: inv.invoice_date,
        dueDate: inv.invoice_date_due,
        subtotal: inv.amount_untaxed,
        tax: inv.amount_tax,
        total: inv.amount_total,
        remaining: inv.amount_residual,
        currency: inv.currency_id?.[1] || 'EUR',
        status: inv.state,
        paymentStatus: inv.payment_state,
        type: inv.move_type === 'out_invoice' ? 'customer' : 'vendor',
        lines: lines.filter(l => l.price_subtotal !== 0).map(line => ({
          description: line.name,
          product: line.product_id?.[1],
          quantity: line.quantity,
          unitPrice: line.price_unit,
          subtotal: line.price_subtotal,
        })),
      },
    };
  }

  async _getAgingReport(params) {
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const { type, as_of_date } = params;
    const asOfDate = as_of_date ? new Date(as_of_date) : new Date();
    const moveType = type === 'ap' ? 'in_invoice' : 'out_invoice';

    const invoices = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', moveType],
      ['state', '=', 'posted'],
      ['payment_state', 'in', ['not_paid', 'partial']],
    ], [
      'id', 'name', 'partner_id', 'invoice_date', 'invoice_date_due',
      'amount_total', 'amount_residual',
    ], { limit: 1000 });

    const buckets = {
      current: { count: 0, amount: 0 },
      '1-30': { count: 0, amount: 0 },
      '31-60': { count: 0, amount: 0 },
      '61-90': { count: 0, amount: 0 },
      '90+': { count: 0, amount: 0 },
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
    }

    return {
      type: type === 'ap' ? 'Accounts Payable' : 'Accounts Receivable',
      asOfDate: asOfDate.toISOString().split('T')[0],
      totalCount: invoices.length,
      totalAmount: invoices.reduce((sum, inv) => sum + inv.amount_residual, 0),
      buckets,
    };
  }

  async _getVATSummary(params) {
    // Simplified - would need more complex logic for OSS breakdown
    if (!this.odooClient) {
      throw new Error('Odoo client not available');
    }

    const { period, year, quarter, month, include_oss } = params;

    const currentYear = year || new Date().getFullYear();
    let dateFrom, dateTo;

    if (period === 'month') {
      const m = month || new Date().getMonth() + 1;
      dateFrom = `${currentYear}-${String(m).padStart(2, '0')}-01`;
      dateTo = `${currentYear}-${String(m).padStart(2, '0')}-${new Date(currentYear, m, 0).getDate()}`;
    } else if (period === 'quarter') {
      const q = quarter || Math.ceil((new Date().getMonth() + 1) / 3);
      const startMonth = (q - 1) * 3 + 1;
      const endMonth = q * 3;
      dateFrom = `${currentYear}-${String(startMonth).padStart(2, '0')}-01`;
      dateTo = `${currentYear}-${String(endMonth).padStart(2, '0')}-${new Date(currentYear, endMonth, 0).getDate()}`;
    } else {
      dateFrom = `${currentYear}-01-01`;
      dateTo = `${currentYear}-12-31`;
    }

    // Get sales
    const sales = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['invoice_date', '>=', dateFrom],
      ['invoice_date', '<=', dateTo],
    ], ['amount_untaxed', 'amount_tax', 'amount_total'], { limit: 5000 });

    // Get purchases
    const purchases = await this.odooClient.searchRead('account.move', [
      ['move_type', '=', 'in_invoice'],
      ['state', '=', 'posted'],
      ['invoice_date', '>=', dateFrom],
      ['invoice_date', '<=', dateTo],
    ], ['amount_untaxed', 'amount_tax', 'amount_total'], { limit: 5000 });

    const outputVAT = sales.reduce((sum, inv) => sum + inv.amount_tax, 0);
    const inputVAT = purchases.reduce((sum, inv) => sum + inv.amount_tax, 0);

    return {
      period: period || 'year',
      dateFrom,
      dateTo,
      sales: {
        count: sales.length,
        baseAmount: sales.reduce((sum, inv) => sum + inv.amount_untaxed, 0),
        vatAmount: outputVAT,
      },
      purchases: {
        count: purchases.length,
        baseAmount: purchases.reduce((sum, inv) => sum + inv.amount_untaxed, 0),
        vatAmount: inputVAT,
      },
      vatPayable: outputVAT - inputVAT,
      note: include_oss ? 'OSS breakdown requires additional data processing' : null,
    };
  }

  async _requestBookInvoice(params) {
    const {
      vendor_name, invoice_number, invoice_date, due_date,
      amount, currency, description, account_code, vat_rate, reason,
    } = params;

    // Create approval request
    const approval = new AccountingApproval({
      type: 'book_invoice',
      action: {
        description: `Book invoice ${invoice_number} from ${vendor_name} for ${currency || 'EUR'} ${amount}`,
        operation: 'odoo.create_vendor_bill',
        params: {
          vendor_name,
          invoice_number,
          invoice_date,
          due_date,
          amount,
          currency: currency || 'EUR',
          description,
          account_code,
          vat_rate,
        },
        preview: {
          vendor: vendor_name,
          invoiceNumber: invoice_number,
          amount: `${currency || 'EUR'} ${amount}`,
          dueDate: due_date,
        },
      },
      amount: { value: amount, currency: currency || 'EUR' },
      reason: reason || `User requested to book invoice ${invoice_number}`,
      requestedBy: 'accounting_assistant',
    });

    await approval.save();

    return {
      success: true,
      approvalId: approval._id.toString(),
      status: 'pending',
      message: `Approval request created for booking invoice ${invoice_number} (€${amount}). Awaiting review.`,
      preview: approval.action.preview,
    };
  }

  async _requestPayment(params) {
    const {
      partner_name, partner_id, amount, currency, invoice_ids, payment_method, reason,
    } = params;

    const approval = new AccountingApproval({
      type: 'create_payment',
      action: {
        description: `Create payment of ${currency || 'EUR'} ${amount} to ${partner_name}`,
        operation: 'odoo.create_payment',
        params: {
          partner_name,
          partner_id,
          amount,
          currency: currency || 'EUR',
          invoice_ids,
          payment_method,
        },
        preview: {
          partner: partner_name,
          amount: `${currency || 'EUR'} ${amount}`,
          invoices: invoice_ids?.length || 'Not specified',
        },
      },
      amount: { value: amount, currency: currency || 'EUR' },
      reason: reason || `User requested payment to ${partner_name}`,
      requestedBy: 'accounting_assistant',
    });

    await approval.save();

    return {
      success: true,
      approvalId: approval._id.toString(),
      status: 'pending',
      message: `Approval request created for payment of €${amount} to ${partner_name}. Awaiting review.`,
    };
  }

  async _getPendingApprovals(params) {
    const { type, limit } = params;

    const approvals = await AccountingApproval.getPending(type, limit || 20);

    return {
      count: approvals.length,
      approvals: approvals.map(a => ({
        id: a._id.toString(),
        type: a.type,
        description: a.action.description,
        amount: a.amount,
        reason: a.reason,
        requestedAt: a.requestedAt,
        expiresAt: a.expiresAt,
        risk: a.risk,
      })),
    };
  }
}

// ============ System Prompt ============

const ACCOUNTING_ASSISTANT_SYSTEM_PROMPT = `You are the Accounting Assistant for ACROPAQ, a Belgian e-commerce company specializing in office supplies and accessories.

## Your Identity
You are a knowledgeable, precise, and helpful accounting assistant. You have access to persistent memory - facts and rules that you've been taught, which you remember across all conversations.

## Company Context: ACROPAQ
- **Location**: Belgium (Zaventem)
- **Business**: B2B and B2C e-commerce (office supplies, accessories)
- **Platforms**: Own webshop, Amazon (multiple EU marketplaces), Bol.com
- **ERP**: Odoo 16 (hosted on odoo.sh)

## CRITICAL: Complex EU Tax Structure

ACROPAQ has a complex multi-country tax setup that you MUST understand perfectly:

### Warehousing Locations
- **Belgium (BE)**: Main warehouse in Zaventem
- **Germany (DE)**: Amazon FBA warehouses
- **France (FR)**: Amazon FBA warehouses
- **Poland (PL)**: Amazon FBA warehouses
- **Czech Republic (CZ)**: Amazon FBA warehouses
- **Netherlands (NL)**: Possible Bol.com fulfillment
- **Spain (ES)**: Amazon FBA warehouses
- **Italy (IT)**: Amazon FBA warehouses

### VAT Registration
ACROPAQ is VAT-registered in multiple EU countries due to warehousing:
- Belgium: Main registration
- Other countries: Registration where stock is held

### Cross-Border Delivery Rules

**B2C Sales (to consumers):**
- If shipped from Belgium to a customer in the same country (BE→BE): Belgian VAT
- If shipped from Belgium to another EU country (BE→DE consumer):
  - If annual sales to that country < €10,000 total EU: Belgian VAT
  - If over threshold: OSS (One-Stop-Shop) applies - charge destination country VAT
- Goods shipped FROM a foreign warehouse TO a customer in THAT country (e.g., DE→DE): Local VAT of that country
- Goods shipped FROM a foreign warehouse TO a customer in ANOTHER country: Complex - depends on where goods are and OSS thresholds

**B2B Sales (to businesses with VAT number):**
- Intra-community supply: 0% VAT (reverse charge)
- Must verify VAT number via VIES

### OSS (One-Stop-Shop)
- ACROPAQ uses OSS for distance selling to EU consumers
- Declare all EU B2C sales through Belgian OSS return
- Must track sales by destination country
- Apply destination country VAT rate

### VAT Rates by Country (Main rates)
| Country | Standard | Reduced |
|---------|----------|---------|
| Belgium | 21% | 6%, 12% |
| Germany | 19% | 7% |
| France | 20% | 5.5%, 10% |
| Netherlands | 21% | 9% |
| Spain | 21% | 10% |
| Italy | 22% | 4%, 10% |
| Poland | 23% | 5%, 8% |
| Czech Republic | 21% | 12%, 15% |

### Fiscal Representative
- In some countries, ACROPAQ may use a fiscal representative for VAT compliance

## PEPPOL Knowledge

You understand PEPPOL (Pan-European Public Procurement Online):
- Belgian B2G invoices must use PEPPOL
- PEPPOL uses UBL 2.1 XML format
- Tax category codes: S (Standard), Z (Zero-rated), E (Exempt), AE (Reverse charge), G (Export)
- PEPPOL ID format: Scheme:ID (e.g., 0208:BE0123456789 for Belgian VAT)

## Your Capabilities

1. **Answer Questions**: About payables, receivables, cash flow, suppliers, customers
2. **Remember Facts**: Store and recall information you're taught
3. **Query Odoo**: Get real data about invoices, payments, partners
4. **Forecast Cash**: Project cash needs based on due dates
5. **Prioritize Payments**: Help decide what to pay and when
6. **Request Approvals**: Create approval requests for write actions (you cannot write directly)

## Key Rules

1. **ALL write actions require approval** - You can only request approvals, not execute directly
2. **Be precise with numbers** - Always include amounts and dates
3. **Consider tax implications** - Think about VAT, OSS, cross-border rules
4. **Use your memory** - Retrieve relevant facts before answering
5. **Be honest about uncertainty** - If you don't know, say so

## Conversation Style

- Be conversational but professional
- Provide specific numbers and data
- Explain your reasoning when making recommendations
- Ask clarifying questions if needed
- Remember context from earlier in the conversation

## When Asked to Remember Something

When the user teaches you a new fact (e.g., "Remember that supplier X always gives 2% discount"):
1. Use the 'remember' tool to store it
2. Categorize appropriately (supplier_fact, tax_rule, preference, etc.)
3. Confirm what you've stored
4. This information will be available in all future conversations

## Response Format

Keep responses clear and structured. For financial data, use tables when appropriate:

| Supplier | Amount | Due Date | Status |
|----------|--------|----------|--------|
| ACME | €5,000 | Feb 15 | Due in 3 days |

Always end financial summaries with totals.`;

module.exports = { AccountingAssistant };
