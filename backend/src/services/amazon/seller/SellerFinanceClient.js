/**
 * SellerFinanceClient - Amazon SP-API Finance App Client
 *
 * Uses the dedicated Finance App credentials for accessing:
 * - Settlement Reports
 * - Financial Event Groups
 * - Financial Events
 *
 * Separate from main SellerClient to use Finance-specific permissions.
 */

const SellingPartner = require('amazon-sp-api');

class SellerFinanceClient {
  constructor() {
    const refreshToken = process.env.AMAZON_FINANCE_SELLER_REFRESH_TOKEN;
    const clientId = process.env.AMAZON_FINANCE_LWA_CLIENT_ID;
    const clientSecret = process.env.AMAZON_FINANCE_LWA_CLIENT_SECRET;

    if (!refreshToken) {
      throw new Error('AMAZON_FINANCE_SELLER_REFRESH_TOKEN is not configured');
    }
    if (!clientId || !clientSecret) {
      throw new Error('AMAZON_FINANCE_LWA_CLIENT_ID and AMAZON_FINANCE_LWA_CLIENT_SECRET must be configured');
    }

    this.config = {
      region: 'eu',
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: clientId,
        SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret
      },
      options: {
        auto_request_tokens: true,
        auto_request_throttled: true,
        version_fallback: true
      }
    };

