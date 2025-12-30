/**
 * Amazon Advertising API Client
 *
 * Direct API implementation for Amazon Ads (no SDK dependency).
 * Uses OAuth 2.0 with refresh token for authentication.
 *
 * Features:
 * - Profile management (list advertising profiles)
 * - Campaign listing (Sponsored Products, Brands, Display)
 * - Performance reports (async report generation)
 * - Cost/spend data retrieval
 *
 * @see https://advertising.amazon.com/API/docs/en-us/
 * @module AmazonAdsClient
 */

const https = require('https');

/**
 * Amazon Ads API Endpoints
 */
const ENDPOINTS = {
  // OAuth token endpoint (same for all regions)
  token: 'api.amazon.com',
  // Regional API endpoints
  na: 'advertising-api.amazon.com',
  eu: 'advertising-api-eu.amazon.com',
  fe: 'advertising-api-fe.amazon.com'
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
 * Report Types for Sponsored Products
 */
const SP_REPORT_TYPES = {
  CAMPAIGNS: 'campaigns',
  AD_GROUPS: 'adGroups',
  KEYWORDS: 'keywords',
  TARGETS: 'targets',
  PRODUCT_ADS: 'productAds',
  SEARCH_TERM: 'searchTerm'
};

/**
 * Amazon Advertising API Client
 */
class AmazonAdsClient {
  constructor(config = {}) {
    this.clientId = config.clientId || process.env.AMAZON_ADS_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.AMAZON_ADS_CLIENT_SECRET;
    this.refreshToken = config.refreshToken || process.env.AMAZON_ADS_REFRESH_TOKEN;
    this.region = config.region || 'eu'; // Default to EU for Acropaq

    this.accessToken = null;
    this.tokenExpiry = null;
    this.profiles = null;

    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      console.warn('[AmazonAdsClient] Credentials not configured. Set AMAZON_ADS_CLIENT_ID, AMAZON_ADS_CLIENT_SECRET, AMAZON_ADS_REFRESH_TOKEN');
    }
  }

  /**
   * Get the API host for the configured region
   */
  getApiHost() {
    return ENDPOINTS[this.region] || ENDPOINTS.eu;
  }

  /**
   * Refresh the access token using the refresh token
   */
  async authenticate() {
    // Return cached token if still valid
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const postData = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret
    }).toString();

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: ENDPOINTS.token,
        port: 443,
        path: '/auth/o2/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.access_token) {
              this.accessToken = response.access_token;
              // Token expires in 1 hour, refresh 5 minutes early
              this.tokenExpiry = Date.now() + (response.expires_in - 300) * 1000;
              console.log('[AmazonAdsClient] Authenticated successfully');
              resolve(this.accessToken);
            } else {
              reject(new Error(`Amazon Ads auth failed: ${response.error_description || response.error || data}`));
            }
          } catch (e) {
            reject(new Error(`Amazon Ads auth parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Make authenticated API request
   * @param {string} method - HTTP method
   * @param {string} path - API path
   * @param {object} body - Request body (optional)
   * @param {string} profileId - Advertising profile ID (optional, required for most endpoints)
   */
  async request(method, path, body = null, profileId = null) {
    await this.authenticate();

    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Amazon-Advertising-API-ClientId': this.clientId,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // Profile ID required for most endpoints
    if (profileId) {
      headers['Amazon-Advertising-API-Scope'] = profileId.toString();
    }

    const payload = body ? JSON.stringify(body) : '';
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: this.getApiHost(),
        port: 443,
        path: path,
        method: method,
        headers: headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // Handle empty responses
          if (!data || data.trim() === '') {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(null);
            } else {
              reject(new Error(`Amazon Ads API error: ${res.statusCode}`));
            }
            return;
          }

          try {
            const response = JSON.parse(data);

            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              reject(new Error(`Amazon Ads API error ${res.statusCode}: ${response.message || response.details || data}`));
            }
          } catch (e) {
            // Some endpoints return non-JSON (like report downloads)
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`Amazon Ads API error ${res.statusCode}: ${data}`));
            }
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ==================== PROFILES ====================

  /**
   * List all advertising profiles
   * Returns profiles for all marketplaces the account has access to
   */
  async listProfiles() {
    const profiles = await this.request('GET', '/v2/profiles');
    this.profiles = profiles;
    return profiles;
  }

  /**
   * Get a specific profile by ID
   */
  async getProfile(profileId) {
    return this.request('GET', `/v2/profiles/${profileId}`);
  }

  /**
   * Get profiles for EU marketplaces only
   */
  async getEuProfiles() {
    const profiles = await this.listProfiles();
    const euCountries = ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE', 'UK', 'GB'];
    return profiles.filter(p =>
      euCountries.includes(p.countryCode) && p.accountInfo?.type === 'seller'
    );
  }

  // ==================== SPONSORED PRODUCTS CAMPAIGNS ====================

  /**
   * List Sponsored Products campaigns
   * @param {string} profileId - Advertising profile ID
   * @param {object} options - Filter options
   */
  async listSpCampaigns(profileId, options = {}) {
    const params = new URLSearchParams();
    if (options.stateFilter) params.append('stateFilter', options.stateFilter);
    if (options.startIndex) params.append('startIndex', options.startIndex);
    if (options.count) params.append('count', options.count || 100);

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/v2/sp/campaigns${query}`, null, profileId);
  }

  /**
   * Get a specific SP campaign
   */
  async getSpCampaign(profileId, campaignId) {
    return this.request('GET', `/v2/sp/campaigns/${campaignId}`, null, profileId);
  }

  /**
   * List SP ad groups
   */
  async listSpAdGroups(profileId, options = {}) {
    const params = new URLSearchParams();
    if (options.campaignIdFilter) params.append('campaignIdFilter', options.campaignIdFilter);
    if (options.startIndex) params.append('startIndex', options.startIndex);
    if (options.count) params.append('count', options.count || 100);

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/v2/sp/adGroups${query}`, null, profileId);
  }

  // ==================== SPONSORED BRANDS CAMPAIGNS ====================

  /**
   * List Sponsored Brands campaigns
   */
  async listSbCampaigns(profileId, options = {}) {
    const params = new URLSearchParams();
    if (options.stateFilter) params.append('stateFilter', options.stateFilter);
    if (options.startIndex) params.append('startIndex', options.startIndex);
    if (options.count) params.append('count', options.count || 100);

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/sb/v4/campaigns${query}`, null, profileId);
  }

  // ==================== REPORTS ====================

  /**
   * Request a Sponsored Products report (v2)
   * Reports are generated asynchronously
   *
   * @param {string} profileId - Profile ID
   * @param {string} recordType - Type: campaigns, adGroups, keywords, targets, productAds, searchTerm
   * @param {object} options - Report options
   */
  async requestSpReport(profileId, recordType, options = {}) {
    const body = {
      reportDate: options.reportDate || new Date().toISOString().split('T')[0].replace(/-/g, ''),
      metrics: options.metrics || 'impressions,clicks,cost,attributedConversions30d,attributedSales30d'
    };

    if (options.campaignType) body.campaignType = options.campaignType;
    if (options.segment) body.segment = options.segment;

    return this.request('POST', `/v2/sp/${recordType}/report`, body, profileId);
  }

  /**
   * Request a Sponsored Brands report
   */
  async requestSbReport(profileId, recordType, options = {}) {
    const body = {
      reportDate: options.reportDate || new Date().toISOString().split('T')[0].replace(/-/g, ''),
      metrics: options.metrics || 'impressions,clicks,cost,attributedSales14d'
    };

    return this.request('POST', `/v2/hsa/${recordType}/report`, body, profileId);
  }

  /**
   * Get report status
   * @param {string} profileId - Profile ID
   * @param {string} reportId - Report ID from requestSpReport
   */
  async getReportStatus(profileId, reportId) {
    return this.request('GET', `/v2/reports/${reportId}`, null, profileId);
  }

  /**
   * Download a completed report
   * @param {string} profileId - Profile ID
   * @param {string} reportId - Report ID
   */
  async downloadReport(profileId, reportId) {
    // First get the status to get the download URL
    const status = await this.getReportStatus(profileId, reportId);

    if (status.status !== 'SUCCESS') {
      throw new Error(`Report not ready: ${status.status}`);
    }

    // Download from the provided URL (gzip compressed)
    return new Promise((resolve, reject) => {
      const url = new URL(status.location);

      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Accept-Encoding': 'gzip'
        }
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);

          // Decompress gzip
          const zlib = require('zlib');
          zlib.gunzip(buffer, (err, decompressed) => {
            if (err) {
              reject(err);
              return;
            }

            try {
              const data = JSON.parse(decompressed.toString());
              resolve(data);
            } catch (e) {
              reject(new Error(`Failed to parse report: ${e.message}`));
            }
          });
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Request and wait for a report to complete
   * @param {string} profileId - Profile ID
   * @param {string} recordType - Report type
   * @param {object} options - Report options
   * @param {number} maxWaitMs - Maximum wait time (default 5 minutes)
   */
  async getReport(profileId, recordType, options = {}, maxWaitMs = 300000) {
    // Request the report
    const response = await this.requestSpReport(profileId, recordType, options);
    const reportId = response.reportId;

    console.log(`[AmazonAdsClient] Report requested: ${reportId}`);

    // Poll for completion
    const startTime = Date.now();
    const pollInterval = 5000; // 5 seconds

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getReportStatus(profileId, reportId);

      if (status.status === 'SUCCESS') {
        console.log(`[AmazonAdsClient] Report ready, downloading...`);
        return this.downloadReport(profileId, reportId);
      }

      if (status.status === 'FAILURE') {
        throw new Error(`Report generation failed: ${status.statusDetails || 'Unknown error'}`);
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Report generation timed out after ${maxWaitMs / 1000} seconds`);
  }

  // ==================== CONVENIENCE METHODS ====================

  /**
   * Get campaign performance summary for a profile
   */
  async getCampaignPerformanceSummary(profileId, reportDate = null) {
    const date = reportDate || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0].replace(/-/g, '');

    try {
      const report = await this.getReport(profileId, 'campaigns', {
        reportDate: date,
        metrics: 'campaignName,campaignStatus,campaignBudget,impressions,clicks,cost,attributedConversions30d,attributedSales30d'
      });

      // Aggregate stats
      const summary = {
        date: date,
        totalCampaigns: report.length,
        activeCampaigns: report.filter(c => c.campaignStatus === 'enabled').length,
        pausedCampaigns: report.filter(c => c.campaignStatus === 'paused').length,
        totalImpressions: report.reduce((sum, c) => sum + (c.impressions || 0), 0),
        totalClicks: report.reduce((sum, c) => sum + (c.clicks || 0), 0),
        totalCost: report.reduce((sum, c) => sum + (c.cost || 0), 0),
        totalConversions: report.reduce((sum, c) => sum + (c.attributedConversions30d || 0), 0),
        totalSales: report.reduce((sum, c) => sum + (c.attributedSales30d || 0), 0),
        campaigns: report
      };

      return summary;

    } catch (error) {
      console.error(`[AmazonAdsClient] Failed to get campaign summary: ${error.message}`);
      throw error;
    }
  }

  /**
   * Test the connection
   */
  async testConnection() {
    try {
      await this.authenticate();
      const profiles = await this.listProfiles();

      return {
        success: true,
        message: `Connected successfully. Found ${profiles.length} advertising profiles.`,
        profiles: profiles.map(p => ({
          profileId: p.profileId,
          countryCode: p.countryCode,
          accountName: p.accountInfo?.name,
          type: p.accountInfo?.type
        }))
      };
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  }
}

module.exports = {
  AmazonAdsClient,
  ENDPOINTS,
  CAMPAIGN_TYPE,
  SP_REPORT_TYPES
};
