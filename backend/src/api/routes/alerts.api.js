/**
 * Alerts API Routes
 *
 * Endpoints for managing and sending alerts (Teams, Email, etc.)
 *
 * @module AlertsAPI
 */

const express = require('express');
const router = express.Router();
const { getLateOrdersAlertService } = require('../../services/alerts/LateOrdersAlertService');
const { getMarketplaceDashboardService } = require('../../services/alerts/MarketplaceDashboardService');

/**
 * GET /api/alerts/late-orders/status
 * Get current late orders status without sending alert
 */
router.get('/late-orders/status', async (req, res) => {
  try {
    const service = getLateOrdersAlertService();
    const status = await service.getStatus();
    res.json(status);
  } catch (error) {
    console.error('[Alerts API] Error getting late orders status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/alerts/late-orders/excel
 * Download Excel report of late orders
 */
router.get('/late-orders/excel', async (req, res) => {
  try {
    const service = getLateOrdersAlertService();
    const buffer = await service.getExcelReport();

    const filename = `Late_Orders_Report_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error('[Alerts API] Error generating Excel:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alerts/late-orders/send-to-channel
 * Send late orders alert to Teams channel via webhook
 *
 * Body:
 * - webhookUrl (optional): Override default webhook URL
 */
router.post('/late-orders/send-to-channel', async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    const service = getLateOrdersAlertService();
    const result = await service.sendToChannel(webhookUrl);
    res.json(result);
  } catch (error) {
    console.error('[Alerts API] Error sending to channel:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alerts/late-orders/send-to-users
 * Send late orders alert to individual users via MS Graph API
 *
 * Body:
 * - emails: Array of user email addresses
 */
router.post('/late-orders/send-to-users', async (req, res) => {
  try {
    const { emails } = req.body;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'emails array is required' });
    }

    const service = getLateOrdersAlertService();
    const result = await service.sendToUsers(emails);
    res.json(result);
  } catch (error) {
    console.error('[Alerts API] Error sending to users:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alerts/late-orders/send
 * Send late orders alert (supports both channel and users)
 *
 * Body:
 * - type: 'channel' | 'users' | 'both'
 * - webhookUrl (optional): Override default webhook URL for channel
 * - emails (required if type includes users): Array of user email addresses
 */
router.post('/late-orders/send', async (req, res) => {
  try {
    const { type = 'channel', webhookUrl, emails } = req.body;

    const service = getLateOrdersAlertService();
    const results = {};

    if (type === 'channel' || type === 'both') {
      try {
        results.channel = await service.sendToChannel(webhookUrl);
      } catch (e) {
        results.channel = { success: false, error: e.message };
      }
    }

    if (type === 'users' || type === 'both') {
      if (!emails || !Array.isArray(emails) || emails.length === 0) {
        results.users = { success: false, error: 'emails array required for user alerts' };
      } else {
        try {
          results.users = await service.sendToUsers(emails);
        } catch (e) {
          results.users = { success: false, error: e.message };
        }
      }
    }

    res.json({
      success: Object.values(results).some(r => r.success),
      results
    });
  } catch (error) {
    console.error('[Alerts API] Error sending alert:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/alerts/warehouse-display
 * Public endpoint for warehouse dashboard (no auth required)
 * Returns only the channel stats for display purposes
 */
router.get('/warehouse-display', async (req, res) => {
  try {
    const service = getLateOrdersAlertService();
    const status = await service.getStatus();

    // Return only what's needed for the display
    res.json({
      timestamp: new Date().toISOString(),
      channelStats: status.channelStats,
      totals: status.totals
    });
  } catch (error) {
    console.error('[Alerts API] Error getting warehouse display data:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/alerts/marketplace-display
 * Live marketplace data from Amazon SP-API and Bol.com API
 * Shows real-time pending orders as marketplaces see them
 */
router.get('/marketplace-display', async (req, res) => {
  try {
    const service = getMarketplaceDashboardService();
    const data = await service.getDashboardData();
    res.json(data);
  } catch (error) {
    console.error('[Alerts API] Error getting marketplace display data:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/alerts/config
 * Get current alert configuration status
 */
router.get('/config', async (req, res) => {
  res.json({
    teamsWebhook: {
      configured: !!(process.env.TEAMS_LATE_ORDERS_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL),
      url: process.env.TEAMS_LATE_ORDERS_WEBHOOK_URL ? '(late-orders specific)' :
           process.env.TEAMS_WEBHOOK_URL ? '(default)' : null
    },
    msGraph: {
      configured: !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET),
      tenantId: process.env.MS_TENANT_ID ? '***configured***' : null,
      defaultUserId: process.env.MS_USER_ID || null
    }
  });
});

module.exports = router;
