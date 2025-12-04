/**
 * Amazon Advertising API Integration (Stub)
 *
 * NOTE: The @scaleleap/amazon-advertising-api-sdk package has dependency issues.
 * This is a stub that exports the required constants and a placeholder client.
 * Full implementation can be restored when the package is fixed.
 *
 * @module AmazonAds
 */

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
 * Amazon Advertising API Client (Stub)
 *
 * This is a placeholder implementation. Methods will throw errors
 * indicating that the Amazon Ads SDK needs to be properly configured.
 */
class AmazonAdsClient {
  constructor(config = {}) {
    this.config = config;
    this.initialized = false;
  }

  _notImplemented(method) {
    throw new Error(
      `AmazonAdsClient.${method}() is not available. ` +
      'The Amazon Advertising SDK has dependency issues. ' +
      'Please configure direct API access or wait for package fix.'
    );
  }

  async init() {
    console.warn('AmazonAdsClient: Using stub implementation - Amazon Ads features disabled');
    this.initialized = true;
    return this;
  }

  async getClient() {
    if (!this.initialized) await this.init();
    return this;
  }

  // Stub methods that return empty results or throw
  async listProfiles() { return []; }
  async getProfile() { return null; }
  async listSPCampaigns() { return []; }
  async getSPCampaign() { return null; }
  async createSPCampaign() { this._notImplemented('createSPCampaign'); }
  async updateSPCampaign() { this._notImplemented('updateSPCampaign'); }
  async pauseSPCampaign() { this._notImplemented('pauseSPCampaign'); }
  async enableSPCampaign() { this._notImplemented('enableSPCampaign'); }
  async archiveSPCampaign() { this._notImplemented('archiveSPCampaign'); }
  async listSPAdGroups() { return []; }
  async createSPAdGroup() { this._notImplemented('createSPAdGroup'); }
  async updateSPAdGroup() { this._notImplemented('updateSPAdGroup'); }
  async listSPKeywords() { return []; }
  async createSPKeywords() { this._notImplemented('createSPKeywords'); }
  async updateSPKeywordBid() { this._notImplemented('updateSPKeywordBid'); }
  async pauseSPKeyword() { this._notImplemented('pauseSPKeyword'); }
  async archiveSPKeyword() { this._notImplemented('archiveSPKeyword'); }
  async createSPNegativeKeywords() { this._notImplemented('createSPNegativeKeywords'); }
  async listSPProductAds() { return []; }
  async createSPProductAds() { this._notImplemented('createSPProductAds'); }
  async requestSPReport() { this._notImplemented('requestSPReport'); }
  async getReportStatus() { return { status: 'UNAVAILABLE' }; }
  async downloadReport() { return []; }
  async getCampaignReport() { return []; }

  async getCampaignPerformanceSummary() {
    return {
      totalCampaigns: 0,
      activeCampaigns: 0,
      pausedCampaigns: 0,
      totalDailyBudget: 0,
      campaigns: [],
      note: 'Amazon Ads integration is currently disabled'
    };
  }

  async getKeywordAnalysis() {
    return { campaignId: null, adGroups: [], note: 'Amazon Ads integration is currently disabled' };
  }

  async getBidOptimizationRecommendations() {
    return [];
  }
}

module.exports = {
  AmazonAdsClient,
  ADS_REGIONS,
  CAMPAIGN_TYPE,
  TARGETING_TYPE,
  MATCH_TYPE
};
