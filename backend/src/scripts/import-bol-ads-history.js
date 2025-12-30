#!/usr/bin/env node
/**
 * Import Bol.com Ads Historical Performance Data
 *
 * Fetches campaign performance data from 01/01/2024 onwards
 * and stores it in MongoDB for analysis.
 *
 * Uses the Bol.com Advertising API v11 bulk reporting endpoints.
 */

require('dotenv').config();
const https = require('https');
const { MongoClient } = require('mongodb');

// Configuration
const BOL_AUTH_HOST = 'login.bol.com';
const BOL_API_HOST = 'api.bol.com';
const API_VERSION = 'v11';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';

// Date range
const START_DATE = '2024-01-01';
const END_DATE = new Date().toISOString().split('T')[0]; // Today

class BolAdsHistoryImporter {
  constructor() {
    this.clientId = process.env.BOL_CLIENT_ID;
    this.clientSecret = process.env.BOL_CLIENT_SECRET;
    this.accessToken = null;
    this.tokenExpiry = null;
    this.mongoClient = null;
    this.db = null;
  }

  async connectMongo() {
    this.mongoClient = new MongoClient(MONGODB_URI);
    await this.mongoClient.connect();
    this.db = this.mongoClient.db();
    console.log('Connected to MongoDB');

    // Create indexes
    await this.db.collection('bol_ads_performance').createIndex({ date: 1 });
    await this.db.collection('bol_ads_performance').createIndex({ campaignId: 1 });
    await this.db.collection('bol_ads_performance').createIndex({ campaignId: 1, date: 1 }, { unique: true });
  }

