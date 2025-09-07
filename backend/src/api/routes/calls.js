
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { createOutboundCall } = require('../services/callService');
const { createPrefilledCartLink } = require('../services/shopifyService');
const { sendEmail } = require('../services/brevoService');
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
