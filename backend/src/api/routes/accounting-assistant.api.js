/**
 * Accounting Assistant API Routes
 *
 * REST API for the Accounting Assistant - conversational interface,
 * knowledge management, and approval workflow
 */

const express = require('express');
const router = express.Router();
const AccountingKnowledge = require('../../models/AccountingKnowledge');
const AccountingApproval = require('../../models/AccountingApproval');

// Lazy-load the assistant to avoid circular dependencies
let accountingAssistant = null;

async function getAccountingAssistant() {
  if (!accountingAssistant) {
    const { AccountingAssistant } = require('../../core/agents/specialized/AccountingAssistant');
    accountingAssistant = new AccountingAssistant();
    await accountingAssistant.init(null);
  }
  return accountingAssistant;
}

// ==================== CHAT INTERFACE ====================

/**
 * @route POST /api/accounting-assistant/chat
 * @desc Send a message to the accounting assistant
 */
router.post('/chat', async (req, res) => {
  try {
    const { message, session_id } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const sessionId = session_id || req.sessionID || `session-${Date.now()}`;
    const assistant = await getAccountingAssistant();

    const startTime = Date.now();
    const response = await assistant.chat(sessionId, message, {
      userId: req.user?.id,
    });

    res.json({
      success: true,
      sessionId,
      response: response.text,
      data: response.data,
      metadata: {
        toolsUsed: response.toolsUsed,
        knowledgeRetrieved: response.knowledgeRetrieved,
        durationMs: Date.now() - startTime,
      },
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route DELETE /api/accounting-assistant/chat/:sessionId
 * @desc Clear conversation history for a session
 */
router.delete('/chat/:sessionId', async (req, res) => {
  try {
    const assistant = await getAccountingAssistant();
    assistant.clearConversation(req.params.sessionId);
    res.json({ success: true, message: 'Conversation cleared' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== KNOWLEDGE MANAGEMENT ====================

/**
 * @route GET /api/accounting-assistant/knowledge
 * @desc List all knowledge entries
 */
router.get('/knowledge', async (req, res) => {
  try {
    const { category, search, limit = 50, offset = 0 } = req.query;

    const query = { active: true };
    if (category) query.category = category;

    let entries;
    if (search) {
      entries = await AccountingKnowledge.textSearch(search, Number(limit));
    } else {
      entries = await AccountingKnowledge.find(query)
        .sort({ category: 1, priority: -1, usageCount: -1 })
        .skip(Number(offset))
        .limit(Number(limit))
        .lean();
    }

    const total = await AccountingKnowledge.countDocuments(query);

    res.json({
      success: true,
      count: entries.length,
      total,
      entries: entries.map(e => ({
        id: e._id?.toString() || e._id,
        category: e.category,
        subject: e.subject,
        fact: e.fact,
        tags: e.tags,
        priority: e.priority,
        usageCount: e.usageCount,
        lastUsed: e.lastUsedAt,
        createdAt: e.createdAt,
        createdBy: e.createdBy,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting-assistant/knowledge/categories
 * @desc Get knowledge categories with counts
 */
router.get('/knowledge/categories', async (req, res) => {
  try {
    const categories = await AccountingKnowledge.aggregate([
      { $match: { active: true } },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          totalUsage: { $sum: '$usageCount' },
        }
      },
      { $sort: { count: -1 } },
    ]);

    res.json({
      success: true,
      categories: categories.map(c => ({
        category: c._id,
        count: c.count,
        totalUsage: c.totalUsage,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting-assistant/knowledge/:id
 * @desc Get a specific knowledge entry
 */
router.get('/knowledge/:id', async (req, res) => {
  try {
    const knowledge = await AccountingKnowledge.findById(req.params.id).lean();

    if (!knowledge) {
      return res.status(404).json({ success: false, error: 'Knowledge not found' });
    }

    res.json({
      success: true,
      knowledge: {
        id: knowledge._id.toString(),
        category: knowledge.category,
        subject: knowledge.subject,
        fact: knowledge.fact,
        structuredData: knowledge.structuredData,
        relatedOdooIds: knowledge.relatedOdooIds,
        tags: knowledge.tags,
        priority: knowledge.priority,
        source: knowledge.source,
        validFrom: knowledge.validFrom,
        validUntil: knowledge.validUntil,
        usageCount: knowledge.usageCount,
        lastUsed: knowledge.lastUsedAt,
        createdAt: knowledge.createdAt,
        createdBy: knowledge.createdBy,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/accounting-assistant/knowledge
 * @desc Add new knowledge entry
 */
router.post('/knowledge', async (req, res) => {
  try {
    const {
      category,
      subject,
      fact,
      structured_data,
      related_odoo_ids,
      tags,
      priority,
    } = req.body;

    if (!category || !subject || !fact) {
      return res.status(400).json({
        success: false,
        error: 'category, subject, and fact are required',
      });
    }

    // Use embedding service if available
    let knowledge;
    try {
      const { getEmbeddingService } = require('../../services/accounting/EmbeddingService');
      const embeddingService = getEmbeddingService();

      knowledge = await embeddingService.addKnowledge({
        category,
        subject,
        fact,
        structuredData: structured_data,
        relatedOdooIds: related_odoo_ids,
        tags,
        priority,
        source: { type: 'user_training', context: 'API' },
      }, req.user?.id || 'api');
    } catch (e) {
      // Fallback without embeddings
      knowledge = await AccountingKnowledge.create({
        category,
        subject,
        fact,
        structuredData: structured_data,
        relatedOdooIds: related_odoo_ids,
        tags,
        priority: priority || 0,
        source: { type: 'user_training', userId: req.user?.id || 'api' },
        createdBy: req.user?.id || 'api',
        active: true,
      });
    }

    res.status(201).json({
      success: true,
      knowledge: {
        id: knowledge._id.toString(),
        category: knowledge.category,
        subject: knowledge.subject,
        fact: knowledge.fact,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route PUT /api/accounting-assistant/knowledge/:id
 * @desc Update a knowledge entry
 */
router.put('/knowledge/:id', async (req, res) => {
  try {
    const { subject, fact, structured_data, tags, priority } = req.body;

    const knowledge = await AccountingKnowledge.findById(req.params.id);
    if (!knowledge) {
      return res.status(404).json({ success: false, error: 'Knowledge not found' });
    }

    if (subject) knowledge.subject = subject;
    if (fact) knowledge.fact = fact;
    if (structured_data !== undefined) knowledge.structuredData = structured_data;
    if (tags) knowledge.tags = tags;
    if (priority !== undefined) knowledge.priority = priority;
    knowledge.updatedBy = req.user?.id || 'api';

    // Update embedding if fact changed
    if (fact) {
      try {
        const { getEmbeddingService } = require('../../services/accounting/EmbeddingService');
        const embeddingService = getEmbeddingService();
        const embeddingText = `${knowledge.category}: ${knowledge.subject}. ${knowledge.fact}`;
        knowledge.embedding = await embeddingService.generateEmbedding(embeddingText);
        knowledge.embeddingText = embeddingText;
      } catch (e) {
        // Embedding update failed, continue anyway
      }
    }

    await knowledge.save();

    res.json({
      success: true,
      knowledge: {
        id: knowledge._id.toString(),
        category: knowledge.category,
        subject: knowledge.subject,
        fact: knowledge.fact,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route DELETE /api/accounting-assistant/knowledge/:id
 * @desc Deactivate a knowledge entry (soft delete)
 */
router.delete('/knowledge/:id', async (req, res) => {
  try {
    const knowledge = await AccountingKnowledge.findById(req.params.id);
    if (!knowledge) {
      return res.status(404).json({ success: false, error: 'Knowledge not found' });
    }

    knowledge.active = false;
    knowledge.updatedBy = req.user?.id || 'api';
    await knowledge.save();

    res.json({ success: true, message: 'Knowledge deactivated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/accounting-assistant/knowledge/search
 * @desc Semantic search over knowledge
 */
router.post('/knowledge/search', async (req, res) => {
  try {
    const { query, categories, limit = 10 } = req.body;

    if (!query) {
      return res.status(400).json({ success: false, error: 'Query is required' });
    }

    let results;
    try {
      const { getEmbeddingService } = require('../../services/accounting/EmbeddingService');
      const embeddingService = getEmbeddingService();

      results = await embeddingService.semanticSearch(query, {
        limit,
        categories,
        minScore: 0.4,
      });
    } catch (e) {
      // Fallback to text search
      results = await AccountingKnowledge.textSearch(query, limit);
    }

    res.json({
      success: true,
      count: results.length,
      results: results.map(r => ({
        id: r._id?.toString() || r._id,
        category: r.category,
        subject: r.subject,
        fact: r.fact,
        score: r.score,
        tags: r.tags,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== APPROVAL WORKFLOW ====================

/**
 * @route GET /api/accounting-assistant/approvals
 * @desc Get approval requests
 */
router.get('/approvals', async (req, res) => {
  try {
    const { status = 'pending', type, limit = 50 } = req.query;

    let approvals;
    if (status === 'pending') {
      approvals = await AccountingApproval.getPending(type, Number(limit));
    } else {
      const query = {};
      if (status !== 'all') query.status = status;
      if (type) query.type = type;

      approvals = await AccountingApproval.find(query)
        .sort({ requestedAt: -1 })
        .limit(Number(limit))
        .lean();
    }

    res.json({
      success: true,
      count: approvals.length,
      approvals: approvals.map(a => ({
        id: a._id.toString(),
        type: a.type,
        description: a.action.description,
        preview: a.action.preview,
        amount: a.amount,
        reason: a.reason,
        risk: a.risk,
        status: a.status,
        requestedAt: a.requestedAt,
        requestedBy: a.requestedBy,
        expiresAt: a.expiresAt,
        reviewedAt: a.reviewedAt,
        reviewedBy: a.reviewedBy,
        reviewerNote: a.reviewerNote,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting-assistant/approvals/:id
 * @desc Get a specific approval request
 */
router.get('/approvals/:id', async (req, res) => {
  try {
    const approval = await AccountingApproval.findById(req.params.id).lean();

    if (!approval) {
      return res.status(404).json({ success: false, error: 'Approval not found' });
    }

    res.json({
      success: true,
      approval: {
        id: approval._id.toString(),
        type: approval.type,
        action: approval.action,
        amount: approval.amount,
        reason: approval.reason,
        conversationContext: approval.conversationContext,
        risk: approval.risk,
        status: approval.status,
        requestedAt: approval.requestedAt,
        requestedBy: approval.requestedBy,
        expiresAt: approval.expiresAt,
        reviewedAt: approval.reviewedAt,
        reviewedBy: approval.reviewedBy,
        reviewerNote: approval.reviewerNote,
        executedAt: approval.executedAt,
        executionResult: approval.executionResult,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/accounting-assistant/approvals/:id/approve
 * @desc Approve a pending request
 */
router.post('/approvals/:id/approve', async (req, res) => {
  try {
    const { note } = req.body;

    const approval = await AccountingApproval.findById(req.params.id);
    if (!approval) {
      return res.status(404).json({ success: false, error: 'Approval not found' });
    }

    if (!approval.isActionable) {
      return res.status(400).json({
        success: false,
        error: `Approval is ${approval.status}, cannot approve`,
      });
    }

    await approval.approve(req.user?.id || 'api', note);

    // TODO: Execute the approved action
    // This would call the appropriate service based on approval.type

    res.json({
      success: true,
      approval: {
        id: approval._id.toString(),
        status: approval.status,
        reviewedAt: approval.reviewedAt,
      },
      message: 'Approval granted. Action will be executed.',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/accounting-assistant/approvals/:id/reject
 * @desc Reject a pending request
 */
router.post('/approvals/:id/reject', async (req, res) => {
  try {
    const { note } = req.body;

    if (!note) {
      return res.status(400).json({
        success: false,
        error: 'Rejection note is required',
      });
    }

    const approval = await AccountingApproval.findById(req.params.id);
    if (!approval) {
      return res.status(404).json({ success: false, error: 'Approval not found' });
    }

    if (!approval.isActionable) {
      return res.status(400).json({
        success: false,
        error: `Approval is ${approval.status}, cannot reject`,
      });
    }

    await approval.reject(req.user?.id || 'api', note);

    res.json({
      success: true,
      approval: {
        id: approval._id.toString(),
        status: approval.status,
        reviewedAt: approval.reviewedAt,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting-assistant/approvals/stats
 * @desc Get approval statistics
 */
router.get('/approvals/stats', async (req, res) => {
  try {
    const { days = 30 } = req.query;

    const stats = await AccountingApproval.getStats(Number(days));

    // Also get pending count
    const pendingCount = await AccountingApproval.countDocuments({
      status: 'pending',
      expiresAt: { $gt: new Date() },
    });

    res.json({
      success: true,
      pendingCount,
      stats,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== UTILITIES ====================

/**
 * @route POST /api/accounting-assistant/knowledge/import
 * @desc Bulk import knowledge entries
 */
router.post('/knowledge/import', async (req, res) => {
  try {
    const { entries } = req.body;

    if (!entries || !Array.isArray(entries)) {
      return res.status(400).json({
        success: false,
        error: 'entries array is required',
      });
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [],
    };

    for (const entry of entries) {
      try {
        if (!entry.category || !entry.subject || !entry.fact) {
          results.failed++;
          results.errors.push({ entry: entry.subject, error: 'Missing required fields' });
          continue;
        }

        await AccountingKnowledge.create({
          ...entry,
          source: { type: 'imported', userId: req.user?.id || 'api' },
          createdBy: req.user?.id || 'api',
          active: true,
        });

        results.success++;
      } catch (e) {
        results.failed++;
        results.errors.push({ entry: entry.subject, error: e.message });
      }
    }

    res.json({
      success: true,
      results,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/accounting-assistant/knowledge/update-embeddings
 * @desc Regenerate embeddings for all knowledge entries
 */
router.post('/knowledge/update-embeddings', async (req, res) => {
  try {
    const { getEmbeddingService } = require('../../services/accounting/EmbeddingService');
    const embeddingService = getEmbeddingService();

    const count = await embeddingService.updateMissingEmbeddings(50);

    res.json({
      success: true,
      message: `Updated embeddings for ${count} entries`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/accounting-assistant/health
 * @desc Health check for the accounting assistant
 */
router.get('/health', async (req, res) => {
  try {
    const assistant = await getAccountingAssistant();

    const status = {
      assistant: assistant ? 'ready' : 'not_initialized',
      odoo: assistant?.odooClient ? 'connected' : 'not_connected',
      embeddings: assistant?.embeddingService ? 'available' : 'not_available',
    };

    const knowledgeCount = await AccountingKnowledge.countDocuments({ active: true });
    const pendingApprovals = await AccountingApproval.countDocuments({
      status: 'pending',
      expiresAt: { $gt: new Date() },
    });

    res.json({
      success: true,
      status,
      stats: {
        knowledgeEntries: knowledgeCount,
        pendingApprovals,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
