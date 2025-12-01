/**
 * Agent API Routes
 *
 * REST API for interacting with the AI Agent system.
 */

const express = require('express');
const router = express.Router();
const { getAgentRegistry } = require('../../core/agents');

/**
 * @route GET /api/agents
 * @desc List all registered agents
 */
router.get('/', (req, res) => {
  try {
    const registry = getAgentRegistry();
    const agents = registry.list();

    res.json({
      success: true,
      count: agents.length,
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        state: a.state,
        capabilities: a.status.capabilities,
        metrics: a.status.metrics,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/agents/health
 * @desc Get health status of all agents
 */
router.get('/health', (req, res) => {
  try {
    const registry = getAgentRegistry();
    const health = registry.getHealth();

    res.json({
      success: true,
      health,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/agents/:id
 * @desc Get details of a specific agent
 */
router.get('/:id', (req, res) => {
  try {
    const registry = getAgentRegistry();
    const agent = registry.get(req.params.id);

    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    res.json({
      success: true,
      agent: agent.getStatus(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/agents/query
 * @desc Send a natural language query to the agent system
 */
router.post('/query', async (req, res) => {
  try {
    const { question, options = {} } = req.body;

    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required' });
    }

    const registry = getAgentRegistry();
    const manager = registry.getByName('ManagerAgent');

    if (!manager) {
      return res.status(503).json({ success: false, error: 'Manager agent not available' });
    }

    const result = await manager.execute({
      type: 'query',
      question,
      ...options,
    });

    res.json({
      success: result.success,
      result: result.result,
      executionId: result.executionId,
      durationMs: result.durationMs,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/agents/task
 * @desc Send a task to a specific agent or let the system route it
 */
router.post('/task', async (req, res) => {
  try {
    const { task, agentId, agentRole } = req.body;

    if (!task) {
      return res.status(400).json({ success: false, error: 'Task is required' });
    }

    const registry = getAgentRegistry();
    let result;

    if (agentId) {
      // Send to specific agent
      result = await registry.sendTask(agentId, task);
    } else if (agentRole) {
      // Send to agent with role
      result = await registry.sendTaskToRole(agentRole, task);
    } else {
      // Let manager route it
      const manager = registry.getByName('ManagerAgent');
      if (!manager) {
        return res.status(503).json({ success: false, error: 'Manager agent not available' });
      }
      result = await manager.execute(task);
    }

    res.json({
      success: result.success,
      result: result.result,
      executionId: result.executionId,
      durationMs: result.durationMs,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/agents/finance/invoices
 * @desc Get invoices through the Finance Agent
 */
router.post('/finance/invoices', async (req, res) => {
  try {
    const { status, type, partner, date_from, date_to, limit } = req.body;

    const registry = getAgentRegistry();
    const financeAgent = registry.getByName('FinanceAgent');

    if (!financeAgent) {
      return res.status(503).json({ success: false, error: 'Finance agent not available' });
    }

    const result = await financeAgent.execute({
      type: 'get_invoices',
      description: 'Get invoices with filters',
      params: { status, type, partner, date_from, date_to, limit },
    });

    res.json({
      success: result.success,
      data: result.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/agents/finance/summary
 * @desc Get financial summary through the Finance Agent
 */
router.get('/finance/summary', async (req, res) => {
  try {
    const { period = 'month' } = req.query;

    const registry = getAgentRegistry();
    const financeAgent = registry.getByName('FinanceAgent');

    if (!financeAgent) {
      return res.status(503).json({ success: false, error: 'Finance agent not available' });
    }

    const result = await financeAgent.execute({
      type: 'get_financial_summary',
      description: 'Get financial summary',
      params: { period },
    });

    res.json({
      success: result.success,
      data: result.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/agents/finance/unpaid
 * @desc Get unpaid invoices with aging
 */
router.get('/finance/unpaid', async (req, res) => {
  try {
    const { days_overdue } = req.query;

    const registry = getAgentRegistry();
    const financeAgent = registry.getByName('FinanceAgent');

    if (!financeAgent) {
      return res.status(503).json({ success: false, error: 'Finance agent not available' });
    }

    const result = await financeAgent.execute({
      type: 'get_unpaid_invoices',
      description: 'Get unpaid invoices',
      params: { days_overdue: days_overdue ? parseInt(days_overdue) : undefined },
    });

    res.json({
      success: result.success,
      data: result.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/agents/manager/overview
 * @desc Get company overview from Manager Agent
 */
router.get('/manager/overview', async (req, res) => {
  try {
    const registry = getAgentRegistry();
    const manager = registry.getByName('ManagerAgent');

    if (!manager) {
      return res.status(503).json({ success: false, error: 'Manager agent not available' });
    }

    const result = await manager.execute({
      type: 'get_company_overview',
      description: 'Get full company overview',
    });

    res.json({
      success: result.success,
      data: result.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/agents/manager/approvals
 * @desc Get pending approval requests
 */
router.get('/manager/approvals', async (req, res) => {
  try {
    const registry = getAgentRegistry();
    const manager = registry.getByName('ManagerAgent');

    if (!manager) {
      return res.status(503).json({ success: false, error: 'Manager agent not available' });
    }

    const result = await manager.execute({
      type: 'list_pending_approvals',
      description: 'List pending approvals',
    });

    res.json({
      success: result.success,
      data: result.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/agents/manager/approve
 * @desc Approve a pending request
 */
router.post('/manager/approve', async (req, res) => {
  try {
    const { approval_id, reason } = req.body;

    if (!approval_id) {
      return res.status(400).json({ success: false, error: 'approval_id is required' });
    }

    const registry = getAgentRegistry();
    const manager = registry.getByName('ManagerAgent');

    if (!manager) {
      return res.status(503).json({ success: false, error: 'Manager agent not available' });
    }

    const result = await manager.execute({
      type: 'approve_request',
      description: 'Approve request',
      params: { approval_id, reason },
    });

    res.json({
      success: result.success,
      data: result.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/agents/manager/reject
 * @desc Reject a pending request
 */
router.post('/manager/reject', async (req, res) => {
  try {
    const { approval_id, reason } = req.body;

    if (!approval_id || !reason) {
      return res.status(400).json({ success: false, error: 'approval_id and reason are required' });
    }

    const registry = getAgentRegistry();
    const manager = registry.getByName('ManagerAgent');

    if (!manager) {
      return res.status(503).json({ success: false, error: 'Manager agent not available' });
    }

    const result = await manager.execute({
      type: 'reject_request',
      description: 'Reject request',
      params: { approval_id, reason },
    });

    res.json({
      success: result.success,
      data: result.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/agents/manager/recommendations
 * @desc Get strategic recommendations
 */
router.post('/manager/recommendations', async (req, res) => {
  try {
    const { area, context = {} } = req.body;

    const registry = getAgentRegistry();
    const manager = registry.getByName('ManagerAgent');

    if (!manager) {
      return res.status(503).json({ success: false, error: 'Manager agent not available' });
    }

    const result = await manager.execute({
      type: 'get_recommendations',
      description: 'Get strategic recommendations',
      params: { area, context },
    });

    res.json({
      success: result.success,
      data: result.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
