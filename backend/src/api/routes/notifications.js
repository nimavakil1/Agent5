const express = require('express');
const router = express.Router();
const { sendEmail, sendWhatsAppTemplate } = require('../services/brevoService');

// POST /api/notifications/email
// Body: { to, subject, html, from?: { email, name } }
router.post('/email', async (req, res) => {
  const { to, subject, html, from } = req.body;
  if (!to || !subject || !html) {
    return res.status(400).json({ message: 'to, subject, html are required' });
  }
  try {
    const result = await sendEmail(to, subject, html, from);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(502).json({ message: 'Failed to send email', error: err.message });
  }
});

// POST /api/notifications/whatsapp/template
// Body: { to, template, languageCode?, components? }
router.post('/whatsapp/template', async (req, res) => {
  const { to, template, languageCode = 'en', components = [] } = req.body;
  if (!to || !template) {
    return res.status(400).json({ message: 'to and template are required' });
  }
  try {
    const result = await sendWhatsAppTemplate(to, template, languageCode, components);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(502).json({ message: 'Failed to send WhatsApp', error: err.message });
  }
});

module.exports = router;

