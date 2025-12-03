/**
 * Bol.com Advertising API Integration
 *
 * Manages Bol.com Sponsored Products campaigns.
 * Uses the new Advertising API V11 (launched 2024).
 *
 * Features:
 * - Campaign management (create, update, pause)
 * - Ad group management
 * - Targeting (automatic and manual)
 * - Bid management
 * - Performance reporting
 *
 * @see https://api.bol.com/retailer/public/Retailer-API/v11/functional/advertising-api/aapi-overview.html
 * @see https://developers.bol.com/en/docs/new-advertising-api-everything-you-want-to-know/
 *
 * @module BolAds
 */

const https = require('https');

/**
 * Bol.com Ads API Endpoints
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
    this.clientId = config.clientId || process.env.BOL_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.BOL_CLIENT_SECRET;

    this.accessToken = null;
    this.tokenExpiry = null;

    if (!this.clientId || !this.clientSecret) {
      console.warn('Bol.com credentials not configured. Set BOL_CLIENT_ID and BOL_CLIENT_SECRET.');
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
   */
  async request(method, path, body = null, apiVersion = 'v11') {
    await this.authenticate();

    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Accept': `application/vnd.retailer.${apiVersion}+json`,
      'Content-Type': `application/vnd.retailer.${apiVersion}+json`
    };

    const payload = body ? JSON.stringify(body) : '';

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: BOL_ADS_ENDPOINTS.api,
        port: 443,
        path: `/retailer${path}`,
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

  // ==================== CAMPAIGNS ====================

  /**
   * List all campaigns
   */
  async listCampaigns(params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1,
      ...(params.status && { status: params.status })
    });
    return this.request('GET', `/advertising/campaigns?${query}`);
  }

  /**
   * Get campaign by ID
   */
  async getCampaign(campaignId) {
    return this.request('GET', `/advertising/campaigns/${campaignId}`);
  }

  /**
   * Create campaign
   */
  async createCampaign(campaign) {
    return this.request('POST', '/advertising/campaigns', {
      name: campaign.name,
      dailyBudget: campaign.dailyBudget,
      targetingType: campaign.targetingType || TARGETING_TYPE.AUTOMATIC,
      status: campaign.status || CAMPAIGN_STATUS.ENABLED,
      startDate: campaign.startDate,
      endDate: campaign.endDate
    });
  }

  /**
   * Update campaign
   */
  async updateCampaign(campaignId, updates) {
    return this.request('PUT', `/advertising/campaigns/${campaignId}`, updates);
  }

  /**
   * Pause campaign
   */
  async pauseCampaign(campaignId) {
    return this.updateCampaign(campaignId, { status: CAMPAIGN_STATUS.PAUSED });
  }

  /**
   * Enable campaign
   */
  async enableCampaign(campaignId) {
    return this.updateCampaign(campaignId, { status: CAMPAIGN_STATUS.ENABLED });
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
   */
  async listAds(campaignId, params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1,
      ...(params.status && { status: params.status })
    });
    return this.request('GET', `/advertising/campaigns/${campaignId}/ads?${query}`);
  }

  /**
   * Get ad by ID
   */
  async getAd(campaignId, adId) {
    return this.request('GET', `/advertising/campaigns/${campaignId}/ads/${adId}`);
  }

  /**
   * Create ad (add product to campaign)
   */
  async createAd(campaignId, ad) {
    return this.request('POST', `/advertising/campaigns/${campaignId}/ads`, {
      ean: ad.ean,
      bid: ad.bid,
      status: ad.status || AD_STATUS.ENABLED
    });
  }

  /**
   * Create multiple ads (bulk)
   */
  async createAdsBulk(campaignId, ads) {
    return this.request('POST', `/advertising/campaigns/${campaignId}/ads/bulk`, {
      ads: ads.map(ad => ({
        ean: ad.ean,
        bid: ad.bid,
        status: ad.status || AD_STATUS.ENABLED
      }))
    });
  }

  /**
   * Update ad
   */
  async updateAd(campaignId, adId, updates) {
    return this.request('PUT', `/advertising/campaigns/${campaignId}/ads/${adId}`, updates);
  }

  /**
   * Update ad bid
   */
  async updateAdBid(campaignId, adId, bid) {
    return this.updateAd(campaignId, adId, { bid });
  }

  /**
   * Pause ad
   */
  async pauseAd(campaignId, adId) {
    return this.updateAd(campaignId, adId, { status: AD_STATUS.PAUSED });
  }

  /**
   * Enable ad
   */
  async enableAd(campaignId, adId) {
    return this.updateAd(campaignId, adId, { status: AD_STATUS.ENABLED });
  }

  /**
   * Delete ad
   */
  async deleteAd(campaignId, adId) {
    return this.request('DELETE', `/advertising/campaigns/${campaignId}/ads/${adId}`);
  }

  // ==================== TARGETING (Manual Campaigns) ====================

  /**
   * List targeting keywords
   */
  async listTargetingKeywords(campaignId, params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1
    });
    return this.request('GET', `/advertising/campaigns/${campaignId}/targeting/keywords?${query}`);
  }

  /**
   * Add targeting keyword
   */
  async addTargetingKeyword(campaignId, keyword) {
    return this.request('POST', `/advertising/campaigns/${campaignId}/targeting/keywords`, {
      keyword: keyword.text,
      matchType: keyword.matchType || 'BROAD', // BROAD, PHRASE, EXACT
      bid: keyword.bid
    });
  }

  /**
   * Update targeting keyword bid
   */
  async updateTargetingKeywordBid(campaignId, keywordId, bid) {
    return this.request('PUT', `/advertising/campaigns/${campaignId}/targeting/keywords/${keywordId}`, {
      bid
    });
  }

  /**
   * Delete targeting keyword
   */
  async deleteTargetingKeyword(campaignId, keywordId) {
    return this.request('DELETE', `/advertising/campaigns/${campaignId}/targeting/keywords/${keywordId}`);
  }

  /**
   * List negative keywords
   */
  async listNegativeKeywords(campaignId) {
    return this.request('GET', `/advertising/campaigns/${campaignId}/targeting/negative-keywords`);
  }

  /**
   * Add negative keyword
   */
  async addNegativeKeyword(campaignId, keyword) {
    return this.request('POST', `/advertising/campaigns/${campaignId}/targeting/negative-keywords`, {
      keyword: keyword
    });
  }

  // ==================== REPORTING ====================

  /**
   * Get campaign performance report
   */
  async getCampaignReport(campaignId, params = {}) {
    const query = new URLSearchParams({
      ...(params.startDate && { 'start-date': params.startDate }),
      ...(params.endDate && { 'end-date': params.endDate }),
      granularity: params.granularity || 'DAILY' // DAILY, WEEKLY, MONTHLY
    });
    return this.request('GET', `/advertising/campaigns/${campaignId}/report?${query}`);
  }

  /**
   * Get ad performance report
   */
  async getAdReport(campaignId, adId, params = {}) {
    const query = new URLSearchParams({
      ...(params.startDate && { 'start-date': params.startDate }),
      ...(params.endDate && { 'end-date': params.endDate }),
      granularity: params.granularity || 'DAILY'
    });
    return this.request('GET', `/advertising/campaigns/${campaignId}/ads/${adId}/report?${query}`);
  }

  /**
   * Get aggregated performance report
   */
  async getAggregatedReport(params = {}) {
    const query = new URLSearchParams({
      ...(params.startDate && { 'start-date': params.startDate }),
      ...(params.endDate && { 'end-date': params.endDate }),
      granularity: params.granularity || 'DAILY'
    });
    return this.request('GET', `/advertising/report?${query}`);
  }

  // ==================== UTILITY / ANALYTICS ====================

  /**
   * Get all campaigns with performance summary
   */
  async getCampaignsSummary() {
    const campaigns = await this.listCampaigns();
    const campaignList = campaigns.campaigns || [];

    const summary = {
      totalCampaigns: campaignList.length,
      activeCampaigns: campaignList.filter(c => c.status === CAMPAIGN_STATUS.ENABLED).length,
      pausedCampaigns: campaignList.filter(c => c.status === CAMPAIGN_STATUS.PAUSED).length,
      totalDailyBudget: campaignList.reduce((sum, c) => sum + (c.dailyBudget || 0), 0),
      campaigns: campaignList.map(c => ({
        id: c.campaignId,
        name: c.name,
        status: c.status,
        dailyBudget: c.dailyBudget,
        targetingType: c.targetingType
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

    const reportData = report.reportData || [];
    const totals = reportData.reduce((acc, day) => ({
      impressions: (acc.impressions || 0) + (day.impressions || 0),
      clicks: (acc.clicks || 0) + (day.clicks || 0),
      cost: (acc.cost || 0) + (day.cost || 0),
      conversions: (acc.conversions || 0) + (day.conversions || 0),
      revenue: (acc.revenue || 0) + (day.revenue || 0)
    }), {});

    const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
    const conversionRate = totals.clicks > 0 ? (totals.conversions / totals.clicks) * 100 : 0;
    const acos = totals.revenue > 0 ? (totals.cost / totals.revenue) * 100 : Infinity;
    const roas = totals.cost > 0 ? totals.revenue / totals.cost : 0;

    return {
      campaign: {
        id: campaign.campaignId,
        name: campaign.name,
        status: campaign.status,
        dailyBudget: campaign.dailyBudget,
        targetingType: campaign.targetingType
      },
      period: {
        startDate,
        endDate,
        days: daysBack
      },
      metrics: {
        impressions: totals.impressions,
        clicks: totals.clicks,
        cost: totals.cost?.toFixed(2),
        conversions: totals.conversions,
        revenue: totals.revenue?.toFixed(2),
        ctr: ctr.toFixed(2),
        conversionRate: conversionRate.toFixed(2),
        acos: acos === Infinity ? 'N/A' : acos.toFixed(1),
        roas: roas.toFixed(2)
      },
      ads: {
        total: (ads.ads || []).length,
        enabled: (ads.ads || []).filter(a => a.status === AD_STATUS.ENABLED).length,
        paused: (ads.ads || []).filter(a => a.status === AD_STATUS.PAUSED).length
      },
      health: this._calculateHealthScore(totals, campaign)
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
