/**
 * Amazon Advertising API Integration
 *
 * Manages Amazon Sponsored Products, Sponsored Brands, and Sponsored Display campaigns.
 * Uses the @scaleleap/amazon-advertising-api-sdk package.
 *
 * Features:
 * - Campaign management (create, update, pause, archive)
 * - Ad group management
 * - Keyword and targeting management
 * - Bid optimization
 * - Performance reporting
 *
 * @see https://advertising.amazon.com/API/docs/en-us
 * @see https://github.com/ScaleLeap/amazon-advertising-api-sdk
 *
 * @module AmazonAds
 */

const {
  AmazonAdvertising,
  CampaignStateEnum,
  CampaignTypeEnum,
  AdGroupStateEnum,
  KeywordStateEnum,
  KeywordMatchTypeEnum
} = require('@scaleleap/amazon-advertising-api-sdk');

/**
 * Amazon Ads Regions
 */
const ADS_REGIONS = {
  NA: 'na', // North America
  EU: 'eu', // Europe
  FE: 'fe'  // Far East
};

/**
 * Campaign Types
 */
const CAMPAIGN_TYPE = {
  SPONSORED_PRODUCTS: 'sponsoredProducts',
  SPONSORED_BRANDS: 'sponsoredBrands',
  SPONSORED_DISPLAY: 'sponsoredDisplay'
};

/**
 * Targeting Types
 */
const TARGETING_TYPE = {
  MANUAL: 'manual',
  AUTO: 'auto'
};

/**
 * Match Types for Keywords
 */
const MATCH_TYPE = {
  EXACT: 'exact',
  PHRASE: 'phrase',
  BROAD: 'broad'
};

/**
 * Amazon Advertising API Client
 */
class AmazonAdsClient {
  constructor(config = {}) {
    this.clientId = config.clientId || process.env.AMAZON_ADS_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.AMAZON_ADS_CLIENT_SECRET;
    this.refreshToken = config.refreshToken || process.env.AMAZON_ADS_REFRESH_TOKEN;
    this.profileId = config.profileId || process.env.AMAZON_ADS_PROFILE_ID;
    this.region = config.region || process.env.AMAZON_ADS_REGION || ADS_REGIONS.EU;

    this.client = null;
  }

  /**
   * Initialize the Amazon Ads client
   */
  async init() {
    if (this.client) return this.client;

    try {
      this.client = new AmazonAdvertising({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: this.refreshToken,
        region: this.region
      });

      return this.client;
    } catch (error) {
      throw new Error(`Failed to initialize Amazon Ads client: ${error.message}`);
    }
  }

  /**
   * Get client (initializes if needed)
   */
  async getClient() {
    if (!this.client) {
      await this.init();
    }
    return this.client;
  }

  // ==================== PROFILES ====================

  /**
   * List advertising profiles
   */
  async listProfiles() {
    const client = await this.getClient();
    return client.profiles.listProfiles();
  }

  /**
   * Get profile by ID
   */
  async getProfile(profileId = this.profileId) {
    const client = await this.getClient();
    return client.profiles.getProfile(profileId);
  }

  // ==================== SPONSORED PRODUCTS - CAMPAIGNS ====================

  /**
   * List Sponsored Products campaigns
   */
  async listSPCampaigns(params = {}) {
    const client = await this.getClient();
    return client.sp.campaigns.listCampaigns({
      profileId: this.profileId,
      ...params
    });
  }

  /**
   * Get Sponsored Products campaign by ID
   */
  async getSPCampaign(campaignId) {
    const client = await this.getClient();
    return client.sp.campaigns.getCampaign({
      profileId: this.profileId,
      campaignId
    });
  }

  /**
   * Create Sponsored Products campaign
   */
  async createSPCampaign(campaign) {
    const client = await this.getClient();
    return client.sp.campaigns.createCampaigns({
      profileId: this.profileId,
      campaigns: [{
        name: campaign.name,
        campaignType: CampaignTypeEnum.SPONSORED_PRODUCTS,
        targetingType: campaign.targetingType || TARGETING_TYPE.MANUAL,
        state: campaign.state || CampaignStateEnum.ENABLED,
        dailyBudget: campaign.dailyBudget,
        startDate: campaign.startDate || new Date().toISOString().split('T')[0].replace(/-/g, ''),
        endDate: campaign.endDate,
        premiumBidAdjustment: campaign.premiumBidAdjustment || false
      }]
    });
  }

  /**
   * Update Sponsored Products campaign
   */
  async updateSPCampaign(campaignId, updates) {
    const client = await this.getClient();
    return client.sp.campaigns.updateCampaigns({
      profileId: this.profileId,
      campaigns: [{
        campaignId,
        ...updates
      }]
    });
  }

  /**
   * Pause Sponsored Products campaign
   */
  async pauseSPCampaign(campaignId) {
    return this.updateSPCampaign(campaignId, { state: CampaignStateEnum.PAUSED });
  }

  /**
   * Enable Sponsored Products campaign
   */
  async enableSPCampaign(campaignId) {
    return this.updateSPCampaign(campaignId, { state: CampaignStateEnum.ENABLED });
  }

