/**
 * Amazon Ads API Routes
 *
 * API endpoints for Amazon Advertising data:
 * - Profile management
 * - Campaign sync
 * - Performance data import
 * - Analytics/stats
 *
 * @module api/amazonads
 */

const express = require('express');
const router = express.Router();

// Lazy-load services
let adsClient = null;
let adsImporter = null;

async function getClient() {
  if (!adsClient) {
    const { AmazonAdsClient } = require('../../services/amazon/ads');
    adsClient = new AmazonAdsClient();
  }
  return adsClient;
}

async function getImporter() {
  if (!adsImporter) {
    const { getAmazonAdsImporter } = require('../../services/amazon/ads');
    adsImporter = await getAmazonAdsImporter();
  }
  return adsImporter;
}

// ==================== CONNECTION ====================

/**
 * @route POST /api/amazonads/test-connection
 * @desc Test Amazon Ads API connection
 */
router.post('/test-connection', async (req, res) => {
  try {
    const client = await getClient();
    const result = await client.testConnection();
    res.json(result);
  } catch (error) {
    console.error('[AmazonAdsAPI] Test connection error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== PROFILES ====================

/**
 * @route GET /api/amazonads/profiles
 * @desc List all advertising profiles
 */
router.get('/profiles', async (req, res) => {
  try {
    const client = await getClient();
    const profiles = await client.listProfiles();

    res.json({
      success: true,
      count: profiles.length,
      profiles: profiles.map(p => ({
        profileId: p.profileId,
        countryCode: p.countryCode,
        currencyCode: p.currencyCode,
        timezone: p.timezone,
        accountName: p.accountInfo?.name,
        accountType: p.accountInfo?.type,
        marketplaceId: p.accountInfo?.marketplaceStringId
      }))
    });
  } catch (error) {
    console.error('[AmazonAdsAPI] List profiles error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/amazonads/profiles/sync
 * @desc Sync profiles to MongoDB
 */
router.post('/profiles/sync', async (req, res) => {
  try {
    const importer = await getImporter();
    const result = await importer.syncProfiles();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AmazonAdsAPI] Sync profiles error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== CAMPAIGNS ====================

/**
 * @route GET /api/amazonads/campaigns/:profileId
 * @desc List campaigns for a profile
 */
router.get('/campaigns/:profileId', async (req, res) => {
  try {
    const client = await getClient();
    const campaigns = await client.listSpCampaigns(req.params.profileId, {
      count: parseInt(req.query.limit) || 100
    });

    res.json({
      success: true,
      count: campaigns.length,
      campaigns
    });
  } catch (error) {
    console.error('[AmazonAdsAPI] List campaigns error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/amazonads/campaigns/:profileId/sync
 * @desc Sync campaigns to MongoDB
 */
router.post('/campaigns/:profileId/sync', async (req, res) => {
  try {
    const importer = await getImporter();
    const result = await importer.syncCampaigns(req.params.profileId);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AmazonAdsAPI] Sync campaigns error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== PERFORMANCE DATA ====================

/**
 * @route POST /api/amazonads/performance/:profileId/import
 * @desc Import performance data for a date range
 * @body startDate - Start date (YYYYMMDD)
 * @body endDate - End date (YYYYMMDD, optional - defaults to startDate)
 */
router.post('/performance/:profileId/import', async (req, res) => {
  try {
    const { startDate, endDate } = req.body;

    if (!startDate) {
      return res.status(400).json({ success: false, error: 'startDate is required (YYYYMMDD format)' });
    }

    const importer = await getImporter();
    const result = await importer.importPerformance(
      req.params.profileId,
      startDate,
      endDate || startDate
    );

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AmazonAdsAPI] Import performance error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/amazonads/performance/:profileId/stats
 * @desc Get aggregated stats for a date range
 * @query startDate - Start date (YYYYMMDD)
 * @query endDate - End date (YYYYMMDD)
 */
router.get('/performance/:profileId/stats', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'startDate and endDate are required' });
    }

    const importer = await getImporter();
    const stats = await importer.getStats(req.params.profileId, startDate, endDate);

    res.json({ success: true, stats });
  } catch (error) {
    console.error('[AmazonAdsAPI] Get stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/amazonads/performance/:profileId/trend
 * @desc Get daily performance trend
 * @query startDate - Start date (YYYYMMDD)
 * @query endDate - End date (YYYYMMDD)
 */
router.get('/performance/:profileId/trend', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'startDate and endDate are required' });
    }

    const importer = await getImporter();
    const trend = await importer.getDailyTrend(req.params.profileId, startDate, endDate);

    res.json({ success: true, trend });
  } catch (error) {
    console.error('[AmazonAdsAPI] Get trend error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/amazonads/performance/:profileId/top-campaigns
 * @desc Get top campaigns by spend
 * @query startDate - Start date (YYYYMMDD)
 * @query endDate - End date (YYYYMMDD)
 * @query limit - Number of campaigns (default 10)
 */
router.get('/performance/:profileId/top-campaigns', async (req, res) => {
  try {
    const { startDate, endDate, limit } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'startDate and endDate are required' });
    }

    const importer = await getImporter();
    const campaigns = await importer.getTopCampaignsBySpend(
      req.params.profileId,
      startDate,
      endDate,
      parseInt(limit) || 10
    );

    res.json({ success: true, campaigns });
  } catch (error) {
    console.error('[AmazonAdsAPI] Get top campaigns error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== KEYWORDS & SEARCH TERMS ====================

/**
 * @route POST /api/amazonads/keywords/:profileId/import
 * @desc Import keyword performance data
 * @body date - Date (YYYYMMDD)
 */
router.post('/keywords/:profileId/import', async (req, res) => {
  try {
    const { date } = req.body;

    if (!date) {
      return res.status(400).json({ success: false, error: 'date is required (YYYYMMDD format)' });
    }

    const importer = await getImporter();
    const result = await importer.importKeywordPerformance(req.params.profileId, date);

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AmazonAdsAPI] Import keywords error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/amazonads/search-terms/:profileId/import
 * @desc Import search term report
 * @body date - Date (YYYYMMDD)
 */
router.post('/search-terms/:profileId/import', async (req, res) => {
  try {
    const { date } = req.body;

    if (!date) {
      return res.status(400).json({ success: false, error: 'date is required (YYYYMMDD format)' });
    }

    const importer = await getImporter();
    const result = await importer.importSearchTerms(req.params.profileId, date);

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AmazonAdsAPI] Import search terms error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== REPORTS (DIRECT) ====================

/**
 * @route POST /api/amazonads/reports/:profileId/request
 * @desc Request a report directly from Amazon
 * @body recordType - Type: campaigns, adGroups, keywords, targets, productAds, searchTerm
 * @body date - Date (YYYYMMDD)
 * @body metrics - Comma-separated metrics (optional)
 */
router.post('/reports/:profileId/request', async (req, res) => {
  try {
    const { recordType, date, metrics } = req.body;

    if (!recordType || !date) {
      return res.status(400).json({ success: false, error: 'recordType and date are required' });
    }

    const client = await getClient();
    const report = await client.getReport(req.params.profileId, recordType, {
      reportDate: date,
      metrics: metrics || undefined
    });

    res.json({
      success: true,
      recordType,
      date,
      recordCount: report.length,
      data: report
    });
  } catch (error) {
    console.error('[AmazonAdsAPI] Request report error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
