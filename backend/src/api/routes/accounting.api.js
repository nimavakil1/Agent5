/**
 * Accounting API Routes
 *
 * REST API for the Accounting Agent - invoice processing, AP/AR, reporting
 */

const express = require('express');
const router = express.Router();
const { getAgentRegistry } = require('../../core/agents');
const VendorInvoice = require('../../models/VendorInvoice');
const AccountingTask = require('../../models/AccountingTask');
const InvoiceAuditLog = require('../../models/InvoiceAuditLog');

// Helper to get the AccountingAgent
function getAccountingAgent() {
  const registry = getAgentRegistry();
  return registry.getByRole('accounting') || registry.getByName('AccountingAgent');
}

// ==================== INVOICE MANAGEMENT ====================

/**
 * @route GET /api/accounting/invoices
 * @desc Get invoices from the processing queue
 */
router.get('/invoices', async (req, res) => {
  try {
    const {
      status,
      vendor,
      date_from,
      date_to,
      limit = 50,
      offset = 0,
      sort = '-createdAt',
    } = req.query;

    const query = {};

    if (status && status !== 'all') {
      query.status = status;
    }

    if (vendor) {
      query['vendor.name'] = { $regex: vendor, $options: 'i' };
    }

    if (date_from || date_to) {
      query['invoice.date'] = {};
      if (date_from) query['invoice.date'].$gte = new Date(date_from);
      if (date_to) query['invoice.date'].$lte = new Date(date_to);
    }

    const [invoices, total] = await Promise.all([
      VendorInvoice.find(query)
        .sort(sort)
        .skip(Number(offset))
        .limit(Number(limit))
        .lean(),
      VendorInvoice.countDocuments(query),
    ]);

    res.json({
      success: true,
      count: invoices.length,
      total,
      invoices: invoices.map(inv => ({
        id: inv._id,
        invoiceNumber: inv.invoice?.number,
        vendorName: inv.vendor?.name,
        vendorVat: inv.vendor?.vatNumber,
        amount: inv.totals?.totalAmount,
        currency: inv.invoice?.currency || 'EUR',
        invoiceDate: inv.invoice?.date,
        dueDate: inv.invoice?.dueDate,
        status: inv.status,
        matchingStatus: inv.matching?.status,
        matchConfidence: inv.matching?.matchedPurchaseOrders?.[0]?.matchConfidence,
        source: inv.source?.type,
        receivedAt: inv.createdAt,
        odooInvoiceId: inv.odoo?.billId,
        errors: inv.errors?.length > 0 ? inv.errors[inv.errors.length - 1].message : null,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting/invoices/:id
 * @desc Get a specific invoice with full details
 */
router.get('/invoices/:id', async (req, res) => {
  try {
    const invoice = await VendorInvoice.findById(req.params.id).lean();

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    // Get audit trail
    const auditTrail = await InvoiceAuditLog.find({ invoiceId: invoice._id })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    res.json({
      success: true,
      invoice: {
        ...invoice,
        id: invoice._id,
        auditTrail,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/accounting/invoices/:id/process
 * @desc Process a pending invoice (parse, match)
 */
router.post('/invoices/:id/process', async (req, res) => {
  try {
    const invoice = await VendorInvoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    // Import InvoiceProcessor (will be created)
    let InvoiceProcessor;
    try {
      InvoiceProcessor = require('../../services/accounting/InvoiceProcessor');
    } catch (e) {
      // Service not yet implemented
      return res.status(501).json({
        success: false,
        error: 'Invoice processing service not yet implemented',
      });
    }

    const result = await InvoiceProcessor.processInvoice(invoice._id);

    // Log the action
    await InvoiceAuditLog.log(invoice._id, 'parsing_started', {
      invoiceNumber: invoice.invoice?.number,
      vendorName: invoice.vendor?.name,
      actor: { type: 'user', id: req.user?.id, name: req.user?.name },
    });

    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/accounting/invoices/:id/approve
 * @desc Approve an invoice for booking
 */
router.post('/invoices/:id/approve', async (req, res) => {
  try {
    const { notes } = req.body;
    const invoice = await VendorInvoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    invoice.approval = invoice.approval || {};
    invoice.approval.required = true;
    invoice.approval.approvedAt = new Date();
    invoice.approval.approvedBy = req.user?.id || 'api';
    invoice.approval.notes = notes;

    if (invoice.status === 'manual_review') {
      invoice.status = 'matched';
    }

    await invoice.save();

    // Log the action
    await InvoiceAuditLog.log(invoice._id, 'approval_granted', {
      invoiceNumber: invoice.invoice?.number,
      vendorName: invoice.vendor?.name,
      actor: { type: 'user', id: req.user?.id, name: req.user?.name },
      details: { notes },
    });

    res.json({ success: true, invoice: { id: invoice._id, status: invoice.status } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/accounting/invoices/:id/reject
 * @desc Reject an invoice
 */
router.post('/invoices/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ success: false, error: 'Rejection reason is required' });
    }

    const invoice = await VendorInvoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    invoice.status = 'rejected';
    invoice.approval = invoice.approval || {};
    invoice.approval.rejectedAt = new Date();
    invoice.approval.rejectedBy = req.user?.id || 'api';
    invoice.approval.rejectionReason = reason;

    await invoice.save();

    // Log the action
    await InvoiceAuditLog.log(invoice._id, 'rejected', {
      invoiceNumber: invoice.invoice?.number,
      vendorName: invoice.vendor?.name,
      actor: { type: 'user', id: req.user?.id, name: req.user?.name },
      details: { reason },
    });

    res.json({ success: true, invoice: { id: invoice._id, status: invoice.status } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/accounting/invoices/:id/book
 * @desc Book an invoice to Odoo
 */
router.post('/invoices/:id/book', async (req, res) => {
  try {
    const { force } = req.body;
    const invoice = await VendorInvoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    // Import OdooVendorBillCreator (will be created)
    let OdooVendorBillCreator;
    try {
      OdooVendorBillCreator = require('../../services/accounting/OdooVendorBillCreator');
    } catch (e) {
      return res.status(501).json({
        success: false,
        error: 'Odoo bill creation service not yet implemented',
      });
    }

    const result = await OdooVendorBillCreator.createVendorBill(invoice, { force });

    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== METRICS & DASHBOARD ====================

/**
 * @route GET /api/accounting/metrics
 * @desc Get dashboard metrics
 */
router.get('/metrics', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [statusCounts, todayProcessed, totalValue] = await Promise.all([
      VendorInvoice.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      VendorInvoice.countDocuments({
        status: 'booked',
        'odoo.createdAt': { $gte: today },
      }),
      VendorInvoice.aggregate([
        { $match: { status: { $in: ['received', 'parsed', 'matched', 'manual_review'] } } },
        { $group: { _id: null, total: { $sum: '$totals.totalAmount' } } }
      ]),
    ]);

    const metrics = {
      pendingInvoices: 0,
      processedToday: todayProcessed,
      totalValue: totalValue[0]?.total || 0,
      matchRate: 0,
      errorRate: 0,
      byStatus: {},
    };

    let totalCount = 0;
    let matchedCount = 0;
    let errorCount = 0;

    for (const { _id, count } of statusCounts) {
      metrics.byStatus[_id] = count;
      totalCount += count;

      if (['received', 'parsed', 'manual_review'].includes(_id)) {
        metrics.pendingInvoices += count;
      }
      if (_id === 'matched' || _id === 'booked') {
        matchedCount += count;
      }
      if (_id === 'error') {
        errorCount += count;
      }
    }

    if (totalCount > 0) {
      metrics.matchRate = matchedCount / totalCount;
      metrics.errorRate = errorCount / totalCount;
    }

    res.json({ success: true, metrics });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== REPORTS ====================

/**
 * @route GET /api/accounting/reports/aging
 * @desc Get aging report
 */
router.get('/reports/aging', async (req, res) => {
  try {
    const agent = getAccountingAgent();

    if (!agent) {
      return res.status(503).json({ success: false, error: 'Accounting agent not available' });
    }

    const { type = 'ap', as_of_date, group_by = 'vendor' } = req.query;

    const result = await agent._getAgingReport({ type, as_of_date, group_by });

    res.json({ success: true, report: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting/reports/cash-flow
 * @desc Get cash flow forecast
 */
router.get('/reports/cash-flow', async (req, res) => {
  try {
    const agent = getAccountingAgent();

    if (!agent) {
      return res.status(503).json({ success: false, error: 'Accounting agent not available' });
    }

    const { days_ahead = 30, include_draft = false } = req.query;

    const result = await agent._getCashFlowForecast({
      days_ahead: Number(days_ahead),
      include_draft: include_draft === 'true',
    });

    res.json({ success: true, report: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting/reports/vendor-summary
 * @desc Get vendor invoice summary
 */
router.get('/reports/vendor-summary', async (req, res) => {
  try {
    const { date_from, date_to } = req.query;

    const match = { status: 'booked' };
    if (date_from || date_to) {
      match['invoice.date'] = {};
      if (date_from) match['invoice.date'].$gte = new Date(date_from);
      if (date_to) match['invoice.date'].$lte = new Date(date_to);
    }

    const summary = await VendorInvoice.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$vendor.name',
          invoiceCount: { $sum: 1 },
          totalAmount: { $sum: '$totals.totalAmount' },
          avgAmount: { $avg: '$totals.totalAmount' },
          vendors: { $first: '$vendor' },
        }
      },
      { $sort: { totalAmount: -1 } },
    ]);

    res.json({
      success: true,
      report: {
        period: { from: date_from, to: date_to },
        vendors: summary.map(v => ({
          name: v._id,
          vatNumber: v.vendors?.vatNumber,
          invoiceCount: v.invoiceCount,
          totalAmount: v.totalAmount,
          avgAmount: v.avgAmount,
        })),
        totals: {
          vendors: summary.length,
          invoices: summary.reduce((sum, v) => sum + v.invoiceCount, 0),
          amount: summary.reduce((sum, v) => sum + v.totalAmount, 0),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SYNC & EMAIL ====================

/**
 * @route POST /api/accounting/sync
 * @desc Trigger Odoo sync
 */
router.post('/sync', async (req, res) => {
  try {
    const agent = getAccountingAgent();

    if (!agent) {
      return res.status(503).json({ success: false, error: 'Accounting agent not available' });
    }

    // Create a sync task
    const task = await AccountingTask.createTask('sync_odoo', {}, {
      source: { type: 'api', triggeredBy: req.user?.id },
    });

    res.json({
      success: true,
      message: 'Sync triggered',
      taskId: task.taskId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/accounting/invoices/scan
 * @desc Scan emails for new invoices
 */
router.post('/invoices/scan', async (req, res) => {
  try {
    const { folder = 'Inbox', hours_back = 24 } = req.body;

    const agent = getAccountingAgent();

    if (!agent) {
      return res.status(503).json({ success: false, error: 'Accounting agent not available' });
    }

    const result = await agent._scanEmailForInvoices({ folder, hours_back });

    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SETTINGS ====================

/**
 * @route GET /api/accounting/settings/rules
 * @desc Get processing rules
 */
router.get('/settings/rules', async (req, res) => {
  try {
    // For now, return default rules - these could be stored in MongoDB
    const rules = [
      {
        id: 'auto-approve-low',
        name: 'Auto-approve small invoices',
        condition: { field: 'amount', operator: 'lessThan', value: 500 },
        action: { type: 'auto_approve', value: 'true' },
        priority: 1,
        enabled: true,
      },
      {
        id: 'flag-new-vendor',
        name: 'Flag new vendors',
        condition: { field: 'vendor', operator: 'equals', value: 'new' },
        action: { type: 'assign_to', value: 'manual_review' },
        priority: 2,
        enabled: true,
      },
    ];

    res.json(rules);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting/settings/thresholds
 * @desc Get approval thresholds
 */
router.get('/settings/thresholds', async (req, res) => {
  try {
    const thresholds = [
      {
        id: 'auto',
        minAmount: 0,
        maxAmount: 500,
        requiredApprovers: [],
        autoApprove: true,
      },
      {
        id: 'manager',
        minAmount: 500,
        maxAmount: 5000,
        requiredApprovers: ['manager'],
        autoApprove: false,
      },
      {
        id: 'executive',
        minAmount: 5000,
        maxAmount: Infinity,
        requiredApprovers: ['manager', 'executive'],
        autoApprove: false,
      },
    ];

    res.json(thresholds);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting/settings/email
 * @desc Get email settings
 */
router.get('/settings/email', async (req, res) => {
  try {
    res.json({
      enabled: process.env.INVOICE_POLLING_ENABLED === '1',
      inbox: process.env.INVOICE_MAILBOX_USER_ID || '',
      processOnReceive: true,
      attachmentTypes: ['pdf', 'xml', 'jpg', 'png'],
      autoArchive: true,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting/settings/odoo
 * @desc Get Odoo sync settings
 */
router.get('/settings/odoo', async (req, res) => {
  try {
    res.json({
      autoBook: false,
      defaultJournal: '',
      defaultAccount: '',
      syncInterval: Number(process.env.INVOICE_POLLING_INTERVAL_MIN || 5) * 60,
      autoReconcile: true,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== VOICE SESSION ====================

/**
 * @route POST /api/accounting/voice/session
 * @desc Start a voice session with the accounting agent
 */
router.post('/voice/session', async (req, res) => {
  try {
    const { room_name, user_id } = req.body;
    const agent = getAccountingAgent();

    if (!agent) {
      return res.status(503).json({ success: false, error: 'Accounting agent not available' });
    }

    const roomName = room_name || `accounting-${Date.now()}`;
    const result = await agent.handleVoiceSession(roomName, user_id || req.user?.id);

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== AGENT QUERY ====================

/**
 * @route POST /api/accounting/query
 * @desc Send a query to the accounting agent
 */
router.post('/query', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required' });
    }

    const agent = getAccountingAgent();

    if (!agent) {
      return res.status(503).json({ success: false, error: 'Accounting agent not available' });
    }

    const startTime = Date.now();
    const result = await agent.execute({
      type: 'query',
      description: question,
    });

    res.json({
      success: true,
      result: result.result,
      executionId: result.executionId,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