  /**
   * Archive Sponsored Products campaign
   */
  async archiveSPCampaign(campaignId) {
    return this.updateSPCampaign(campaignId, { state: CampaignStateEnum.ARCHIVED });
  }

  // ==================== SPONSORED PRODUCTS - AD GROUPS ====================

  /**
   * List ad groups for campaign
   */
  async listSPAdGroups(campaignId = null) {
    const client = await this.getClient();
    const params = { profileId: this.profileId };
    if (campaignId) params.campaignIdFilter = [campaignId];
    return client.sp.adGroups.listAdGroups(params);
  }

  /**
   * Create ad group
   */
  async createSPAdGroup(adGroup) {
    const client = await this.getClient();
    return client.sp.adGroups.createAdGroups({
      profileId: this.profileId,
      adGroups: [{
        campaignId: adGroup.campaignId,
        name: adGroup.name,
        state: adGroup.state || AdGroupStateEnum.ENABLED,
        defaultBid: adGroup.defaultBid
      }]
    });
  }

  /**
   * Update ad group
   */
  async updateSPAdGroup(adGroupId, updates) {
    const client = await this.getClient();
    return client.sp.adGroups.updateAdGroups({
      profileId: this.profileId,
      adGroups: [{
        adGroupId,
        ...updates
      }]
    });
  }

  // ==================== SPONSORED PRODUCTS - KEYWORDS ====================

  /**
   * List keywords for ad group
   */
  async listSPKeywords(adGroupId = null) {
    const client = await this.getClient();
    const params = { profileId: this.profileId };
    if (adGroupId) params.adGroupIdFilter = [adGroupId];
    return client.sp.keywords.listKeywords(params);
  }

  /**
   * Create keywords
   */
  async createSPKeywords(keywords) {
    const client = await this.getClient();
    return client.sp.keywords.createKeywords({
      profileId: this.profileId,
      keywords: keywords.map(kw => ({
        campaignId: kw.campaignId,
        adGroupId: kw.adGroupId,
        keywordText: kw.keyword,
        matchType: kw.matchType || KeywordMatchTypeEnum.BROAD,
        state: kw.state || KeywordStateEnum.ENABLED,
        bid: kw.bid
      }))
    });
  }

  /**
   * Update keyword bid
   */
  async updateSPKeywordBid(keywordId, bid) {
    const client = await this.getClient();
    return client.sp.keywords.updateKeywords({
      profileId: this.profileId,
      keywords: [{
        keywordId,
        bid
      }]
    });
  }

  /**
   * Pause keyword
   */
  async pauseSPKeyword(keywordId) {
    const client = await this.getClient();
    return client.sp.keywords.updateKeywords({
      profileId: this.profileId,
      keywords: [{
        keywordId,
        state: KeywordStateEnum.PAUSED
      }]
    });
  }

  /**
   * Archive keyword
   */
  async archiveSPKeyword(keywordId) {
    const client = await this.getClient();
    return client.sp.keywords.archiveKeyword({
      profileId: this.profileId,
      keywordId
    });
  }

  // ==================== SPONSORED PRODUCTS - NEGATIVE KEYWORDS ====================

  /**
   * Create negative keywords
   */
  async createSPNegativeKeywords(keywords) {
    const client = await this.getClient();
    return client.sp.negativeKeywords.createNegativeKeywords({
      profileId: this.profileId,
      negativeKeywords: keywords.map(kw => ({
        campaignId: kw.campaignId,
        adGroupId: kw.adGroupId,
        keywordText: kw.keyword,
        matchType: kw.matchType || 'negativeExact',
        state: kw.state || 'enabled'
      }))
    });
  }

  // ==================== SPONSORED PRODUCTS - PRODUCT ADS ====================

  /**
   * List product ads
   */
  async listSPProductAds(adGroupId = null) {
    const client = await this.getClient();
    const params = { profileId: this.profileId };
    if (adGroupId) params.adGroupIdFilter = [adGroupId];
    return client.sp.productAds.listProductAds(params);
  }

  /**
   * Create product ads
   */
  async createSPProductAds(productAds) {
    const client = await this.getClient();
    return client.sp.productAds.createProductAds({
      profileId: this.profileId,
      productAds: productAds.map(ad => ({
        campaignId: ad.campaignId,
        adGroupId: ad.adGroupId,
        sku: ad.sku,
        asin: ad.asin,
        state: ad.state || 'enabled'
      }))
    });
  }

  // ==================== REPORTING ====================

  /**
   * Request Sponsored Products report
   */
  async requestSPReport(reportType, params = {}) {
    const client = await this.getClient();

    const metrics = params.metrics || [
      'impressions',
      'clicks',
      'cost',
      'attributedConversions14d',
      'attributedSales14d',
      'attributedUnitsOrdered14d'
    ];

    return client.sp.reports.requestReport({
      profileId: this.profileId,
      recordType: reportType, // 'campaigns', 'adGroups', 'keywords', 'productAds'
      reportDate: params.date || new Date().toISOString().split('T')[0].replace(/-/g, ''),
      metrics: metrics
    });
  }

