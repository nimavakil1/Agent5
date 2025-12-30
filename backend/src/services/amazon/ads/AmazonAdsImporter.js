/**
 * Amazon Ads Data Importer
 *
 * Fetches advertising performance data from Amazon Ads API
 * and stores it in MongoDB for analysis.
 *
 * Data collected:
 * - Campaign performance (daily)
 * - Ad group performance
 * - Keyword performance
 * - Search term reports
 *
 * @module AmazonAdsImporter
 */

const { AmazonAdsClient, SP_REPORT_TYPES } = require('./AmazonAdsClient');
const { getDb } = require('../../../db');

// Collection names
const COLLECTIONS = {
  profiles: 'amazon_ads_profiles',
  campaigns: 'amazon_ads_campaigns',
  performance: 'amazon_ads_performance',
  adGroups: 'amazon_ads_ad_groups',
  keywords: 'amazon_ads_keywords',
  searchTerms: 'amazon_ads_search_terms'
};

/**
 * Amazon Ads Data Importer
 */
class AmazonAdsImporter {
  constructor(config = {}) {
    this.client = new AmazonAdsClient(config);
    this.db = null;
    this.initialized = false;
  }

  /**
   * Initialize the importer
   */
  async init() {
    if (this.initialized) return;

    this.db = getDb();

    // Create indexes
    await this.ensureIndexes();

    this.initialized = true;
    console.log('[AmazonAdsImporter] Initialized');
  }

  /**
   * Create MongoDB indexes
   */
  async ensureIndexes() {
    // Profiles
    await this.db.collection(COLLECTIONS.profiles).createIndex({ profileId: 1 }, { unique: true });
    await this.db.collection(COLLECTIONS.profiles).createIndex({ countryCode: 1 });

    // Campaigns
    await this.db.collection(COLLECTIONS.campaigns).createIndex({ campaignId: 1 }, { unique: true });
    await this.db.collection(COLLECTIONS.campaigns).createIndex({ profileId: 1 });
    await this.db.collection(COLLECTIONS.campaigns).createIndex({ state: 1 });

    // Performance (daily data)
    await this.db.collection(COLLECTIONS.performance).createIndex({ profileId: 1, date: 1 });
    await this.db.collection(COLLECTIONS.performance).createIndex({ campaignId: 1, date: 1 });
    await this.db.collection(COLLECTIONS.performance).createIndex(
      { profileId: 1, campaignId: 1, date: 1 },
      { unique: true }
    );

    // Ad Groups
    await this.db.collection(COLLECTIONS.adGroups).createIndex({ adGroupId: 1 }, { unique: true });
    await this.db.collection(COLLECTIONS.adGroups).createIndex({ campaignId: 1 });

    // Keywords
    await this.db.collection(COLLECTIONS.keywords).createIndex({ keywordId: 1 }, { unique: true });
    await this.db.collection(COLLECTIONS.keywords).createIndex({ campaignId: 1 });
    await this.db.collection(COLLECTIONS.keywords).createIndex({ adGroupId: 1 });

    // Search Terms
    await this.db.collection(COLLECTIONS.searchTerms).createIndex({ profileId: 1, date: 1 });
    await this.db.collection(COLLECTIONS.searchTerms).createIndex(
      { profileId: 1, query: 1, date: 1 },
      { unique: true }
    );

    console.log('[AmazonAdsImporter] Indexes created');
  }

