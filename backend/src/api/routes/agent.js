const express = require('express');
const router = express.Router();
const { getSettings, setSettings } = require('../../config/agentSettings');

router.get('/settings', (req, res) => {
  res.json(getSettings());
});

router.post('/settings', (req, res) => {
  const { instructions, voice } = req.body || {};
  setSettings({ instructions, voice });
  res.json(getSettings());
});

module.exports = router;

