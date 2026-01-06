/**
 * Bol.com Advertising API Integration
 *
 * Manages Bol.com Sponsored Products campaigns.
 * Uses the new Advertising API V11 (launched April 2024).
 *
 * IMPORTANT v11 ENDPOINT STRUCTURE:
 * - Base URL: /advertiser/sponsored-products/campaign-management
 * - List endpoints use POST with /list suffix (e.g., POST /campaigns/list)
 * - Create endpoints use POST (e.g., POST /campaigns)
 * - Update endpoints use PUT (e.g., PUT /campaigns)
 * - Requires separate advertiser credentials (BOL_ADVERTISER_ID, BOL_ADVERTISER_SECRET)
 *
 * Features:
 * - Campaign management (create, update, pause)
 * - Ad group management
 * - Targeting (automatic and manual)
 * - Bid management
 * - Performance reporting
 *
 * @see https://api.bol.com/advertiser/docs/redoc/sponsored-products/v11/campaign-management.html
 * @see https://developers.bol.com/en/docs/new-advertising-api-everything-you-want-to-know/
 *
 * @module BolAds
 */

const https = require('https');

/**
 * Bol.com Ads API Endpoints
 * NOTE: As of v11, Advertising API uses /advertiser/ base path (NOT /retailer/)
 */
const BOL_ADS_ENDPOINTS = {
  auth: 'login.bol.com',
  api: 'api.bol.com'
};

/**
 * Campaign Status
 */
const CAMPAIGN_STATUS = {
  ENABLED: 'ENABLED',
  PAUSED: 'PAUSED',
  ENDED: 'ENDED'
};

/**
 * Targeting Type
 */
const TARGETING_TYPE = {
  AUTOMATIC: 'AUTOMATIC', // Bol.com AI matches products to queries
  MANUAL: 'MANUAL'        // You specify keywords/products
};

/**
 * Ad Status
 */
const AD_STATUS = {
  ENABLED: 'ENABLED',
  PAUSED: 'PAUSED',
  REJECTED: 'REJECTED',
  PENDING_REVIEW: 'PENDING_REVIEW'
};

/**
 * Bol.com Advertising API Client
 *
 * Uses the same OAuth 2.0 client credentials as Retailer API.
 */
class BolAdsClient {
  constructor(config = {}) {
    // Advertising API requires advertiser-specific credentials
    // Fall back to retailer credentials for backwards compatibility
    this.clientId = config.clientId || process.env.BOL_ADVERTISER_ID || process.env.BOL_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.BOL_ADVERTISER_SECRET || process.env.BOL_CLIENT_SECRET;

    this.accessToken = null;
    this.tokenExpiry = null;

    if (!this.clientId || !this.clientSecret) {
      console.warn('Bol.com Advertiser credentials not configured. Set BOL_ADVERTISER_ID and BOL_ADVERTISER_SECRET.');
    }
  }