    this.client = null;
  }

  async init() {
    if (this.client) return this.client;
    this.client = new SellingPartner(this.config);
    return this.client;
  }

  async getClient() {
    if (!this.client) {
      await this.init();
    }
    return this.client;
  }

  // ==================== SETTLEMENT REPORTS ====================

  /**
   * Get list of available settlement reports
   * @param {Object} options
   * @param {number} options.pageSize - Max reports to return (default 10)
   * @param {Date} options.createdAfter - Only reports created after this date
   */
  async getSettlementReports(options = {}) {
    const client = await this.getClient();
    const { pageSize = 10, createdAfter } = options;

    const query = {
      reportTypes: ['GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'],
      processingStatuses: ['DONE'],
      pageSize
    };

    if (createdAfter) {
      query.createdSince = createdAfter instanceof Date
        ? createdAfter.toISOString()
        : createdAfter;
    }

    const response = await client.callAPI({
      operation: 'reports.getReports',
      query
    });

    return response.reports || [];
  }

  /**
   * Download a settlement report by report ID
   * @param {string} reportId - The report ID
   * @returns {Object} Parsed settlement data
   */
  async downloadSettlementReport(reportId) {
    const client = await this.getClient();

    // First get the report to find the document ID
    const report = await client.callAPI({
      operation: 'reports.getReport',
      path: { reportId }
    });

    if (!report.reportDocumentId) {
      throw new Error(`Report ${reportId} has no document ID`);
    }

    // Get the document details
    const reportDoc = await client.callAPI({
      operation: 'reports.getReportDocument',
      path: { reportDocumentId: report.reportDocumentId }
    });

    // Download and parse the content
    const content = await client.download(reportDoc, { json: false });

    return this.parseSettlementContent(content, {
      reportId,
      dataStartTime: report.dataStartTime,
      dataEndTime: report.dataEndTime,
      createdTime: report.createdTime
    });
  }

  /**
   * Parse settlement report TSV content
   */
  parseSettlementContent(content, metadata = {}) {
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length === 0) {
      return { transactions: [], summary: {} };
    }

    // Parse headers
    const headers = lines[0].split('\t').map(h => this.toCamelCase(h.trim()));

    const transactions = [];
    let settlementId = null;
    let currency = null;
    let totalAmount = 0;

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      const row = {};

      headers.forEach((header, idx) => {
        let value = values[idx] || '';
        if (header === 'amount' || header === 'totalAmount') {
          value = this.parseAmount(value);
        }
        row[header] = value;
      });

      if (!settlementId && row.settlementId) {
        settlementId = row.settlementId;
      }
      if (!currency && row.currency) {
        currency = row.currency;
      }

      if (row.amount !== undefined && row.amount !== '') {
        const amount = parseFloat(row.amount) || 0;
        totalAmount += amount;
        transactions.push({
          ...row,
          amount,
          marketplaceCountry: this.getMarketplaceCountry(row.marketplaceName)
        });
      }
    }

    return {
      reportId: metadata.reportId,
      settlementId,
      currency: currency || 'EUR',
      totalAmount,
      transactionCount: transactions.length,
      dataStartTime: metadata.dataStartTime,
      dataEndTime: metadata.dataEndTime,
      createdTime: metadata.createdTime,
      transactions
    };
  }

  toCamelCase(str) {
    return str.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
  }

  parseAmount(value) {
    if (!value || value === '') return 0;
    let normalized = value.toString()
      .replace(/[^0-9.,-]/g, '')
      .replace(/\.(?=.*\.)/g, '')
      .replace(',', '.');
    return parseFloat(normalized) || 0;
  }

  getMarketplaceCountry(marketplaceName) {
    const mapping = {
      'Amazon.de': 'DE', 'Amazon.fr': 'FR', 'Amazon.it': 'IT',
      'Amazon.es': 'ES', 'Amazon.nl': 'NL', 'Amazon.co.uk': 'GB',
      'Amazon.com.be': 'BE', 'Amazon.pl': 'PL', 'Amazon.se': 'SE',
      'Amazon.com.tr': 'TR'
    };
    return mapping[marketplaceName] || 'EU';
  }

  // ==================== FINANCIAL EVENT GROUPS ====================

  /**
   * Get financial event groups (settlement periods)
   * @param {Object} options
   * @param {Date} options.startedAfter - Groups started after this date
   * @param {number} options.maxResults - Max results (default 10)
   */
  async getFinancialEventGroups(options = {}) {
    const client = await this.getClient();
    const { startedAfter, maxResults = 10 } = options;

    const query = { MaxResultsPerPage: maxResults };

    if (startedAfter) {
      query.FinancialEventGroupStartedAfter = startedAfter instanceof Date
        ? startedAfter.toISOString()
        : startedAfter;
    } else {
      // Default to last 90 days
      const defaultStart = new Date();
      defaultStart.setDate(defaultStart.getDate() - 90);
      query.FinancialEventGroupStartedAfter = defaultStart.toISOString();
    }

    const response = await client.callAPI({
      operation: 'finances.listFinancialEventGroups',
      query
    });

    return response.FinancialEventGroupList || [];
  }

  /**
   * Get financial events for a specific group
   * @param {string} groupId - Financial event group ID
   * @param {number} maxResults - Max results per page
   */
  async getFinancialEventsForGroup(groupId, maxResults = 100) {
    const client = await this.getClient();

    const response = await client.callAPI({
      operation: 'finances.listFinancialEventsByGroupId',
      path: { eventGroupId: groupId },
      query: { MaxResultsPerPage: maxResults }
    });

    return response.FinancialEvents || {};
  }

  /**
   * Get recent financial events
   * @param {Object} options
   * @param {Date} options.postedAfter - Events posted after this date
   * @param {number} options.maxResults - Max results (default 100)
   */
  async getFinancialEvents(options = {}) {
    const client = await this.getClient();
    const { postedAfter, maxResults = 100 } = options;

    const query = { MaxResultsPerPage: maxResults };

    if (postedAfter) {
      query.PostedAfter = postedAfter instanceof Date
        ? postedAfter.toISOString()
        : postedAfter;
    } else {
      // Default to last 7 days
      const defaultStart = new Date();
      defaultStart.setDate(defaultStart.getDate() - 7);
      query.PostedAfter = defaultStart.toISOString();
    }

    const response = await client.callAPI({
      operation: 'finances.listFinancialEvents',
      query
    });

    return response.FinancialEvents || {};
  }

  /**
   * Test connection
   */
  async testConnection() {
    try {
      const reports = await this.getSettlementReports({ pageSize: 1 });
      return {
        success: true,
        message: 'Finance API connection successful',
        reportsAvailable: reports.length
      };
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  }
}

// Singleton
let instance = null;

function getSellerFinanceClient() {
  if (!instance) {
    instance = new SellerFinanceClient();
  }
  return instance;
}

module.exports = {
  SellerFinanceClient,
  getSellerFinanceClient
};