  /**
   * Sync all advertising profiles
   */
  async syncProfiles() {
    await this.init();

    const profiles = await this.client.listProfiles();
    const results = { synced: 0, total: profiles.length };

    for (const profile of profiles) {
      await this.db.collection(COLLECTIONS.profiles).updateOne(
        { profileId: profile.profileId },
        {
          $set: {
            ...profile,
            updatedAt: new Date()
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
      results.synced++;
    }

    console.log(`[AmazonAdsImporter] Synced ${results.synced} profiles`);
    return results;
  }

  /**
   * Sync campaigns for a profile
   */
  async syncCampaigns(profileId) {
    await this.init();

    const campaigns = await this.client.listSpCampaigns(profileId, { count: 1000 });
    const results = { synced: 0, total: campaigns.length };

    for (const campaign of campaigns) {
      await this.db.collection(COLLECTIONS.campaigns).updateOne(
        { campaignId: campaign.campaignId },
        {
          $set: {
            profileId: profileId,
            ...campaign,
            updatedAt: new Date()
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
      results.synced++;
    }

    console.log(`[AmazonAdsImporter] Synced ${results.synced} campaigns for profile ${profileId}`);
    return results;
  }

  /**
   * Import performance data for a date range
   * @param {string} profileId - Advertising profile ID
   * @param {string} startDate - Start date (YYYYMMDD)
   * @param {string} endDate - End date (YYYYMMDD)
   */
  async importPerformance(profileId, startDate, endDate = null) {
    await this.init();

    const end = endDate || startDate;
    const results = {
      dates: [],
      totalRecords: 0,
      errors: []
    };

    // Generate date range
    const dates = this.getDateRange(startDate, end);

    for (const date of dates) {
      try {
        console.log(`[AmazonAdsImporter] Fetching performance for ${date}...`);

        const report = await this.client.getReport(profileId, 'campaigns', {
          reportDate: date,
          metrics: 'campaignName,campaignStatus,campaignBudget,impressions,clicks,cost,attributedConversions30d,attributedSales30d,attributedUnitsOrdered30d'
        });

        // Store each campaign's daily performance
        for (const record of report) {
          await this.db.collection(COLLECTIONS.performance).updateOne(
            {
              profileId: profileId,
              campaignId: record.campaignId,
              date: date
            },
            {
              $set: {
                profileId: profileId,
                campaignId: record.campaignId,
                campaignName: record.campaignName,
                campaignStatus: record.campaignStatus,
                campaignBudget: record.campaignBudget,
                date: date,
                impressions: record.impressions || 0,
                clicks: record.clicks || 0,
                cost: record.cost || 0,
                conversions: record.attributedConversions30d || 0,
                sales: record.attributedSales30d || 0,
                unitsOrdered: record.attributedUnitsOrdered30d || 0,
                // Calculate metrics
                ctr: record.impressions > 0 ? (record.clicks / record.impressions) * 100 : 0,
                cpc: record.clicks > 0 ? record.cost / record.clicks : 0,
                acos: record.attributedSales30d > 0 ? (record.cost / record.attributedSales30d) * 100 : 0,
                roas: record.cost > 0 ? record.attributedSales30d / record.cost : 0,
                updatedAt: new Date()
              },
              $setOnInsert: {
                createdAt: new Date()
              }
            },
            { upsert: true }
          );
          results.totalRecords++;
        }

        results.dates.push({ date, records: report.length });
        console.log(`[AmazonAdsImporter] Imported ${report.length} records for ${date}`);

        // Rate limiting - wait between requests
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`[AmazonAdsImporter] Error for ${date}: ${error.message}`);
        results.errors.push({ date, error: error.message });
      }
    }

    return results;
  }

  /**
   * Import keyword performance data
   */
  async importKeywordPerformance(profileId, date) {
    await this.init();

    try {
      const report = await this.client.getReport(profileId, 'keywords', {
        reportDate: date,
        metrics: 'campaignName,adGroupName,keywordText,matchType,impressions,clicks,cost,attributedConversions30d,attributedSales30d'
      });

      let imported = 0;
      for (const record of report) {
        await this.db.collection(COLLECTIONS.keywords).updateOne(
          { keywordId: record.keywordId },
          {
            $set: {
              profileId: profileId,
              campaignId: record.campaignId,
              adGroupId: record.adGroupId,
              keywordText: record.keywordText,
              matchType: record.matchType,
              state: record.state,
              updatedAt: new Date()
            },
            $push: {
              performance: {
                date: date,
                impressions: record.impressions || 0,
                clicks: record.clicks || 0,
                cost: record.cost || 0,
                conversions: record.attributedConversions30d || 0,
                sales: record.attributedSales30d || 0
              }
            },
            $setOnInsert: {
              createdAt: new Date()
            }
          },
          { upsert: true }
        );
        imported++;
      }

      console.log(`[AmazonAdsImporter] Imported ${imported} keyword records for ${date}`);
      return { imported, date };

    } catch (error) {
      console.error(`[AmazonAdsImporter] Keyword import error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Import search term report
   */
  async importSearchTerms(profileId, date) {
    await this.init();

    try {
      const report = await this.client.getReport(profileId, 'searchTerm', {
        reportDate: date,
        metrics: 'campaignName,adGroupName,keywordText,query,impressions,clicks,cost,attributedConversions30d,attributedSales30d'
      });

      let imported = 0;
      for (const record of report) {
        await this.db.collection(COLLECTIONS.searchTerms).updateOne(
          {
            profileId: profileId,
            query: record.query,
            date: date
          },
          {
            $set: {
              profileId: profileId,
              campaignId: record.campaignId,
              adGroupId: record.adGroupId,
              keywordText: record.keywordText,
              query: record.query,
              date: date,
              impressions: record.impressions || 0,
              clicks: record.clicks || 0,
              cost: record.cost || 0,
              conversions: record.attributedConversions30d || 0,
              sales: record.attributedSales30d || 0,
              updatedAt: new Date()
            },
            $setOnInsert: {
              createdAt: new Date()
            }
          },
          { upsert: true }
        );
        imported++;
      }

      console.log(`[AmazonAdsImporter] Imported ${imported} search term records for ${date}`);
      return { imported, date };

    } catch (error) {
      console.error(`[AmazonAdsImporter] Search term import error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get aggregated stats for a date range
   */
  async getStats(profileId, startDate, endDate) {
    await this.init();

    const pipeline = [
      {
        $match: {
          profileId: profileId,
          date: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: null,
          totalImpressions: { $sum: '$impressions' },
          totalClicks: { $sum: '$clicks' },
          totalCost: { $sum: '$cost' },
          totalSales: { $sum: '$sales' },
          totalConversions: { $sum: '$conversions' },
          totalUnitsOrdered: { $sum: '$unitsOrdered' },
          daysWithData: { $addToSet: '$date' }
        }
      }
    ];

    const results = await this.db.collection(COLLECTIONS.performance)
      .aggregate(pipeline)
      .toArray();

    if (results.length === 0) {
      return {
        impressions: 0,
        clicks: 0,
        cost: 0,
        sales: 0,
        conversions: 0,
        daysWithData: 0
      };
    }

    const stats = results[0];
    return {
      impressions: stats.totalImpressions,
      clicks: stats.totalClicks,
      cost: stats.totalCost,
      sales: stats.totalSales,
      conversions: stats.totalConversions,
      unitsOrdered: stats.totalUnitsOrdered,
      ctr: stats.totalImpressions > 0 ? (stats.totalClicks / stats.totalImpressions) * 100 : 0,
      cpc: stats.totalClicks > 0 ? stats.totalCost / stats.totalClicks : 0,
      acos: stats.totalSales > 0 ? (stats.totalCost / stats.totalSales) * 100 : 0,
      roas: stats.totalCost > 0 ? stats.totalSales / stats.totalCost : 0,
      daysWithData: stats.daysWithData.length
    };
  }

  /**
   * Get daily performance trend
   */
  async getDailyTrend(profileId, startDate, endDate) {
    await this.init();

    const pipeline = [
      {
        $match: {
          profileId: profileId,
          date: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$date',
          impressions: { $sum: '$impressions' },
          clicks: { $sum: '$clicks' },
          cost: { $sum: '$cost' },
          sales: { $sum: '$sales' },
          conversions: { $sum: '$conversions' }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ];

    const results = await this.db.collection(COLLECTIONS.performance)
      .aggregate(pipeline)
      .toArray();

    return results.map(r => ({
      date: r._id,
      impressions: r.impressions,
      clicks: r.clicks,
      cost: r.cost,
      sales: r.sales,
      conversions: r.conversions,
      ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
      acos: r.sales > 0 ? (r.cost / r.sales) * 100 : 0
    }));
  }

  /**
   * Get top campaigns by spend
   */
  async getTopCampaignsBySpend(profileId, startDate, endDate, limit = 10) {
    await this.init();

    const pipeline = [
      {
        $match: {
          profileId: profileId,
          date: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: { campaignId: '$campaignId', campaignName: '$campaignName' },
          totalCost: { $sum: '$cost' },
          totalSales: { $sum: '$sales' },
          totalClicks: { $sum: '$clicks' },
          totalImpressions: { $sum: '$impressions' },
          totalConversions: { $sum: '$conversions' }
        }
      },
      {
        $sort: { totalCost: -1 }
      },
      {
        $limit: limit
      }
    ];

    const results = await this.db.collection(COLLECTIONS.performance)
      .aggregate(pipeline)
      .toArray();

    return results.map(r => ({
      campaignId: r._id.campaignId,
      campaignName: r._id.campaignName,
      cost: r.totalCost,
      sales: r.totalSales,
      clicks: r.totalClicks,
      impressions: r.totalImpressions,
      conversions: r.totalConversions,
      acos: r.totalSales > 0 ? (r.totalCost / r.totalSales) * 100 : 0,
      roas: r.totalCost > 0 ? r.totalSales / r.totalCost : 0
    }));
  }

  /**
   * Helper: Generate date range array
   */
  getDateRange(startDate, endDate) {
    const dates = [];
    const start = this.parseDate(startDate);
    const end = this.parseDate(endDate);

    const current = new Date(start);
    while (current <= end) {
      dates.push(this.formatDate(current));
      current.setDate(current.getDate() + 1);
    }

    return dates;
  }

  /**
   * Helper: Parse YYYYMMDD to Date
   */
  parseDate(dateStr) {
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    return new Date(year, month, day);
  }

  /**
   * Helper: Format Date to YYYYMMDD
   */
  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }
}

// Singleton instance
let importerInstance = null;

async function getAmazonAdsImporter(config = {}) {
  if (!importerInstance) {
    importerInstance = new AmazonAdsImporter(config);
    await importerInstance.init();
  }
  return importerInstance;
}

module.exports = {
  AmazonAdsImporter,
  getAmazonAdsImporter,
  COLLECTIONS
};
