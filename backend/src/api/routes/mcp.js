const express = require('express');
const router = express.Router();
const { getToolsSpec, callTool } = require('../../services/mcpTools');
const McpConfig = require('../../models/McpConfig');

function who(req) {
  const user = req.user || {};
  return { id: String(user._id || user.id || ''), email: String(user.email || 'system') };
}

// List available tools (MCP-style discovery)
router.get('/tools', async (_req, res) => {
  try { res.json({ tools: getToolsSpec() }); } catch (e) { res.status(500).json({ message: 'error', error: e.message }); }
});

// MCP config
router.get('/config', async (_req, res) => {
  try {
    const cfg = (await McpConfig.findOne({ name: 'default' }).lean()) || { name: 'default', enabled_tools: [] };
    res.json(cfg);
  } catch (e) { res.status(500).json({ message: 'error', error: e.message }); }
});
router.put('/config', async (req, res) => {
  try {
    const enabled = Array.isArray(req.body?.enabled_tools) ? req.body.enabled_tools.map(String) : [];
    const cfg = await McpConfig.findOneAndUpdate({ name: 'default' }, { $set: { enabled_tools: enabled } }, { upsert: true, new: true });
    res.json(cfg);
  } catch (e) { res.status(500).json({ message: 'error', error: e.message }); }
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