  async authenticate() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: BOL_AUTH_HOST,
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
              console.log('Authenticated with Bol.com');
              resolve(this.accessToken);
            } else {
              reject(new Error(`Auth failed: ${data}`));
            }
          } catch (e) {
            reject(new Error(`Auth parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  async request(method, path, body = null) {
    await this.authenticate();

    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Accept': `application/vnd.advertiser.${API_VERSION}+json`,
      'Content-Type': `application/vnd.advertiser.${API_VERSION}+json`
    };

    const payload = body ? JSON.stringify(body) : '';

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: BOL_API_HOST,
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
              reject(new Error(`API Error ${res.statusCode}: ${JSON.stringify(response)}`));
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ raw: data, statusCode: res.statusCode });
            } else {
              reject(new Error(`Parse error: ${e.message}, Status: ${res.statusCode}, Data: ${data.substring(0, 500)}`));
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
   * Request a campaign performance report for a date range
   */
  async requestCampaignPerformanceReport(startDate, endDate) {
    console.log(`Requesting report for ${startDate} to ${endDate}...`);

    const path = `/sponsored-products/campaign-performance/reports?start-date=${startDate}&end-date=${endDate}`;
    const response = await this.request('POST', path, {});

    return response;
  }

  /**
   * Check process status
   */
  async getProcessStatus(processStatusId) {
    const path = `/process-status/${processStatusId}`;
    return this.request('GET', path);
  }

  /**
   * Get the generated report
   */
  async getReport(reportId) {
    const path = `/sponsored-products/campaign-performance/reports/${reportId}`;
    return this.request('GET', path);
  }

  /**
   * Wait for report to be ready
   */
  async waitForReport(processStatusId, maxAttempts = 60) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await this.getProcessStatus(processStatusId);

      console.log(`  Status: ${status.status} (attempt ${attempt + 1})`);

      if (status.status === 'SUCCESS') {
        // Extract report ID from links
        const reportLink = status.links?.find(l => l.rel === 'self' || l.rel === 'report');
        if (reportLink) {
          const reportId = reportLink.href.split('/').pop();
          return reportId;
        }
        return status.entityId || status.id;
      }

      if (status.status === 'FAILURE') {
        throw new Error(`Report generation failed: ${JSON.stringify(status)}`);
      }

      // Wait 5 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    throw new Error('Timeout waiting for report');
  }

  /**
   * Generate monthly date ranges
   */
  getMonthlyRanges(startDate, endDate) {
    const ranges = [];
    let current = new Date(startDate);
    const end = new Date(endDate);

    while (current < end) {
      const monthStart = current.toISOString().split('T')[0];

      // Move to end of month
      current.setMonth(current.getMonth() + 1);
      current.setDate(0); // Last day of previous month

      let monthEnd = current.toISOString().split('T')[0];
      if (new Date(monthEnd) > end) {
        monthEnd = endDate;
      }

      ranges.push({ start: monthStart, end: monthEnd });

      // Move to first day of next month
      current.setDate(1);
      current.setMonth(current.getMonth() + 1);
    }

    return ranges;
  }

  /**
   * Store performance data in MongoDB
   */
  async storePerformanceData(data, startDate, endDate) {
    if (!data || !data.campaignPerformance) {
      console.log('  No campaign performance data in response');
      return 0;
    }

    const campaigns = data.campaignPerformance;
    let insertedCount = 0;

    for (const campaign of campaigns) {
      const doc = {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        campaignType: campaign.campaignType,
        date: new Date(startDate), // Aggregated for the period
        periodStart: new Date(startDate),
        periodEnd: new Date(endDate),
        impressions: campaign.impressions || 0,
        clicks: campaign.clicks || 0,
        ctr: campaign.ctr || 0,
        cost: campaign.cost || 0, // This is the ads spend
        spend: campaign.cost || campaign.spend || 0,
        orders: campaign.orders || campaign.conversions || 0,
        directOrders: campaign.directOrders || 0,
        indirectOrders: campaign.indirectOrders || 0,
        sales: campaign.sales || campaign.revenue || 0,
        directSales: campaign.directSales || 0,
        indirectSales: campaign.indirectSales || 0,
        acos: campaign.acos || 0,
        roas: campaign.roas || 0,
        cpc: campaign.cpc || campaign.averageCpc || 0,
        conversionRate: campaign.conversionRate || 0,
        importedAt: new Date(),
        source: 'bol_ads_api_v11'
      };

      try {
        await this.db.collection('bol_ads_performance').updateOne(
          { campaignId: doc.campaignId, periodStart: doc.periodStart, periodEnd: doc.periodEnd },
          { $set: doc },
          { upsert: true }
        );
        insertedCount++;
      } catch (e) {
        if (e.code !== 11000) { // Ignore duplicate key errors
          console.error(`  Error storing campaign ${campaign.campaignId}: ${e.message}`);
        }
      }
    }

    return insertedCount;
  }

  /**
   * Try alternative: Get campaigns and then get performance for each
   */
  async fetchCampaignsDirectly() {
    console.log('\nFetching campaigns list...');

    try {
      // List all campaigns
      const response = await this.request('PUT', '/sponsored-products/campaigns', {
        page: 1,
        pageSize: 100
      });

      if (response.campaigns && response.campaigns.length > 0) {
        console.log(`Found ${response.campaigns.length} campaigns`);
        return response.campaigns;
      }
    } catch (e) {
      console.error('Error fetching campaigns:', e.message);
    }

    return [];
  }

  /**
   * Get performance for specific campaigns
   */
  async getPerformance(entityType, entityIds, startDate, endDate) {
    const path = `/sponsored-products/performance?entity-type=${entityType}&period-start-date=${startDate}&period-end-date=${endDate}`;

    try {
      const response = await this.request('PUT', path, {
        entityIds: entityIds
      });
      return response;
    } catch (e) {
      console.error(`Error getting performance: ${e.message}`);
      return null;
    }
  }

  /**
   * Main import function
   */
  async import() {
    console.log('='.repeat(60));
    console.log('Bol.com Ads Historical Import');
    console.log('='.repeat(60));
    console.log(`Period: ${START_DATE} to ${END_DATE}`);
    console.log('');

    await this.connectMongo();

    // First, try the bulk campaign performance report approach
    console.log('Attempting bulk campaign performance report...');

    const ranges = this.getMonthlyRanges(START_DATE, END_DATE);
    console.log(`Will process ${ranges.length} monthly periods\n`);

    let totalImported = 0;
    let successfulPeriods = 0;
    let failedPeriods = 0;

    for (const range of ranges) {
      console.log(`\nProcessing: ${range.start} to ${range.end}`);

      try {
        // Request the report
        const reportRequest = await this.requestCampaignPerformanceReport(range.start, range.end);

        if (reportRequest.processStatusId) {
          console.log(`  Process ID: ${reportRequest.processStatusId}`);

          // Wait for report to be ready
          const reportId = await this.waitForReport(reportRequest.processStatusId);
          console.log(`  Report ID: ${reportId}`);

          // Get the report data
          const reportData = await this.getReport(reportId);

          // Store in MongoDB
          const count = await this.storePerformanceData(reportData, range.start, range.end);
          console.log(`  Imported ${count} campaign records`);

          totalImported += count;
          successfulPeriods++;
        } else {
          console.log(`  Unexpected response: ${JSON.stringify(reportRequest)}`);
          failedPeriods++;
        }

        // Rate limiting - wait between requests
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (e) {
        console.error(`  Error: ${e.message}`);
        failedPeriods++;

        // If bulk reports fail, try direct performance endpoint for recent 30 days
        if (e.message.includes('404') || e.message.includes('not found')) {
          console.log('  Bulk endpoint not available, will try alternative method...');
        }
      }
    }

    // If bulk approach failed, try getting campaigns and using performance endpoint
    if (totalImported === 0) {
      console.log('\n\nBulk reports not working. Trying alternative: direct performance endpoint...');
      console.log('Note: This only works for the last 30 days.\n');

      const campaigns = await this.fetchCampaignsDirectly();

      if (campaigns.length > 0) {
        // Store campaign info
        for (const campaign of campaigns) {
          await this.db.collection('bol_ads_campaigns').updateOne(
            { campaignId: campaign.campaignId },
            {
              $set: {
                ...campaign,
                updatedAt: new Date()
              }
            },
            { upsert: true }
          );
        }
        console.log(`Stored ${campaigns.length} campaigns in bol_ads_campaigns`);

        // Get performance for last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const startDate30 = thirtyDaysAgo.toISOString().split('T')[0];
        const endDate30 = new Date().toISOString().split('T')[0];

        console.log(`\nFetching performance for ${startDate30} to ${endDate30}...`);

        const campaignIds = campaigns.map(c => c.campaignId);
        const performance = await this.getPerformance('CAMPAIGN', campaignIds, startDate30, endDate30);

        if (performance && performance.entityPerformance) {
          for (const perf of performance.entityPerformance) {
            await this.db.collection('bol_ads_performance').updateOne(
              { campaignId: perf.entityId, periodStart: new Date(startDate30), periodEnd: new Date(endDate30) },
              {
                $set: {
                  campaignId: perf.entityId,
                  periodStart: new Date(startDate30),
                  periodEnd: new Date(endDate30),
                  impressions: perf.impressions || 0,
                  clicks: perf.clicks || 0,
                  cost: perf.cost || 0,
                  spend: perf.cost || 0,
                  sales: perf.sales || 0,
                  orders: perf.conversions || 0,
                  acos: perf.acos || 0,
                  roas: perf.roas || 0,
                  importedAt: new Date(),
                  source: 'bol_ads_api_performance'
                }
              },
              { upsert: true }
            );
            totalImported++;
          }
          console.log(`Imported ${performance.entityPerformance.length} performance records`);
        }
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('IMPORT COMPLETE');
    console.log('='.repeat(60));
    console.log(`Total records imported: ${totalImported}`);
    console.log(`Successful periods: ${successfulPeriods}`);
    console.log(`Failed periods: ${failedPeriods}`);

    // Show what's in the database
    const stats = await this.db.collection('bol_ads_performance').aggregate([
      {
        $group: {
          _id: null,
          totalRecords: { $sum: 1 },
          totalSpend: { $sum: '$cost' },
          totalSales: { $sum: '$sales' },
          minDate: { $min: '$periodStart' },
          maxDate: { $max: '$periodEnd' }
        }
      }
    ]).toArray();

    if (stats.length > 0) {
      console.log(`\nDatabase stats:`);
      console.log(`  Records: ${stats[0].totalRecords}`);
      console.log(`  Total Spend: €${(stats[0].totalSpend || 0).toFixed(2)}`);
      console.log(`  Total Sales: €${(stats[0].totalSales || 0).toFixed(2)}`);
      console.log(`  Date range: ${stats[0].minDate?.toISOString().split('T')[0]} to ${stats[0].maxDate?.toISOString().split('T')[0]}`);
    }

    await this.mongoClient.close();
  }
}

// Run the import
const importer = new BolAdsHistoryImporter();
importer.import().catch(e => {
  console.error('Import failed:', e);
  process.exit(1);
});