  /**
   * Authenticate and get access token
   */
  async authenticate() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: BOL_ADS_ENDPOINTS.auth,
        port: 443,
        path: '/token?grant_type=client_credentials',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.access_token) {
              this.accessToken = response.access_token;
              this.tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;
              resolve(this.accessToken);
            } else {
              reject(new Error(`Bol.com auth failed: ${data}`));
            }
          } catch (e) {
            reject(new Error(`Bol.com auth parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Make authenticated API request
   * NOTE: v11 uses /advertiser/ base path and advertiser content types
   */
  async request(method, path, body = null, apiVersion = 'v11') {
    await this.authenticate();

    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Accept': `application/vnd.advertiser.${apiVersion}+json`,
      'Content-Type': `application/vnd.advertiser.${apiVersion}+json`
    };

    const payload = body ? JSON.stringify(body) : '';

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: BOL_ADS_ENDPOINTS.api,
        port: 443,
        path: `/advertiser${path}`,
        method: method,
        headers: headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (!data || data.trim() === '') {
              resolve({ success: true, statusCode: res.statusCode });
              return;
            }

            const response = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              reject(new Error(`Bol.com Ads API Error ${res.statusCode}: ${JSON.stringify(response)}`));
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ raw: data, statusCode: res.statusCode });
            } else {
              reject(new Error(`Bol.com Ads Parse error: ${e.message}, Data: ${data}`));
            }
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Make authenticated GET request with query parameters
   * Used for Reporting API which uses GET + query params (not POST + JSON body)
   */
  async requestGet(path, queryParams = {}, apiVersion = 'v11') {
    await this.authenticate();

    // Build query string
    const queryParts = [];
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          // Handle array params (e.g., entity-ids=1&entity-ids=2)
          for (const v of value) {
            queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
          }
        } else {
          queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
      }
    }
    const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Accept': `application/vnd.advertiser.${apiVersion}+json`
    };

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: BOL_ADS_ENDPOINTS.api,
        port: 443,
        path: `/advertiser${path}${queryString}`,
        method: 'GET',
        headers: headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (!data || data.trim() === '') {
              resolve({ success: true, statusCode: res.statusCode });
              return;
            }

            const response = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              reject(new Error(`Bol.com Ads API Error ${res.statusCode}: ${JSON.stringify(response)}`));
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ raw: data, statusCode: res.statusCode });
            } else {
              reject(new Error(`Bol.com Ads Parse error: ${e.message}, Data: ${data}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  // ==================== CAMPAIGNS ====================

  /**
   * List all campaigns
   * v11: POST /sponsored-products/campaign-management/campaigns/list
   */
  async listCampaigns(params = {}) {
    const filterBody = {
      page: params.page || 1,
      size: params.pageSize || params.size || 50  // v11 uses 'size' not 'pageSize'
    };

    if (params.campaignIds) {
      filterBody.campaignIds = Array.isArray(params.campaignIds) ? params.campaignIds : [params.campaignIds];
    }

    const result = await this.request('POST', '/sponsored-products/campaign-management/campaigns/list', filterBody);

    // Filter by state client-side if requested
    if (params.status && result.campaigns) {
      result.campaigns = result.campaigns.filter(c => c.state === params.status);
    }

    return result;
  }

  /**
   * Get campaign by ID
   * v11: POST /sponsored-products/campaign-management/campaigns/list with campaignIds filter
   */
  async getCampaign(campaignId) {
    const result = await this.request('POST', '/sponsored-products/campaign-management/campaigns/list', {
      campaignIds: [campaignId],
      page: 1,
      size: 1
    });
    return result.campaigns?.[0] || null;
  }

  /**
   * Create campaign
   * v11: POST /sponsored-products/campaign-management/campaigns
   */
  async createCampaign(campaign) {
    return this.request('POST', '/sponsored-products/campaign-management/campaigns', [{
      name: campaign.name,
      dailyBudget: campaign.dailyBudget,
      totalBudget: campaign.totalBudget,
      campaignType: campaign.campaignType || 'AUTO', // AUTO or MANUAL
      state: campaign.state || CAMPAIGN_STATUS.ENABLED,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      targetCountries: campaign.targetCountries || ['NL', 'BE'],
      targetChannels: campaign.targetChannels || ['DESKTOP', 'MOBILE', 'TABLET', 'APP'],
      acosTargetPercentage: campaign.acosTargetPercentage
    }]);
  }

  /**
   * Update campaign
   * v11: PUT /sponsored-products/campaign-management/campaigns
   */
  async updateCampaign(campaignId, updates) {
    return this.request('PUT', '/sponsored-products/campaign-management/campaigns', [{
      campaignId,
      ...updates
    }]);
  }

  /**
   * Pause campaign
   * NOTE: v11 uses 'state' field not 'status'
   */
  async pauseCampaign(campaignId) {
    return this.updateCampaign(campaignId, { state: CAMPAIGN_STATUS.PAUSED });
  }

  /**
   * Enable campaign
   * NOTE: v11 uses 'state' field not 'status'
   */
  async enableCampaign(campaignId) {
    return this.updateCampaign(campaignId, { state: CAMPAIGN_STATUS.ENABLED });
  }

  /**
   * Update campaign budget
   */
  async updateCampaignBudget(campaignId, dailyBudget) {
    return this.updateCampaign(campaignId, { dailyBudget });
  }

  // ==================== ADS ====================

  /**
   * List ads in campaign
   * v11: POST /sponsored-products/campaign-management/ads/list
   */
  async listAds(campaignId, params = {}) {
    const filterBody = {
      campaignIds: [campaignId],
      page: params.page || 1,
      size: params.pageSize || params.size || 50  // v11 uses 'size' not 'pageSize'
    };

    const result = await this.request('POST', '/sponsored-products/campaign-management/ads/list', filterBody);

    // Filter by state if requested
    if (params.status && result.ads) {
      result.ads = result.ads.filter(a => a.state === params.status);
    }

    return result;
  }

  /**
   * Get ad by ID
   * v11: POST /sponsored-products/campaign-management/ads/list with adIds filter
   */
  async getAd(campaignId, adId) {
    const result = await this.request('POST', '/sponsored-products/campaign-management/ads/list', {
      adIds: [adId],
      page: 1,
      size: 1
    });
    return result.ads?.[0] || null;
  }

  /**
   * Create ad (add product to campaign)
   * v11: POST /sponsored-products/campaign-management/ads
   */
  async createAd(campaignId, ad) {
    return this.request('POST', '/sponsored-products/campaign-management/ads', [{
      adGroupId: ad.adGroupId,
      ean: ad.ean,
      state: ad.state || AD_STATUS.ENABLED
    }]);
  }

  /**
   * Create multiple ads (bulk)
   * v11: POST /sponsored-products/campaign-management/ads (supports up to 100 ads per request)
   */
  async createAdsBulk(campaignId, ads) {
    return this.request('POST', '/sponsored-products/campaign-management/ads',
      ads.map(ad => ({
        adGroupId: ad.adGroupId,
        ean: ad.ean,
        state: ad.state || AD_STATUS.ENABLED
      }))
    );
  }

  /**
   * Update ad
   * v11: PUT /sponsored-products/campaign-management/ads
   */
  async updateAd(campaignId, adId, updates) {
    return this.request('PUT', '/sponsored-products/campaign-management/ads', [{
      adId,
      ...updates
    }]);
  }

  /**
   * Update ad bid - not directly supported in v11
   * Bids are managed at ad group or keyword level
   */
  async updateAdBid(_campaignId, _adId, _bid) {
    console.warn('updateAdBid: In v11, bids are managed at ad group or keyword level');
    return { warning: 'Bids are managed at ad group or keyword level in v11' };
  }

  /**
   * Pause ad
   * NOTE: v11 uses 'state' field not 'status'
   */
  async pauseAd(campaignId, adId) {
    return this.updateAd(campaignId, adId, { state: AD_STATUS.PAUSED });
  }

  /**
   * Enable ad
   * NOTE: v11 uses 'state' field not 'status'
   */
  async enableAd(campaignId, adId) {
    return this.updateAd(campaignId, adId, { state: AD_STATUS.ENABLED });
  }

  /**
   * Delete ad - v11 may use archive state instead
   */
  async deleteAd(campaignId, adId) {
    // v11 might not support DELETE, use archive state instead
    return this.updateAd(campaignId, adId, { state: 'ARCHIVED' });
  }

  // ==================== TARGETING (Manual Campaigns) ====================

  /**
   * List targeting keywords
   * v11: POST /sponsored-products/campaign-management/keywords/list
   */
  async listTargetingKeywords(adGroupId, params = {}) {
    const filterBody = {
      adGroupIds: [adGroupId],
      page: params.page || 1,
      size: params.pageSize || params.size || 50  // v11 uses 'size' not 'pageSize'
    };
    return this.request('POST', '/sponsored-products/campaign-management/keywords/list', filterBody);
  }

  /**
   * Add targeting keyword
   * v11: POST /sponsored-products/campaign-management/keywords
   */
  async addTargetingKeyword(adGroupId, keyword) {
    return this.request('POST', '/sponsored-products/campaign-management/keywords', [{
      adGroupId,
      keywordText: keyword.text,
      matchType: keyword.matchType || 'BROAD', // BROAD, PHRASE, EXACT
      bid: keyword.bid,
      state: 'ENABLED'
    }]);
  }

  /**
   * Update targeting keyword bid
   * v11: PUT /sponsored-products/campaign-management/keywords
   */
  async updateTargetingKeywordBid(keywordId, bid) {
    return this.request('PUT', '/sponsored-products/campaign-management/keywords', [{
      keywordId,
      bid
    }]);
  }

  /**
   * Delete targeting keyword - use archived state
   * v11: PUT /sponsored-products/campaign-management/keywords
   */
  async deleteTargetingKeyword(keywordId) {
    return this.request('PUT', '/sponsored-products/campaign-management/keywords', [{
      keywordId,
      state: 'ARCHIVED'
    }]);
  }

  /**
   * List negative keywords
   * v11: POST /sponsored-products/campaign-management/negative-keywords/list
   */
  async listNegativeKeywords(adGroupId) {
    return this.request('POST', '/sponsored-products/campaign-management/negative-keywords/list', {
      adGroupIds: [adGroupId],
      page: 1,
      size: 100
    });
  }

  /**
   * Add negative keyword
   * v11: POST /sponsored-products/campaign-management/negative-keywords
   */
  async addNegativeKeyword(adGroupId, keyword) {
    return this.request('POST', '/sponsored-products/campaign-management/negative-keywords', [{
      adGroupId,
      keywordText: keyword
    }]);
  }

  // ==================== REPORTING ====================
  // Reporting API uses GET with query parameters (not POST with JSON body!)
  // Base path: /sponsored-products/reporting
  // @see https://api.bol.com/advertiser/docs/redoc/sponsored-products/v11/reporting.html

  /**
   * Helper to get default date range (last 7 days)
   */
  _getDefaultDateRange() {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return { startDate, endDate };
  }

  /**
   * Get advertiser-level performance report (account totals)
   * GET /sponsored-products/reporting/performance/advertiser
   *
   * @param {Object} params - Optional parameters
   * @param {string} params.startDate - Start date (YYYY-MM-DD), default: 7 days ago
   * @param {string} params.endDate - End date (YYYY-MM-DD), default: today
   * @returns {Object} Performance metrics (impressions, clicks, ctr, cost, sales14d, acos14d, roas14d, etc.)
   */
  async getAdvertiserReport(params = {}) {
    const { startDate, endDate } = { ...this._getDefaultDateRange(), ...params };

    return this.requestGet('/sponsored-products/reporting/performance/advertiser', {
      'period-start-date': startDate,
      'period-end-date': endDate
    });
  }

  /**
   * Get performance report for specific entities (campaigns, ad groups, ads, keywords)
   * GET /sponsored-products/reporting/performance
   *
   * @param {string} entityType - Entity type: CAMPAIGN, AD_GROUP, AD, KEYWORD, TARGET_CATEGORY, TARGET_PRODUCT
   * @param {string[]} entityIds - Array of entity IDs
   * @param {Object} params - Optional parameters
   * @param {string} params.startDate - Start date (YYYY-MM-DD)
   * @param {string} params.endDate - End date (YYYY-MM-DD)
   * @returns {Object} Performance metrics with total and subTotals per entity
   */
  async getPerformanceReport(entityType, entityIds, params = {}) {
    const { startDate, endDate } = { ...this._getDefaultDateRange(), ...params };

    return this.requestGet('/sponsored-products/reporting/performance', {
      'entity-type': entityType,
      'entity-ids': Array.isArray(entityIds) ? entityIds : [entityIds],
      'period-start-date': startDate,
      'period-end-date': endDate
    });
  }

  /**
   * Get campaign performance report
   * Convenience method wrapping getPerformanceReport for campaigns
   */
  async getCampaignReport(campaignId, params = {}) {
    return this.getPerformanceReport('CAMPAIGN', [campaignId], params);
  }

  /**
   * Get multiple campaigns performance report
   */
  async getCampaignsReport(campaignIds, params = {}) {
    return this.getPerformanceReport('CAMPAIGN', campaignIds, params);
  }

  /**
   * Get ad group performance report
   */
  async getAdGroupReport(adGroupId, params = {}) {
    return this.getPerformanceReport('AD_GROUP', [adGroupId], params);
  }

  /**
   * Get ad performance report
   */
  async getAdReport(adIds, params = {}) {
    return this.getPerformanceReport('AD', Array.isArray(adIds) ? adIds : [adIds], params);
  }

  /**
   * Get keyword performance report
   */
  async getKeywordReport(keywordIds, params = {}) {
    return this.getPerformanceReport('KEYWORD', Array.isArray(keywordIds) ? keywordIds : [keywordIds], params);
  }

  /**
   * Get target-page performance (SEARCH, CATEGORY, PDP breakdown)
   * GET /sponsored-products/reporting/performance/target-page
   *
   * @param {string[]} adGroupIds - Array of ad group IDs
   * @param {Object} params - Optional parameters
   */
  async getTargetPageReport(adGroupIds, params = {}) {
    const { startDate, endDate } = { ...this._getDefaultDateRange(), ...params };

    return this.requestGet('/sponsored-products/reporting/performance/target-page', {
      'ad-group-ids': Array.isArray(adGroupIds) ? adGroupIds : [adGroupIds],
      'period-start-date': startDate,
      'period-end-date': endDate
    });
  }

  /**
   * Get search term performance report
   * GET /sponsored-products/reporting/performance/search-term
   *
   * @param {string[]} adGroupIds - Array of ad group IDs
   * @param {Object} params - Optional parameters (startDate, endDate, page, pageSize)
   */
  async getSearchTermReport(adGroupIds, params = {}) {
    const { startDate, endDate } = { ...this._getDefaultDateRange(), ...params };

    return this.requestGet('/sponsored-products/reporting/performance/search-term', {
      'ad-group-ids': Array.isArray(adGroupIds) ? adGroupIds : [adGroupIds],
      'period-start-date': startDate,
      'period-end-date': endDate,
      'page': params.page,
      'page-size': params.pageSize
    });
  }

  /**
   * Get category performance report
   * GET /sponsored-products/reporting/performance/category
   *
   * @param {string[]} adGroupIds - Array of ad group IDs
   * @param {Object} params - Optional parameters (startDate, endDate, page, pageSize)
   */
  async getCategoryReport(adGroupIds, params = {}) {
    const { startDate, endDate } = { ...this._getDefaultDateRange(), ...params };

    return this.requestGet('/sponsored-products/reporting/performance/category', {
      'ad-group-ids': Array.isArray(adGroupIds) ? adGroupIds : [adGroupIds],
      'period-start-date': startDate,
      'period-end-date': endDate,
      'page': params.page,
      'page-size': params.pageSize
    });
  }

  /**
   * Get aggregated performance report (alias for getAdvertiserReport)
   * Kept for backwards compatibility
   */
  async getAggregatedReport(params = {}) {
    return this.getAdvertiserReport(params);
  }

  // ==================== UTILITY / ANALYTICS ====================

  /**
   * Get all campaigns with performance summary
   * NOTE: v11 uses 'state' field not 'status'
   */
  async getCampaignsSummary() {
    const campaigns = await this.listCampaigns();
    const campaignList = campaigns.campaigns || [];

    const summary = {
      totalCampaigns: campaignList.length,
      activeCampaigns: campaignList.filter(c => c.state === CAMPAIGN_STATUS.ENABLED).length,
      pausedCampaigns: campaignList.filter(c => c.state === CAMPAIGN_STATUS.PAUSED).length,
      totalDailyBudget: campaignList.reduce((sum, c) => sum + (c.dailyBudget?.amount || 0), 0),
      campaigns: campaignList.map(c => ({
        id: c.campaignId,
        name: c.name,
        state: c.state,
        campaignType: c.campaignType,
        dailyBudget: c.dailyBudget,
        totalBudget: c.totalBudget
      }))
    };

    return summary;
  }

  /**
   * Get campaign health analysis
   */
  async getCampaignHealth(campaignId, daysBack = 7) {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [campaign, report, ads] = await Promise.all([
      this.getCampaign(campaignId),
      this.getCampaignReport(campaignId, { startDate, endDate }),
      this.listAds(campaignId)
    ]);

    // New reporting API returns totals directly (not reportData array)
    // Structure: { total: { impressions, clicks, ctr, ... }, subTotals: [...] }
    const totals = report.total || report || {};

    const ctr = (totals.ctr || 0) * 100;
    const conversionRate = (totals.conversionRate14d || 0) * 100;
    const acos = (totals.acos14d || 0) * 100;
    const roas = totals.roas14d || 0;

    return {
      campaign: {
        id: campaign?.campaignId,
        name: campaign?.name,
        state: campaign?.state,
        dailyBudget: campaign?.dailyBudget,
        campaignType: campaign?.campaignType
      },
      period: {
        startDate,
        endDate,
        days: daysBack
      },
      metrics: {
        impressions: totals.impressions || 0,
        clicks: totals.clicks || 0,
        cost: (totals.cost || 0).toFixed(2),
        conversions: totals.conversions14d || 0,
        directConversions: totals.directConversions14d || 0,
        indirectConversions: totals.indirectConversions14d || 0,
        sales: (totals.sales14d || 0).toFixed(2),
        ctr: ctr.toFixed(2),
        conversionRate: conversionRate.toFixed(2),
        averageCpc: (totals.averageCpc || 0).toFixed(2),
        acos: acos > 0 ? acos.toFixed(1) : 'N/A',
        roas: roas.toFixed(2),
        averageWinningBid: totals.averageWinningBid || null
      },
      ads: {
        total: (ads.ads || []).length,
        enabled: (ads.ads || []).filter(a => a.state === AD_STATUS.ENABLED).length,
        paused: (ads.ads || []).filter(a => a.state === AD_STATUS.PAUSED).length
      },
      health: this._calculateHealthScore({
        impressions: totals.impressions || 0,
        clicks: totals.clicks || 0,
        cost: totals.cost || 0,
        conversions: totals.conversions14d || 0,
        revenue: totals.sales14d || 0
      }, campaign)
    };
  }

  /**
   * Calculate campaign health score
   */
  _calculateHealthScore(metrics, _campaign) {
    let score = 100;
    const issues = [];

    // Check CTR
    const ctr = metrics.impressions > 0 ? (metrics.clicks / metrics.impressions) * 100 : 0;
    if (ctr < 0.3) {
      score -= 20;
      issues.push('Low CTR - consider improving product listings or targeting');
    }

    // Check ACoS
    const acos = metrics.revenue > 0 ? (metrics.cost / metrics.revenue) * 100 : Infinity;
    if (acos > 30) {
      score -= 25;
      issues.push('High ACoS - consider reducing bids or pausing underperforming ads');
    }

    // Check impressions
    if (metrics.impressions < 100) {
      score -= 15;
      issues.push('Low impressions - consider increasing bids or budget');
    }

    // Check conversions
    if (metrics.clicks > 50 && metrics.conversions === 0) {
      score -= 20;
      issues.push('No conversions despite clicks - review product page and pricing');
    }

    return {
      score: Math.max(0, score),
      status: score >= 80 ? 'healthy' : score >= 50 ? 'needs_attention' : 'critical',
      issues
    };
  }

  /**
   * Get bid optimization recommendations
   */
  async getBidRecommendations(campaignId, targetACoS = 20) {
    const [ads, report] = await Promise.all([
      this.listAds(campaignId),
      this.getCampaignReport(campaignId, {
        startDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0]
      })
    ]);

    const recommendations = [];
    const adList = ads.ads || [];

    for (const ad of adList) {
      // Get ad-specific metrics from report if available
      const adMetrics = this._getAdMetricsFromReport(ad.adId, report);

      if (!adMetrics || adMetrics.impressions < 100) continue;

      const acos = adMetrics.revenue > 0 ? (adMetrics.cost / adMetrics.revenue) * 100 : Infinity;
      const ctr = adMetrics.impressions > 0 ? (adMetrics.clicks / adMetrics.impressions) * 100 : 0;

      let recommendation = null;

      if (acos > targetACoS * 1.5) {
        recommendation = {
          action: 'decrease_bid',
          reason: `ACoS (${acos.toFixed(1)}%) significantly above target (${targetACoS}%)`,
          suggestedBidChange: -15,
          currentBid: ad.bid,
          suggestedBid: ad.bid * 0.85
        };
      } else if (acos < targetACoS * 0.6 && adMetrics.impressions > 500) {
        recommendation = {
          action: 'increase_bid',
          reason: `ACoS (${acos.toFixed(1)}%) well below target - room for growth`,
          suggestedBidChange: 20,
          currentBid: ad.bid,
          suggestedBid: ad.bid * 1.2
        };
      } else if (ctr < 0.2 && adMetrics.impressions > 500) {
        recommendation = {
          action: 'review_listing',
          reason: `Low CTR (${ctr.toFixed(2)}%) - product listing may need improvement`,
          suggestedBidChange: 0,
          currentBid: ad.bid
        };
      } else if (adMetrics.clicks > 30 && adMetrics.conversions === 0) {
        recommendation = {
          action: 'pause_or_review',
          reason: 'No conversions despite clicks - check pricing/availability',
          suggestedBidChange: -50,
          currentBid: ad.bid
        };
      }

      if (recommendation) {
        recommendations.push({
          adId: ad.adId,
          ean: ad.ean,
          metrics: {
            impressions: adMetrics.impressions,
            clicks: adMetrics.clicks,
            cost: adMetrics.cost?.toFixed(2),
            revenue: adMetrics.revenue?.toFixed(2),
            acos: acos === Infinity ? 'N/A' : acos.toFixed(1),
            ctr: ctr.toFixed(2)
          },
          ...recommendation
        });
      }
    }

    return {
      campaignId,
      targetACoS,
      totalAds: adList.length,
      recommendations,
      summary: {
        decreaseBid: recommendations.filter(r => r.action === 'decrease_bid').length,
        increaseBid: recommendations.filter(r => r.action === 'increase_bid').length,
        reviewListing: recommendations.filter(r => r.action === 'review_listing').length,
        pauseOrReview: recommendations.filter(r => r.action === 'pause_or_review').length
      }
    };
  }

  /**
   * Extract ad metrics from campaign report (helper)
   */
  _getAdMetricsFromReport(adId, report) {
    // This would depend on actual report structure
    // Placeholder implementation
    return report.adMetrics?.[adId] || null;
  }
}

module.exports = {
  BolAdsClient,
  CAMPAIGN_STATUS,
  TARGETING_TYPE,
  AD_STATUS,
  BOL_ADS_ENDPOINTS
};
