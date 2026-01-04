/**
 * Executive Agent (AI Chief of Staff)
 *
 * Top-level management agent that:
 * - Aggregates insights from all other agents
 * - Provides strategic recommendations
 * - Monitors company-wide KPIs
 * - Coordinates between departments
 * - Escalates critical issues
 * - Generates executive reports
 * - Supports decision-making
 *
 * This is the "brain" of the AI-first company system.
 *
 * @module ExecutiveAgent
 */

const { LLMAgent } = require('../LLMAgent');

/**
 * Alert severity levels
 */
const AlertSeverity = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info'
};

/**
 * Decision types
 */
const DecisionType = {
  FINANCIAL: 'financial',
  OPERATIONAL: 'operational',
  STRATEGIC: 'strategic',
  HR: 'hr',
  CUSTOMER: 'customer',
  SUPPLIER: 'supplier'
};

class ExecutiveAgent extends LLMAgent {
  constructor(id, config = {}) {
    super(id, {
      name: config.name || 'Executive Agent (AI Chief of Staff)',
      role: 'executive',
      capabilities: [
        'cross_department_coordination',
        'kpi_monitoring',
        'strategic_recommendations',
        'executive_reporting',
        'decision_support',
        'escalation_management',
        'company_pulse_monitoring'
      ],
      ...config
    });

    // Connected agents
    this.agents = {
      communication: config.communicationAgent || null,
      sharepoint: config.sharepointAgent || null,
      project: config.projectAgent || null,
      purchasing: config.purchasingAgent || null,
      ecommerce: config.ecommerceAgent || null,
      advertising: config.advertisingAgent || null,
      finance: config.financeAgent || null
    };

    // Odoo client for direct data access
    this.odooClient = config.odooClient || null;

    // Alert queue
    this.alerts = [];
    this.pendingDecisions = [];

    // KPI tracking
    this.kpiTargets = config.kpiTargets || {
      revenue: { target: 100000, period: 'month' },
      orderFulfillment: { target: 95, metric: 'percent' },
      customerSatisfaction: { target: 4.5, metric: 'rating' },
      inventoryTurnover: { target: 6, period: 'year' },
      cashFlow: { target: 50000, period: 'month' }
    };

    // Define tools
    this._initializeTools();
  }

  _initializeTools() {
    this.tools = [
      // ==================== COMPANY OVERVIEW ====================
      {
        name: 'get_company_pulse',
        description: 'Get real-time overview of company health across all departments',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getCompanyPulse.bind(this)
      },
      {
        name: 'get_daily_briefing',
        description: 'Generate executive daily briefing',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getDailyBriefing.bind(this)
      },
      {
        name: 'get_weekly_executive_summary',
        description: 'Generate weekly executive summary report',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getWeeklyExecutiveSummary.bind(this)
      },

      // ==================== KPI MONITORING ====================
      {
        name: 'get_kpi_dashboard',
        description: 'Get all KPIs with current status vs targets',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getKPIDashboard.bind(this)
      },
      {
        name: 'get_kpi_trends',
        description: 'Analyze KPI trends over time',
        parameters: {
          type: 'object',
          properties: {
            kpi: { type: 'string', description: 'Specific KPI to analyze' },
            period_months: { type: 'number', default: 6 }
          }
        },
        handler: this._getKPITrends.bind(this)
      },
      {
        name: 'set_kpi_target',
        description: 'Update a KPI target',
        parameters: {
          type: 'object',
          properties: {
            kpi: { type: 'string' },
            target: { type: 'number' }
          },
          required: ['kpi', 'target']
        },
        handler: this._setKPITarget.bind(this)
      },

      // ==================== ALERTS & ISSUES ====================
      {
        name: 'get_critical_alerts',
        description: 'Get all critical issues needing attention',
        parameters: {
          type: 'object',
          properties: {
            severity: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'all'],
              default: 'high'
            }
          }
        },
        handler: this._getCriticalAlerts.bind(this)
      },
      {
        name: 'get_escalations',
        description: 'Get issues escalated from other agents',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getEscalations.bind(this)
      },
      {
        name: 'acknowledge_alert',
        description: 'Acknowledge and optionally resolve an alert',
        parameters: {
          type: 'object',
          properties: {
            alert_id: { type: 'string' },
            action: { type: 'string', enum: ['acknowledge', 'resolve', 'escalate'] },
            notes: { type: 'string' }
          },
          required: ['alert_id', 'action']
        },
        handler: this._acknowledgeAlert.bind(this)
      },

