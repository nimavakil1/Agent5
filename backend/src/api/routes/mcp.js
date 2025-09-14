const express = require('express');
const router = express.Router();
const { getToolsSpec, callTool } = require('../../services/mcpTools');

function who(req) {
  const user = req.user || {};
  return { id: String(user._id || user.id || ''), email: String(user.email || 'system') };
}

// List available tools (MCP-style discovery)
router.get('/tools', async (_req, res) => {
  res.json({ tools: getToolsSpec() });
});

// Call a tool by name
router.post('/call', async (req, res) => {
  const { name, params, idempotency_key } = req.body || {};
  const { id, email } = who(req);
  try {
    const result = await callTool(name, params, { user: { id, email }, idempotencyKey: idempotency_key });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ message: 'error', error: e.message });
  }
});

module.exports = router;
