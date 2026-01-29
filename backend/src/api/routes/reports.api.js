/**
 * Reports API Routes
 *
 * Endpoints for generating and managing reports.
 *
 * @module reports.api
 */

const express = require('express');
const router = express.Router();

/**
 * POST /api/reports/pricing/generate
 * Manually trigger the weekly pricing report
 * Allows localhost calls without session for internal triggering
 */
router.post('/pricing/generate', async (req, res) => {
  // Allow internal calls from localhost without session
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  if (!isLocalhost && !req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    console.log('[ReportsAPI] Manual pricing report triggered');

    const { runWeeklyPricingReport } = require('../../services/reports/WeeklyPricingReportService');
    const result = await runWeeklyPricingReport();

    if (result.success) {
      res.json({
        success: true,
        message: 'Pricing report generated successfully',
        productsCount: result.productsCount,
        bolOffersCount: result.bolOffersCount,
        amazonMarketplaces: result.amazonMarketplaces,
        excelUrl: result.excelUrl,
        teamsNotified: result.teamsNotified
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Report generation failed'
      });
    }
  } catch (error) {
    console.error('[ReportsAPI] Pricing report error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/reports/pricing/status
 * Get status of the pricing report configuration
 */
router.get('/pricing/status', async (req, res) => {
  // Require session for status endpoint (no localhost bypass needed)
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const webhookConfigured = !!process.env.TEAMS_PRICING_REPORT_WEBHOOK_URL;
    const bolConfigured = !!(process.env.BOL_CLIENT_ID && process.env.BOL_CLIENT_SECRET);
    const amazonConfigured = !!process.env.AMAZON_SELLER_REFRESH_TOKEN;

    res.json({
      success: true,
      configuration: {
        teamsWebhook: webhookConfigured,
        bolCredentials: bolConfigured,
        amazonCredentials: amazonConfigured
      },
      schedule: 'Sunday 20:00 (Europe/Amsterdam)',
      targetMarketplaces: {
        bol: 'Bol.com',
        amazon: ['DE', 'FR', 'NL', 'BE']
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