  /**
   * Get report status
   */
  async getReportStatus(reportId) {
    const client = await this.getClient();
    return client.sp.reports.getReport({
      profileId: this.profileId,
      reportId
    });
  }

  /**
   * Download report
   */
  async downloadReport(reportId) {
    const client = await this.getClient();
    return client.sp.reports.downloadReport({
      profileId: this.profileId,
      reportId
    });
  }

  /**
   * Get campaign performance report
   */
  async getCampaignReport(startDate, endDate) {
    // Request report
    const reportRequest = await this.requestSPReport('campaigns', {
      metrics: [
        'impressions',
        'clicks',
        'cost',
        'attributedConversions14d',
        'attributedSales14d',
        'attributedUnitsOrdered14d',
        'campaignName',
        'campaignId',
        'campaignStatus',
        'campaignBudget'
      ]
    });

    // Poll for completion
    let status = await this.getReportStatus(reportRequest.reportId);
    let attempts = 0;
    const maxAttempts = 30;

    while (status.status !== 'SUCCESS' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      status = await this.getReportStatus(reportRequest.reportId);
      attempts++;
    }

    if (status.status !== 'SUCCESS') {
      throw new Error('Report generation timed out');
    }

    // Download report
    return this.downloadReport(reportRequest.reportId);
  }

  // ==================== UTILITY / ANALYTICS ====================

  /**
   * Get campaign performance summary
   */
  async getCampaignPerformanceSummary() {
    const campaigns = await this.listSPCampaigns();

    const summary = {
      totalCampaigns: campaigns.length,
      activeCampaigns: campaigns.filter(c => c.state === 'enabled').length,
      pausedCampaigns: campaigns.filter(c => c.state === 'paused').length,
      totalDailyBudget: campaigns.reduce((sum, c) => sum + (c.dailyBudget || 0), 0),
      campaigns: campaigns.map(c => ({
        id: c.campaignId,
        name: c.name,
        state: c.state,
        dailyBudget: c.dailyBudget,
        targetingType: c.targetingType
      }))
    };

    return summary;
  }

  /**
   * Get keyword performance analysis
   */
  async getKeywordAnalysis(campaignId) {
    const adGroups = await this.listSPAdGroups(campaignId);
    const analysis = {
      campaignId,
      adGroups: []
    };

    for (const adGroup of adGroups) {
      const keywords = await this.listSPKeywords(adGroup.adGroupId);

      analysis.adGroups.push({
        adGroupId: adGroup.adGroupId,
        name: adGroup.name,
        defaultBid: adGroup.defaultBid,
        keywords: keywords.map(kw => ({
          keywordId: kw.keywordId,
          keyword: kw.keywordText,
          matchType: kw.matchType,
          bid: kw.bid,
          state: kw.state
        }))
      });
    }

    return analysis;
  }

  /**
   * Optimize campaign bids based on performance
   * Returns recommendations without applying them
   */
  async getBidOptimizationRecommendations(campaignId, targetACoS = 25) {
    const report = await this.getCampaignReport();
    const recommendations = [];

    for (const item of report) {
      if (item.campaignId !== campaignId) continue;

      const impressions = item.impressions || 0;
      const clicks = item.clicks || 0;
      const cost = item.cost || 0;
      const sales = item.attributedSales14d || 0;

      const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
      const acos = sales > 0 ? (cost / sales) * 100 : Infinity;
      const cpc = clicks > 0 ? cost / clicks : 0;

      let recommendation = null;

      if (acos > targetACoS * 1.5) {
        // ACoS too high - reduce bid
        recommendation = {
          action: 'decrease_bid',
          reason: `ACoS (${acos.toFixed(1)}%) is significantly above target (${targetACoS}%)`,
          suggestedChange: -20 // 20% decrease
        };
      } else if (acos < targetACoS * 0.5 && impressions > 1000) {
        // ACoS very low with good volume - increase bid for more exposure
        recommendation = {
          action: 'increase_bid',
          reason: `ACoS (${acos.toFixed(1)}%) is well below target with good volume`,
          suggestedChange: 15 // 15% increase
        };
      } else if (ctr < 0.3 && impressions > 500) {
        // Low CTR - might need keyword refinement
        recommendation = {
          action: 'review_keywords',
          reason: `Low CTR (${ctr.toFixed(2)}%) suggests poor keyword relevance`,
          suggestedChange: 0
        };
      }

      if (recommendation) {
        recommendations.push({
          campaignId: item.campaignId,
          campaignName: item.campaignName,
          currentMetrics: {
            impressions,
            clicks,
            cost,
            sales,
            ctr: ctr.toFixed(2),
            acos: acos === Infinity ? 'N/A' : acos.toFixed(1),
            cpc: cpc.toFixed(2)
          },
          ...recommendation
        });
      }
    }

    return recommendations;
  }
}

module.exports = {
  AmazonAdsClient,
  ADS_REGIONS,
  CAMPAIGN_TYPE,
  TARGETING_TYPE,
  MATCH_TYPE
};
