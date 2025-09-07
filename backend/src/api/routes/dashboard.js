
const express = require('express');
const router = express.Router();
const { getDashboardKpis } = require('../services/dashboardService');

router.get('/', async (req, res) => {
  try {
    const kpis = await getDashboardKpis();
    res.json(kpis);
  } catch (error) {
    res.status(500).json({ message: 'Failed to get dashboard KPIs', error: error.message });
  }
});

router.get('/kpi', async (req, res) => {
  try {
    const kpis = await getDashboardKpis();
    res.json(kpis);
  } catch (error) {
    res.status(500).json({ message: 'Failed to get dashboard KPIs', error: error.message });
  }
});

module.exports = router;
