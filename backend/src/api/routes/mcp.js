const express = require('express');
const router = express.Router();
const AuditLog = require('../../models/AuditLog');
const CustomerRecord = require('../../models/CustomerRecord');
const ScheduledJob = require('../../models/ScheduledJob');

function who(req) {
  const user = req.user || {};
  return { id: String(user._id || user.id || ''), email: String(user.email || 'system') };
}

// List available tools (MCP-style discovery)
router.get('/tools', async (_req, res) => {
  res.json({
    tools: [
      {
        name: 'schedule_callback',
        description: 'Schedule a callback in a time window for a prospect/customer',
        input_schema: {
          type: 'object',
          required: ['to'],
          properties: {
            to: { type: 'string', description: 'E.164 phone number to call' },
            window_start: { type: 'string', description: 'ISO datetime when window starts (optional if due_at provided)' },
            window_end: { type: 'string', description: 'ISO datetime when window ends (optional)' },
            due_at: { type: 'string', description: 'ISO datetime when to attempt first call' },
            campaign_id: { type: 'string' },
            customer_name: { type: 'string' },
            notes: { type: 'string' },
          },
        },
      },
      {
        name: 'update_customer_profile',
        description: 'Update customer invoice details (address, VAT, language) safely with audit log',
        input_schema: {
          type: 'object',
          properties: {
            customer_id: { type: 'string' },
            phone: { type: 'string' },
            invoice: {
              type: 'object',
              properties: {
                name: { type: 'string' }, company: { type: 'string' }, vat: { type: 'string' },
                address: { type: 'string' }, city: { type: 'string' }, postal_code: { type: 'string' }, country: { type: 'string' },
                email: { type: 'string' }, phone: { type: 'string' }, mobile: { type: 'string' },
                language: { type: 'string' }, language_confirmed: { type: 'boolean' },
              },
            },
          },
        },
      },
    ],
  });
});

// Call a tool by name
router.post('/call', async (req, res) => {
  const { name, params, idempotency_key } = req.body || {};
  const { id, email } = who(req);
  try {
    if (name === 'schedule_callback') {
      const to = String(params?.to || '').trim();
      if (!to) return res.status(400).json({ message: 'to is required' });
      const dueAt = params?.due_at ? new Date(params.due_at) : new Date();
      const payload = {
        to,
        campaign_id: params?.campaign_id || '',
        customer_name: params?.customer_name || '',
        notes: params?.notes || '',
        window_start: params?.window_start || null,
        window_end: params?.window_end || null,
        idem: idempotency_key || '',
      };
      const job = await ScheduledJob.create({ type: 'callback', run_at: dueAt, payload });
      try { await AuditLog.create({ user_id: id, user_email: email, action: 'mcp.schedule_callback', resource: 'ScheduledJob', resource_id: job._id, details: payload, success: true }); } catch(_) {}
      return res.json({ ok: true, job_id: job._id });
    }

    if (name === 'update_customer_profile') {
      const q = {};
      if (params?.customer_id) q._id = params.customer_id;
      if (!q._id && params?.phone) q['invoice.phone'] = params.phone;
      if (!q._id && !q['invoice.phone']) return res.status(400).json({ message: 'customer_id or phone required' });
      const updates = {};
      if (params?.invoice && typeof params.invoice === 'object') {
        for (const k of ['name','company','vat','address','city','postal_code','country','email','phone','mobile','language','language_confirmed']) {
          if (k in params.invoice) updates[`invoice.${k}`] = params.invoice[k];
        }
      }
      if (Object.keys(updates).length === 0) return res.status(400).json({ message: 'no updates provided' });
      const before = await CustomerRecord.findOne(q).lean();
      if (!before) return res.status(404).json({ message: 'customer not found' });
      const after = await CustomerRecord.findOneAndUpdate(q, { $set: updates }, { new: true });
      try { await AuditLog.create({ user_id: id, user_email: email, action: 'mcp.update_customer_profile', resource: 'CustomerRecord', resource_id: String(after._id), details: { updates, idem: idempotency_key || '' }, success: true }); } catch(_) {}
      return res.json({ ok: true, customer_id: after._id });
    }

    return res.status(404).json({ message: 'tool_not_found' });
  } catch (e) {
    try { await AuditLog.create({ user_id: id, user_email: email, action: `mcp.${name}`, resource: 'tool', details: { error: e.message, params }, success: false }); } catch(_) {}
    return res.status(500).json({ message: 'error', error: e.message });
  }
});

module.exports = router;

