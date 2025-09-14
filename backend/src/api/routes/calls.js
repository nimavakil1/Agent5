
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { createOutboundCall } = require('../services/callService');
const { createPrefilledCartLink } = require('../services/shopifyService');
const { sendEmail } = require('../services/brevoService');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CallLogEntry = require('../../models/CallLogEntry');

// Optional API key middleware for creating outbound calls
function requireCreateCallsApiKey(req, res, next) {
  const required = process.env.CREATE_CALLS_API_KEY;
  if (!required) return next();
  const key = req.header('x-api-key');
  if (key && key === required) return next();
  return res.status(401).json({ message: 'Unauthorized' });
}

const createCallLimiter = rateLimit({
  windowMs: parseInt(process.env.CREATE_CALLS_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.CREATE_CALLS_MAX || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/outbound', requireCreateCallsApiKey, createCallLimiter, async (req, res) => {
  const { to, campaign_id, customer_name } = req.body;

  if (!to) {
    return res.status(400).json({ message: '"to" phone number is required' });
  }

  try {
    const result = await createOutboundCall(to, { campaign_id, customer_name });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create outbound call', error: error.message });
  }
});

router.post('/shopify-cart', async (req, res) => {
  const { products } = req.body; // products should be an array of { variant_id, quantity }

  if (!products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ message: 'Products array is required' });
  }

  try {
    const cartLink = await createPrefilledCartLink(products);
    res.json({ cart_link: cartLink });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create Shopify cart link', error: error.message });
  }
});

router.post('/send-checkout-link', async (req, res) => {
  const { toEmail, checkoutLink } = req.body;

  if (!toEmail || !checkoutLink) {
    return res.status(400).json({ message: 'Recipient email and checkout link are required' });
  }

  try {
    await sendEmail(toEmail, 'Your Checkout Link', `Please complete your purchase: <a href="${checkoutLink}">${checkoutLink}</a>`);
    res.json({ message: 'Checkout link sent successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to send checkout link', error: error.message });
  }
});

router.get('/log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const callLogs = await CallLogEntry.find()
      .sort({ start_time: -1 })
      .limit(limit)
      .lean();
    
    res.json(callLogs);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch call logs', error: error.message });
  }
});

module.exports = router;

// Diagnostics: recent recordings vs call logs
router.get('/recordings/diagnostics', async (req, res) => {
  try {
    const limit = Number(req.query.limit || '50');
    const calls = await CallLogEntry.find({}).sort({ start_time: -1 }).limit(Math.max(1, Math.min(200, limit))).lean();
    const base = path.join(__dirname, '..', '..', 'recordings');
    const out = [];
    for (const c of calls) {
      const url = c.audio_recording_url || '';
      let exists = false, size = 0, mtime = 0, fullPath='';
      if (url && url.startsWith('/recordings/')) {
        fullPath = path.join(base, url.replace(/^\/recordings\//, ''));
        try { const st = fs.statSync(fullPath); exists = st.isFile(); size = st.size; mtime = st.mtimeMs; } catch(_) {}
      }
      out.push({ call_id: c.call_id, start_time: c.start_time, audio_recording_url: url, exists, size, mtime, full_path: exists?fullPath:'' });
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ message: 'error', error: e.message });
  }
});

// Signed recording URL generator (requires session)
router.get('/recordings/sign', async (req, res) => {
  try {
    const raw = String(req.query.u || '');
    let u = raw;
    // Accept absolute URLs and extract pathname
    try {
      if (/^https?:\/\//i.test(raw)) {
        const parsed = new URL(raw);
        u = parsed.pathname; // only path should be signed
      }
    } catch(_) {}
    if (!u.startsWith('/recordings/')) return res.status(400).json({ message:'bad url' });
    const ts = Date.now();
    const secret = process.env.RECORDINGS_SIGNING_SECRET || process.env.AUTH_TOKEN || 'dev-secret';
    const sig = crypto.createHmac('sha256', secret).update(u+'|'+ts).digest('hex');
    const url = `/recordings-signed?u=${encodeURIComponent(u)}&ts=${ts}&sig=${sig}`;
    res.json({ url, ts, sig });
  } catch (e) { res.status(500).json({ message:'error' }); }
});
