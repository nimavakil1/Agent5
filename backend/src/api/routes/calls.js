
const express = require('express');
const router = express.Router();
const { createOutboundCall } = require('../services/callService');
const { createPrefilledCartLink } = require('../services/shopifyService');
const { sendEmail } = require('../services/brevoService');

router.post('/outbound', async (req, res) => {
  const { to } = req.body;

  if (!to) {
    return res.status(400).json({ message: '"to" phone number is required' });
  }

  try {
    const result = await createOutboundCall(to);
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

module.exports = router;