      // ==================== FINANCIAL OVERVIEW ====================
      {
        name: 'get_financial_snapshot',
        description: 'Get current financial health snapshot',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getFinancialSnapshot.bind(this)
      },
      {
        name: 'get_cash_flow_status',
        description: 'Get cash flow analysis and projections',
        parameters: {
          type: 'object',
          properties: {
            forecast_days: { type: 'number', default: 30 }
          }
        },
        handler: this._getCashFlowStatus.bind(this)
      },
      {
        name: 'get_revenue_analysis',
        description: 'Analyze revenue across channels and time periods',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['week', 'month', 'quarter'], default: 'month' }
          }
        },
        handler: this._getRevenueAnalysis.bind(this)
      },

      // ==================== OPERATIONS OVERVIEW ====================
      {
        name: 'get_operations_status',
        description: 'Get operational status across all areas',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getOperationsStatus.bind(this)
      },
      {
        name: 'get_bottlenecks',
        description: 'Identify operational bottlenecks',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getBottlenecks.bind(this)
      },

      // ==================== TEAM & PERFORMANCE ====================
      {
        name: 'get_team_overview',
        description: 'Get overview of team performance and workload',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getTeamOverview.bind(this)
      },
      {
        name: 'get_productivity_metrics',
        description: 'Analyze team productivity metrics',
        parameters: {
          type: 'object',
          properties: {
            period_days: { type: 'number', default: 30 }
          }
        },
        handler: this._getProductivityMetrics.bind(this)
      },

      // ==================== DECISION SUPPORT ====================
      {
        name: 'get_pending_decisions',
        description: 'Get decisions awaiting executive input',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getPendingDecisions.bind(this)
      },
      {
        name: 'analyze_decision',
        description: 'Get AI analysis and recommendation for a decision',
        parameters: {
          type: 'object',
          properties: {
            decision_id: { type: 'string' },
            question: { type: 'string', description: 'The decision question' },
            context: { type: 'string', description: 'Additional context' }
          },
          required: ['question']
        },
        handler: this._analyzeDecision.bind(this)
      },
      {
        name: 'record_decision',
        description: 'Record an executive decision',
        parameters: {
          type: 'object',
          properties: {
            decision_id: { type: 'string' },
            decision: { type: 'string' },
            rationale: { type: 'string' },
            follow_up_actions: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['decision']
        },
        handler: this._recordDecision.bind(this)
      },

      // ==================== STRATEGIC RECOMMENDATIONS ====================
      {
        name: 'get_strategic_recommendations',
        description: 'Get AI-generated strategic recommendations',
        parameters: {
          type: 'object',
          properties: {
            focus_area: {
              type: 'string',
              enum: ['growth', 'efficiency', 'cost_reduction', 'customer', 'all'],
              default: 'all'
            }
          }
        },
        handler: this._getStrategicRecommendations.bind(this)
      },
      {
        name: 'analyze_opportunity',
        description: 'Analyze a strategic opportunity',
        parameters: {
          type: 'object',
          properties: {
            opportunity: { type: 'string', description: 'Description of the opportunity' },
            investment_required: { type: 'number' },
            timeframe: { type: 'string' }
          },
          required: ['opportunity']
        },
        handler: this._analyzeOpportunity.bind(this)
      },

      // ==================== COMMUNICATION ====================
      {
        name: 'get_communication_summary',
        description: 'Get summary of key communications (customer, supplier, internal)',
        parameters: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['customer', 'supplier', 'internal', 'all'],
              default: 'all'
            }
          }
        },
        handler: this._getCommunicationSummary.bind(this)
      },
      {
        name: 'draft_executive_message',
        description: 'Draft a message on behalf of executive',
        parameters: {
          type: 'object',
          properties: {
            recipient_type: { type: 'string', enum: ['team', 'customer', 'supplier', 'partner'] },
            subject: { type: 'string' },
            key_points: { type: 'array', items: { type: 'string' } },
            tone: { type: 'string', enum: ['formal', 'friendly', 'urgent'], default: 'formal' }
          },
          required: ['recipient_type', 'subject', 'key_points']
        },
        handler: this._draftExecutiveMessage.bind(this)
      }
    ];
  }

  // ==================== COMPANY OVERVIEW ====================

  async _getCompanyPulse(_params = {}) {
    const pulse = {
      timestamp: new Date().toISOString(),
      overallHealth: 'good',
      healthScore: 85,
      departments: {},
      criticalAlerts: [],
      keyMetrics: {}
    };

    // Financial health
    try {
      const financial = await this._getFinancialSnapshot();
      pulse.departments.finance = {
        status: financial.cashPosition > 0 ? 'healthy' : 'at_risk',
        highlights: [
          `Cash position: €${financial.cashPosition?.toFixed(2) || 0}`,
          `Outstanding receivables: €${financial.receivables?.toFixed(2) || 0}`
        ]
      };
      pulse.keyMetrics.cashPosition = financial.cashPosition;
    } catch (e) {
      pulse.departments.finance = { status: 'unknown', error: e.message };
    }

    // Operations (from project agent)
    try {
      if (this.agents.project) {
        const overdue = await this.agents.project._getOverdueTasks({});
        const blockers = await this.agents.project._detectBlockers({});

        pulse.departments.operations = {
          status: overdue.count > 10 ? 'at_risk' : overdue.count > 5 ? 'warning' : 'healthy',
          highlights: [
            `${overdue.count} overdue tasks`,
            `${blockers.count} blocked tasks`
          ]
        };

        if (overdue.count > 10) {
          pulse.criticalAlerts.push({
            type: 'operations',
            message: `${overdue.count} overdue tasks require attention`,
            severity: 'high'
          });
        }
      }
    } catch (e) {
      pulse.departments.operations = { status: 'unknown', error: e.message };
    }

    // E-commerce
    try {
      if (this.agents.ecommerce) {
        // Would get from ecommerce agent
        pulse.departments.ecommerce = {
          status: 'healthy',
          highlights: ['E-commerce operations normal']
        };
      }
    } catch (e) {
      pulse.departments.ecommerce = { status: 'unknown', error: e.message };
    }

    // Purchasing
    try {
      if (this.agents.purchasing) {
        const pending = await this.agents.purchasing._getPendingOrders({});
        pulse.departments.purchasing = {
          status: pending.counts.pendingApproval > 5 ? 'needs_attention' : 'healthy',
          highlights: [
            `${pending.counts.pendingApproval} POs awaiting approval`,
            `${pending.counts.pendingReceipt} POs awaiting receipt`
          ]
        };
      }
    } catch (e) {
      pulse.departments.purchasing = { status: 'unknown', error: e.message };
    }

    // Calculate overall health score
    const statuses = Object.values(pulse.departments).map(d => d.status);
    const healthyCount = statuses.filter(s => s === 'healthy').length;
    pulse.healthScore = Math.round((healthyCount / Math.max(statuses.length, 1)) * 100);
    pulse.overallHealth = pulse.healthScore >= 80 ? 'good' :
                          pulse.healthScore >= 60 ? 'fair' : 'needs_attention';

    return pulse;
  }

  async _getDailyBriefing(_params = {}) {
    const [pulse, alerts, decisions] = await Promise.all([
      this._getCompanyPulse(),
      this._getCriticalAlerts({ severity: 'high' }),
      this._getPendingDecisions()
    ]);

    const briefing = {
      date: new Date().toISOString().split('T')[0],
      greeting: this._getTimeBasedGreeting(),
      overallStatus: pulse.overallHealth,
      healthScore: pulse.healthScore,

      immediateAttention: [],
      keyMetrics: pulse.keyMetrics,
      departmentSummary: pulse.departments,

      todaysFocus: [],
      pendingDecisions: decisions.decisions?.slice(0, 5) || [],
      schedule: []  // Would integrate with calendar
    };

    // Add critical items needing immediate attention
    if (alerts.alerts?.length > 0) {
      briefing.immediateAttention = alerts.alerts.map(a => ({
        type: a.type,
        message: a.message,
        severity: a.severity
      }));
    }

    // Generate focus areas using LLM
    const focusPrompt = `Based on this company status, suggest 3 key focus areas for today:

Health Score: ${pulse.healthScore}/100
Critical Alerts: ${alerts.alerts?.length || 0}
Pending Decisions: ${decisions.decisions?.length || 0}

Departments:
${Object.entries(pulse.departments).map(([name, data]) => `- ${name}: ${data.status}`).join('\n')}

Provide 3 brief, actionable focus areas for today.`;

    try {
      const focusAreas = await this._generateWithLLM(focusPrompt);
      briefing.todaysFocus = focusAreas.split('\n').filter(f => f.trim()).slice(0, 3);
    } catch (_e) {
      briefing.todaysFocus = ['Review critical alerts', 'Check pending decisions', 'Monitor KPIs'];
    }

    return briefing;
  }

  async _getWeeklyExecutiveSummary(_params = {}) {
    const summary = {
      weekEnding: new Date().toISOString().split('T')[0],
      executiveSummary: '',
      financials: {},
      operations: {},
      achievements: [],
      concerns: [],
      nextWeekPriorities: [],
      recommendations: []
    };

    // Gather data from all departments
    try {
      summary.financials = await this._getFinancialSnapshot();
    } catch (e) {
      summary.financials = { error: e.message };
    }

    try {
      if (this.agents.project) {
        const performance = await this.agents.project._getPerformanceMetrics({ period_days: 7 });
        summary.operations.tasksCompleted = performance.totalCompleted;
        summary.operations.teamMetrics = performance.metrics;
      }
    } catch (e) {
      summary.operations.error = e.message;
    }

    // Generate executive summary using LLM
    const summaryPrompt = `Generate a brief executive summary (2-3 paragraphs) for this week:

Financial Status:
${JSON.stringify(summary.financials, null, 2)}

Operations:
${JSON.stringify(summary.operations, null, 2)}

Include: key achievements, concerns, and recommendations.`;

    try {
      summary.executiveSummary = await this._generateWithLLM(summaryPrompt);
    } catch (_e) {
      summary.executiveSummary = 'Unable to generate summary.';
    }

    return summary;
  }

  _getTimeBasedGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  // ==================== KPI MONITORING ====================

  async _getKPIDashboard(_params = {}) {
    const dashboard = {
      timestamp: new Date().toISOString(),
      kpis: {}
    };

    // Revenue KPI
    try {
      const revenue = await this._getRevenueAnalysis({ period: 'month' });
      dashboard.kpis.revenue = {
        current: revenue.totalRevenue,
        target: this.kpiTargets.revenue?.target || 100000,
        achievement: ((revenue.totalRevenue / (this.kpiTargets.revenue?.target || 100000)) * 100).toFixed(1) + '%',
        status: revenue.totalRevenue >= (this.kpiTargets.revenue?.target || 100000) ? 'on_track' : 'behind'
      };
    } catch (_e) {
      dashboard.kpis.revenue = { status: 'unknown' };
    }

    // Cash Flow KPI
    try {
      const cashFlow = await this._getCashFlowStatus({});
      dashboard.kpis.cashFlow = {
        current: cashFlow.netPosition,
        target: this.kpiTargets.cashFlow?.target || 50000,
        status: cashFlow.netPosition >= 0 ? 'healthy' : 'critical'
      };
    } catch (_e) {
      dashboard.kpis.cashFlow = { status: 'unknown' };
    }

    // Operations KPIs
    try {
      if (this.agents.project) {
        const performance = await this.agents.project._getPerformanceMetrics({ period_days: 30 });
        const avgOnTimeRate = performance.metrics.reduce((sum, m) => sum + parseFloat(m.onTimeRate || 0), 0) /
                             Math.max(performance.metrics.length, 1);

        dashboard.kpis.taskCompletion = {
          completed: performance.totalCompleted,
          onTimeRate: avgOnTimeRate.toFixed(1) + '%',
          status: avgOnTimeRate >= 80 ? 'on_track' : 'needs_improvement'
        };
      }
    } catch (_e) {
      dashboard.kpis.taskCompletion = { status: 'unknown' };
    }

    return dashboard;
  }

  async _getKPITrends(params = {}) {
    const { kpi, period_months = 6 } = params;

    // Would query historical data
    return {
      kpi,
      period: `${period_months} months`,
      message: 'KPI trend analysis requires historical data storage',
      recommendation: 'Implement time-series data collection for trend analysis'
    };
  }

  async _setKPITarget(params) {
    const { kpi, target } = params;

    this.kpiTargets[kpi] = {
      ...this.kpiTargets[kpi],
      target,
      updatedAt: new Date().toISOString()
    };

    return {
      success: true,
      kpi,
      newTarget: target,
      message: `KPI target for ${kpi} updated to ${target}`
    };
  }

  // ==================== ALERTS & ISSUES ====================

  async _getCriticalAlerts(params = {}) {
    const { severity = 'high' } = params;

    const alerts = [];

    // Check for overdue tasks
    try {
      if (this.agents.project) {
        const overdue = await this.agents.project._getOverdueTasks({});
        if (overdue.count > 0) {
          alerts.push({
            id: `alert_overdue_${Date.now()}`,
            type: 'operations',
            severity: overdue.criticalCount > 5 ? 'critical' : 'high',
            message: `${overdue.count} overdue tasks (${overdue.criticalCount} critical)`,
            source: 'ProjectAgent',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (_e) { /* ignore */ }

    // Check for outstanding payments
    try {
      if (this.agents.purchasing) {
        const payments = await this.agents.purchasing._getOutstandingPayments({ overdue_only: true });
        if (payments.count > 0) {
          alerts.push({
            id: `alert_payments_${Date.now()}`,
            type: 'finance',
            severity: payments.totalOutstanding > 10000 ? 'critical' : 'high',
            message: `${payments.count} overdue supplier payments (€${payments.totalOutstanding?.toFixed(2)})`,
            source: 'PurchasingAgent',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (_e) { /* ignore */ }

    // Check for low stock
    try {
      if (this.agents.purchasing) {
        const lowStock = await this.agents.purchasing._getLowStockItems({});
        if (lowStock.criticalCount > 0) {
          alerts.push({
            id: `alert_stock_${Date.now()}`,
            type: 'inventory',
            severity: lowStock.criticalCount > 10 ? 'critical' : 'high',
            message: `${lowStock.criticalCount} products critically low on stock`,
            source: 'PurchasingAgent',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (_e) { /* ignore */ }

    // Filter by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const filtered = severity === 'all' ? alerts :
      alerts.filter(a => severityOrder[a.severity] <= severityOrder[severity]);

    return {
      alerts: filtered.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]),
      count: filtered.length,
      criticalCount: filtered.filter(a => a.severity === 'critical').length
    };
  }

  async _getEscalations(_params = {}) {
    // Get escalated items from all agents
    return {
      escalations: this.alerts.filter(a => a.escalated),
      count: this.alerts.filter(a => a.escalated).length
    };
  }

  async _acknowledgeAlert(params) {
    const { alert_id, action, notes } = params;

    const alert = this.alerts.find(a => a.id === alert_id);
    if (!alert) {
      return { error: 'Alert not found' };
    }

    alert.acknowledged = true;
    alert.acknowledgedAt = new Date().toISOString();
    alert.action = action;
    alert.notes = notes;

    if (action === 'resolve') {
      alert.resolved = true;
      alert.resolvedAt = new Date().toISOString();
    }

    return {
      success: true,
      alert_id,
      action,
      message: `Alert ${action}d successfully`
    };
  }

  // ==================== FINANCIAL OVERVIEW ====================

  async _getFinancialSnapshot(_params = {}) {
    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const snapshot = {
      timestamp: new Date().toISOString(),
      cashPosition: 0,
      receivables: 0,
      payables: 0,
      netPosition: 0
    };

    try {
      // Get bank balances
      const accounts = await this.odooClient.searchRead('account.account', [
        ['account_type', 'in', ['asset_cash', 'liability_credit_card']]
      ], ['name', 'current_balance']);

      snapshot.cashPosition = accounts.reduce((sum, a) => sum + (a.current_balance || 0), 0);

      // Get receivables
      const receivables = await this.odooClient.getAgedReceivables();
      snapshot.receivables = receivables.reduce((sum, r) => sum + (r.amount_residual || 0), 0);

      // Get payables
      const payables = await this.odooClient.getAgedPayables();
      snapshot.payables = payables.reduce((sum, p) => sum + Math.abs(p.amount_residual || 0), 0);

      snapshot.netPosition = snapshot.cashPosition + snapshot.receivables - snapshot.payables;

    } catch (error) {
      snapshot.error = error.message;
    }

    return snapshot;
  }

  async _getCashFlowStatus(params = {}) {
    const { forecast_days = 30 } = params;

    const snapshot = await this._getFinancialSnapshot();

    if (snapshot.error) {
      return snapshot;
    }

    // Get upcoming payments
    let upcomingPayments = 0;
    let expectedReceipts = 0;

    try {
      if (this.agents.purchasing) {
        const schedule = await this.agents.purchasing._getPaymentSchedule({ days_ahead: forecast_days });
        upcomingPayments = schedule.totalDue || 0;
      }
    } catch (_e) { /* ignore */ }

    return {
      currentPosition: snapshot.cashPosition,
      receivables: snapshot.receivables,
      payables: snapshot.payables,
      upcomingPayments,
      expectedReceipts,
      projectedPosition: snapshot.cashPosition - upcomingPayments + expectedReceipts,
      forecastDays: forecast_days,
      status: snapshot.netPosition > 0 ? 'healthy' : 'attention_needed'
    };
  }

  async _getRevenueAnalysis(params = {}) {
    const { period = 'month' } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const daysBack = period === 'week' ? 7 : period === 'month' ? 30 : 90;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);

    try {
      const invoices = await this.odooClient.searchRead('account.move', [
        ['move_type', '=', 'out_invoice'],
        ['state', '=', 'posted'],
        ['invoice_date', '>=', cutoffDate.toISOString().split('T')[0]]
      ], ['amount_total', 'partner_id', 'invoice_date']);

      const totalRevenue = invoices.reduce((sum, i) => sum + (i.amount_total || 0), 0);

      return {
        period,
        totalRevenue,
        invoiceCount: invoices.length,
        avgInvoiceValue: invoices.length > 0 ? (totalRevenue / invoices.length).toFixed(2) : 0
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  // ==================== OPERATIONS OVERVIEW ====================

  async _getOperationsStatus(_params = {}) {
    const status = {
      timestamp: new Date().toISOString(),
      projects: {},
      purchasing: {},
      ecommerce: {}
    };

    try {
      if (this.agents.project) {
        const atRisk = await this.agents.project._getAtRiskProjects({});
        const overdue = await this.agents.project._getOverdueTasks({});

        status.projects = {
          atRiskCount: atRisk.count,
          overdueTaskCount: overdue.count,
          status: atRisk.count === 0 && overdue.count < 5 ? 'healthy' : 'needs_attention'
        };
      }
    } catch (e) {
      status.projects = { error: e.message };
    }

    try {
      if (this.agents.purchasing) {
        const pending = await this.agents.purchasing._getPendingOrders({});
        status.purchasing = {
          pendingApproval: pending.counts.pendingApproval,
          pendingReceipt: pending.counts.pendingReceipt,
          status: pending.counts.pendingApproval < 5 ? 'healthy' : 'needs_attention'
        };
      }
    } catch (e) {
      status.purchasing = { error: e.message };
    }

    return status;
  }

  async _getBottlenecks(_params = {}) {
    const bottlenecks = [];

    try {
      if (this.agents.project) {
        const blockers = await this.agents.project._detectBlockers({});
        if (blockers.count > 0) {
          bottlenecks.push({
            area: 'Projects',
            issue: `${blockers.count} blocked/stalled tasks`,
            impact: 'Project delays',
            recommendation: 'Review and unblock tasks'
          });
        }
      }
    } catch (_e) { /* ignore */ }

    try {
      if (this.agents.purchasing) {
        const pending = await this.agents.purchasing._getPendingOrders({});
        if (pending.counts.pendingApproval > 5) {
          bottlenecks.push({
            area: 'Purchasing',
            issue: `${pending.counts.pendingApproval} POs awaiting approval`,
            impact: 'Delayed procurement',
            recommendation: 'Review and approve pending orders'
          });
        }
      }
    } catch (_e) { /* ignore */ }

    return {
      bottlenecks,
      count: bottlenecks.length
    };
  }

  // ==================== TEAM & PERFORMANCE ====================

  async _getTeamOverview(_params = {}) {
    if (!this.agents.project) {
      return { error: 'Project agent not available' };
    }

    const workload = await this.agents.project._getTeamWorkload({});

    return {
      totalMembers: workload.totalMembers,
      averageTaskLoad: workload.averageTasksPerPerson,
      overloadedMembers: workload.overloadedMembers.map(m => ({
        name: m.name,
        taskCount: m.totalTasks,
        overdueCount: m.overdueTasks
      })),
      teamHealth: workload.overloadedMembers.length === 0 ? 'balanced' : 'imbalanced'
    };
  }

  async _getProductivityMetrics(params = {}) {
    const { period_days = 30 } = params;

    if (!this.agents.project) {
      return { error: 'Project agent not available' };
    }

    return this.agents.project._getPerformanceMetrics({ period_days });
  }

  // ==================== DECISION SUPPORT ====================

  async _getPendingDecisions(_params = {}) {
    return {
      decisions: this.pendingDecisions.filter(d => d.status === 'pending'),
      count: this.pendingDecisions.filter(d => d.status === 'pending').length
    };
  }

  async _analyzeDecision(params) {
    const { question, context } = params;

    // Gather relevant data
    const pulse = await this._getCompanyPulse();
    const financial = await this._getFinancialSnapshot();

    const analysisPrompt = `As an AI executive advisor, analyze this decision:

Question: ${question}

Context: ${context || 'No additional context provided'}

Current Company Status:
- Overall Health: ${pulse.overallHealth} (${pulse.healthScore}/100)
- Cash Position: €${financial.cashPosition?.toFixed(2) || 'Unknown'}
- Net Position: €${financial.netPosition?.toFixed(2) || 'Unknown'}

Provide:
1. Key factors to consider
2. Risks and opportunities
3. Recommendation with rationale
4. Suggested next steps`;

    const analysis = await this._generateWithLLM(analysisPrompt);

    return {
      question,
      context,
      analysis,
      companyContext: {
        healthScore: pulse.healthScore,
        cashPosition: financial.cashPosition
      },
      generatedAt: new Date().toISOString()
    };
  }

  async _recordDecision(params) {
    const { decision_id, decision, rationale, follow_up_actions } = params;

    const record = {
      id: decision_id || `decision_${Date.now()}`,
      decision,
      rationale,
      followUpActions: follow_up_actions || [],
      recordedAt: new Date().toISOString(),
      recordedBy: 'ExecutiveAgent'
    };

    // Update pending decision if exists
    if (decision_id) {
      const pending = this.pendingDecisions.find(d => d.id === decision_id);
      if (pending) {
        pending.status = 'decided';
        pending.decision = record;
      }
    }

    return {
      success: true,
      record
    };
  }

  // ==================== STRATEGIC RECOMMENDATIONS ====================

  async _getStrategicRecommendations(params = {}) {
    const { focus_area = 'all' } = params;

    const [pulse, financial, bottlenecks] = await Promise.all([
      this._getCompanyPulse(),
      this._getFinancialSnapshot(),
      this._getBottlenecks()
    ]);

    const prompt = `Based on this company data, provide 3-5 strategic recommendations:

Focus Area: ${focus_area}

Company Health: ${pulse.overallHealth} (${pulse.healthScore}/100)
Cash Position: €${financial.cashPosition?.toFixed(2) || 'Unknown'}
Net Position: €${financial.netPosition?.toFixed(2) || 'Unknown'}

Current Bottlenecks:
${bottlenecks.bottlenecks.map(b => `- ${b.area}: ${b.issue}`).join('\n')}

Department Status:
${Object.entries(pulse.departments).map(([name, data]) => `- ${name}: ${data.status}`).join('\n')}

Provide actionable strategic recommendations in JSON format:
{
  "recommendations": [
    {
      "title": "Recommendation title",
      "description": "Brief description",
      "priority": "high/medium/low",
      "expectedImpact": "Expected outcome",
      "timeframe": "Short-term/Medium-term/Long-term"
    }
  ]
}`;

    try {
      const response = await this._generateWithLLM(prompt);
      const parsed = JSON.parse(response);
      return parsed;
    } catch (_e) {
      return {
        recommendations: [
          {
            title: 'Address Bottlenecks',
            description: 'Review and resolve current operational bottlenecks',
            priority: 'high',
            expectedImpact: 'Improved operational efficiency',
            timeframe: 'Short-term'
          }
        ]
      };
    }
  }

  async _analyzeOpportunity(params) {
    const { opportunity, investment_required, timeframe } = params;

    const financial = await this._getFinancialSnapshot();

    const prompt = `Analyze this business opportunity:

Opportunity: ${opportunity}
Investment Required: €${investment_required || 'Not specified'}
Timeframe: ${timeframe || 'Not specified'}

Current Financial Position:
- Cash: €${financial.cashPosition?.toFixed(2) || 'Unknown'}
- Net Position: €${financial.netPosition?.toFixed(2) || 'Unknown'}

Provide analysis including:
1. Feasibility assessment
2. Risk analysis
3. Potential ROI
4. Resource requirements
5. Recommendation (proceed/hold/decline)`;

    const analysis = await this._generateWithLLM(prompt);

    return {
      opportunity,
      investmentRequired: investment_required,
      timeframe,
      analysis,
      financialContext: {
        cashAvailable: financial.cashPosition,
        canAfford: investment_required ? financial.cashPosition >= investment_required : 'unknown'
      }
    };
  }

  // ==================== COMMUNICATION ====================

  async _getCommunicationSummary(params = {}) {
    const { type: _type = 'all' } = params;

    if (!this.agents.communication) {
      return { message: 'Communication agent not available' };
    }

    return this.agents.communication._getCommunicationSummary({ period: 'today' });
  }

  async _draftExecutiveMessage(params) {
    const { recipient_type, subject, key_points, tone = 'formal' } = params;

    const prompt = `Draft a ${tone} message from an executive:

Recipient Type: ${recipient_type}
Subject: ${subject}

Key Points to Include:
${key_points.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Write a professional message that is clear, concise, and appropriate for the ${recipient_type} audience.`;

    const message = await this._generateWithLLM(prompt);

    return {
      subject,
      recipientType: recipient_type,
      tone,
      draft: message,
      status: 'draft_ready',
      message: 'Draft ready for review and approval before sending'
    };
  }

  // ==================== HELPER METHODS ====================

  async _generateWithLLM(prompt) {
    try {
      const response = await this.llmClient.chat.completions.create({
        model: this.config.model || 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are an AI executive advisor helping manage a company. Be concise, actionable, and data-driven in your responses.'
          },
          { role: 'user', content: prompt }
        ]
      });

      return response.choices[0].message.content;
    } catch (error) {
      return `Unable to generate response: ${error.message}`;
    }
  }

  // ==================== AGENT CONNECTIONS ====================

  setAgent(type, agent) {
    if (this.agents.hasOwnProperty(type)) {
      this.agents[type] = agent;
    }
  }

  setOdooClient(client) {
    this.odooClient = client;
  }

  // ==================== LIFECYCLE ====================

  async init() {
    await super.init();
    console.log('Executive Agent (AI Chief of Staff) initialized');
  }
}

module.exports = {
  ExecutiveAgent,
  AlertSeverity,
  DecisionType
};
