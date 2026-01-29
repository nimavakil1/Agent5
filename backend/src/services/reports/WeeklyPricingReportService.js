/**
 * WeeklyPricingReportService - Weekly pricing comparison across Bol.com and Amazon
 *
 * Generates a weekly report showing prices for each product across:
 * - Bol.com
 * - Amazon DE, FR, NL, BE
 *
 * Matches products by cleaned SKU (not EAN).
 *
 * Schedule: Sunday 20:00 (Europe/Amsterdam)
 *
 * @module WeeklyPricingReportService
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs').promises;
const { skuResolver } = require('../amazon/SkuResolver');
const { getSellerClient } = require('../amazon/seller/SellerClient');
const { MARKETPLACE_IDS, getMarketplaceConfig } = require('../amazon/seller/SellerMarketplaceConfig');

// Target Amazon marketplaces for pricing
const TARGET_MARKETPLACES = {
  DE: MARKETPLACE_IDS.DE,
  FR: MARKETPLACE_IDS.FR,
  NL: MARKETPLACE_IDS.NL,
  BE: MARKETPLACE_IDS.BE
};

// Bol.com API token cache
let bolAccessToken = null;
let bolTokenExpiry = null;

/**
 * WeeklyPricingReportService - Generates weekly pricing comparison report
 */
class WeeklyPricingReportService {
  constructor() {
    this.webhookUrl = process.env.TEAMS_PRICING_REPORT_WEBHOOK_URL;
    this.sellerClient = null;
  }

  /**
   * Get Bol.com access token
   */
  async getBolAccessToken() {
    const clientId = process.env.BOL_CLIENT_ID;
    const clientSecret = process.env.BOL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Bol.com credentials not configured');
    }

    // Check cached token
    if (bolAccessToken && bolTokenExpiry && Date.now() < bolTokenExpiry - 30000) {
      return bolAccessToken;
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://login.bol.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${credentials}`
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
      throw new Error(`Failed to get Bol.com access token: ${await response.text()}`);
    }

    const data = await response.json();
    bolAccessToken = data.access_token;
    bolTokenExpiry = Date.now() + (data.expires_in * 1000);

    return bolAccessToken;
  }

  /**
   * Request Bol.com offer export
   */
  async requestBolOfferExport() {
    const token = await this.getBolAccessToken();
    const response = await fetch('https://api.bol.com/retailer/offers/export', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Content-Type': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ format: 'CSV' })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `Failed to request offer export: ${response.status}`);
    }

    const result = await response.json();
    return result.processStatusId;
  }

  /**
   * Wait for Bol.com offer export to complete
   */
  async waitForBolExport(processStatusId, maxWaitMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < maxWaitMs) {
      const token = await this.getBolAccessToken();
      const response = await fetch(`https://api.bol.com/shared/process-status/${processStatusId}`, {
        headers: {
          'Accept': 'application/vnd.retailer.v10+json',
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to get process status: ${response.status}`);
      }

      const status = await response.json();

      if (status.status === 'SUCCESS') {
        const reportLink = status.links?.find(l => l.rel === 'self' || l.href?.includes('export'));
        if (reportLink) {
          const match = reportLink.href?.match(/export\/(\d+)/);
          if (match) return match[1];
        }
        return status.entityId;
      }

      if (status.status === 'FAILURE' || status.status === 'TIMEOUT') {
        throw new Error(`Offer export failed: ${status.errorMessage || status.status}`);
      }

      await this.sleep(pollInterval);
    }

    throw new Error('Offer export timed out');
  }

  /**
   * Download and parse Bol.com offer export CSV
   */
  async downloadBolOfferExport(reportId) {
    const token = await this.getBolAccessToken();
    const response = await fetch(`https://api.bol.com/retailer/offers/export/${reportId}`, {
      headers: {
        'Accept': 'application/vnd.retailer.v10+csv',
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download offer export: ${response.status}`);
    }

    const csv = await response.text();
    return this.parseBolOfferCsv(csv);
  }

  /**
   * Parse Bol.com offer export CSV
   * Returns offers with SKU (referenceCode), EAN, price
   */
  parseBolOfferCsv(csv) {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const offers = [];

    // Find column indices
    const offerIdIdx = headers.indexOf('offerId');
    const eanIdx = headers.indexOf('ean');
    const refIdx = headers.indexOf('referenceCode');
    const priceIdx = headers.indexOf('bundlePricesPrice');
    const fulfillmentIdx = headers.indexOf('fulfilmentType');

    console.log(`[WeeklyPricingReport] CSV columns: offerId=${offerIdIdx}, ean=${eanIdx}, ref=${refIdx}, price=${priceIdx}`);

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
      if (values.length < headers.length) continue;

      const offerId = values[offerIdIdx];
      const ean = values[eanIdx];
      const reference = values[refIdx] || '';
      const price = parseFloat(values[priceIdx]) || 0;
      const fulfillmentType = values[fulfillmentIdx] || '';

      if (!offerId || !ean) continue;

      offers.push({
        offerId,
        ean,
        sku: reference,
        price,
        fulfillmentType
      });
    }

    console.log(`[WeeklyPricingReport] Parsed ${offers.length} Bol.com offers with prices`);
    return offers;
  }

  /**
   * Get all Bol.com offers with prices
   */
  async getBolOffers() {
    try {
      console.log('[WeeklyPricingReport] Fetching Bol.com offers...');
      const processStatusId = await this.requestBolOfferExport();
      const reportId = await this.waitForBolExport(processStatusId);
      const offers = await this.downloadBolOfferExport(reportId);
      return offers;
    } catch (error) {
      console.error('[WeeklyPricingReport] Failed to get Bol.com offers:', error.message);
      return [];
    }
  }

  /**
   * Get Amazon pricing for a marketplace using Listings API
   * Returns SKU -> price mapping
   */
  async getAmazonPrices(marketplaceId, country) {
    try {
      console.log(`[WeeklyPricingReport] Fetching Amazon ${country} prices...`);

      // Request MERCHANT_LISTINGS_ALL_DATA report which includes prices
      const client = await this.getSellerClient();

      // Use the SP-API to get a listings report
      const reportType = 'GET_MERCHANT_LISTINGS_ALL_DATA';
      const reportResponse = await client.client.callAPI({
        operation: 'reports.createReport',
        body: {
          reportType,
          marketplaceIds: [marketplaceId]
        }
      });

      const reportId = reportResponse.reportId;
      console.log(`[WeeklyPricingReport] Amazon ${country} report requested: ${reportId}`);

      // Wait for report to be ready
      const reportData = await this.waitForAmazonReport(client, reportId);

      if (!reportData) {
        console.warn(`[WeeklyPricingReport] Amazon ${country} report failed or empty`);
        return new Map();
      }

      // Parse the report data (TSV format)
      return this.parseAmazonListingsReport(reportData, country);
    } catch (error) {
      console.error(`[WeeklyPricingReport] Failed to get Amazon ${country} prices:`, error.message);
      return new Map();
    }
  }

  /**
   * Wait for Amazon report to be ready and download it
   */
  async waitForAmazonReport(client, reportId, maxWaitMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 10000;

    while (Date.now() - startTime < maxWaitMs) {
      const report = await client.client.callAPI({
        operation: 'reports.getReport',
        path: { reportId }
      });

      if (report.processingStatus === 'DONE') {
        // Download the report
        if (report.reportDocumentId) {
          const documentResponse = await client.client.callAPI({
            operation: 'reports.getReportDocument',
            path: { reportDocumentId: report.reportDocumentId }
          });

          // Download from URL
          const reportResponse = await fetch(documentResponse.url);
          if (reportResponse.ok) {
            return await reportResponse.text();
          }
        }
        return null;
      }

      if (report.processingStatus === 'CANCELLED' || report.processingStatus === 'FATAL') {
        console.warn(`[WeeklyPricingReport] Report ${reportId} failed: ${report.processingStatus}`);
        return null;
      }

      await this.sleep(pollInterval);
    }

    console.warn(`[WeeklyPricingReport] Report ${reportId} timed out`);
    return null;
  }

  /**
   * Parse Amazon listings report (TSV format)
   * Returns Map of SKU -> { asin, price, title }
   */
  parseAmazonListingsReport(tsvData, country) {
    const results = new Map();
    const lines = tsvData.trim().split('\n');

    if (lines.length < 2) return results;

    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());

    // Find column indices
    const skuIdx = headers.findIndex(h => h === 'seller-sku' || h === 'sku');
    const asinIdx = headers.findIndex(h => h === 'asin1' || h === 'asin');
    const priceIdx = headers.findIndex(h => h === 'price');
    const titleIdx = headers.findIndex(h => h === 'item-name' || h === 'title');

    console.log(`[WeeklyPricingReport] Amazon ${country} report columns: sku=${skuIdx}, asin=${asinIdx}, price=${priceIdx}`);

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      if (values.length < Math.max(skuIdx, asinIdx, priceIdx) + 1) continue;

      const sku = values[skuIdx]?.trim();
      const asin = values[asinIdx]?.trim();
      const price = parseFloat(values[priceIdx]) || 0;
      const title = values[titleIdx]?.trim() || '';

      if (!sku) continue;

      results.set(sku, { asin, price, title });
    }

    console.log(`[WeeklyPricingReport] Amazon ${country}: ${results.size} listings with prices`);
    return results;
  }

  /**
   * Get or initialize the seller client
   */
  async getSellerClient() {
    if (!this.sellerClient) {
      this.sellerClient = getSellerClient();
      await this.sellerClient.init();
    }
    return this.sellerClient;
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean up SKU for matching
   * Uses SkuResolver to normalize SKUs
   */
  cleanSku(sku) {
    if (!sku) return '';

    // Ensure SkuResolver is loaded
    if (!skuResolver.loaded) {
      // Return basic cleanup if not loaded
      return sku.trim().toUpperCase()
        .replace(/-FBM[A]?$/i, '')
        .replace(/-FBBA?$/i, '');
    }

    const resolved = skuResolver.resolve(sku);
    return resolved.odooSku?.toUpperCase() || sku.trim().toUpperCase();
  }

  /**
   * Generate the weekly pricing report
   */
  async generateReport() {
    console.log('[WeeklyPricingReport] Starting weekly pricing report generation...');

    // Load SKU resolver mappings
    await skuResolver.load();

    // Fetch Bol.com offers
    const bolOffers = await this.getBolOffers();

    // Fetch Amazon prices for each marketplace
    const amazonPrices = {};
    for (const [country, marketplaceId] of Object.entries(TARGET_MARKETPLACES)) {
      amazonPrices[country] = await this.getAmazonPrices(marketplaceId, country);
      // Small delay between marketplace requests
      await this.sleep(2000);
    }

    // Build consolidated product list by cleaned SKU
    const products = new Map(); // cleanedSku -> { sku, ean, title, bolPrice, amazonDE, amazonFR, amazonNL, amazonBE }

    // Process Bol.com offers
    for (const offer of bolOffers) {
      const cleanedSku = this.cleanSku(offer.sku);
      if (!cleanedSku) continue;

      if (!products.has(cleanedSku)) {
        products.set(cleanedSku, {
          cleanedSku,
          originalSku: offer.sku,
          ean: offer.ean,
          title: '',
          bolPrice: offer.price,
          amazonDE: null,
          amazonFR: null,
          amazonNL: null,
          amazonBE: null
        });
      } else {
        // Update if not already set
        const existing = products.get(cleanedSku);
        if (!existing.bolPrice && offer.price) {
          existing.bolPrice = offer.price;
        }
        if (!existing.ean && offer.ean) {
          existing.ean = offer.ean;
        }
      }
    }

    // Process Amazon prices
    for (const [country, priceMap] of Object.entries(amazonPrices)) {
      for (const [amazonSku, data] of priceMap) {
        const cleanedSku = this.cleanSku(amazonSku);
        if (!cleanedSku) continue;

        if (!products.has(cleanedSku)) {
          products.set(cleanedSku, {
            cleanedSku,
            originalSku: amazonSku,
            ean: '',
            title: data.title || '',
            bolPrice: null,
            amazonDE: null,
            amazonFR: null,
            amazonNL: null,
            amazonBE: null
          });
        }

        const product = products.get(cleanedSku);
        product[`amazon${country}`] = data.price;

        // Update title if we have one
        if (data.title && !product.title) {
          product.title = data.title;
        }
      }
    }

    console.log(`[WeeklyPricingReport] Consolidated ${products.size} unique products by SKU`);

    // Generate Excel report
    const excelBuffer = await this.generateExcel(Array.from(products.values()));

    // Save locally
    const saveResult = await this.saveLocally(excelBuffer);

    // Send Teams notification
    const teamsResult = await this.sendToTeams(products.size, saveResult.url);

    return {
      success: true,
      productsCount: products.size,
      bolOffersCount: bolOffers.length,
      amazonMarketplaces: Object.keys(amazonPrices),
      excelUrl: saveResult.url,
      teamsNotified: teamsResult.success
    };
  }

  /**
   * Generate Excel report
   */
  async generateExcel(products) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Agent5 Weekly Pricing Report';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Pricing Comparison', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    // Header row
    worksheet.addRow([
      'SKU',
      'EAN',
      'Product Name',
      'Bol.com',
      'Amazon DE',
      'Amazon FR',
      'Amazon NL',
      'Amazon BE'
    ]);

    // Style header row
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Set column widths
    worksheet.columns = [
      { width: 15 },  // SKU
      { width: 16 },  // EAN
      { width: 50 },  // Product Name
      { width: 12 },  // Bol.com
      { width: 12 },  // Amazon DE
      { width: 12 },  // Amazon FR
      { width: 12 },  // Amazon NL
      { width: 12 }   // Amazon BE
    ];

    // Add data rows
    for (const product of products) {
      const row = worksheet.addRow([
        product.cleanedSku || '',
        product.ean || '',
        (product.title || '').substring(0, 100), // Truncate long titles
        product.bolPrice || '',
        product.amazonDE || '',
        product.amazonFR || '',
        product.amazonNL || '',
        product.amazonBE || ''
      ]);

      // Format price columns
      for (let col = 4; col <= 8; col++) {
        const cell = row.getCell(col);
        if (typeof cell.value === 'number' && cell.value > 0) {
          cell.numFmt = '€#,##0.00';
        }
      }
    }

    // Auto-filter
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1 + products.length, column: 8 }
    };

    // Add borders
    const lastRow = 1 + products.length;
    for (let row = 1; row <= lastRow; row++) {
      for (let col = 1; col <= 8; col++) {
        const cell = worksheet.getCell(row, col);
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
        };
      }
    }

    return workbook.xlsx.writeBuffer();
  }

  /**
   * Save Excel report locally
   */
  async saveLocally(buffer) {
    try {
      const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'pricing-reports');
      await fs.mkdir(uploadsDir, { recursive: true });

      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const filename = `pricing_report_${dateStr}.xlsx`;
      const filePath = path.join(uploadsDir, filename);

      await fs.writeFile(filePath, buffer);

      const baseUrl = process.env.APP_BASE_URL || 'https://ai.acropaq.com';
      const url = `${baseUrl}/uploads/pricing-reports/${filename}`;

      console.log(`[WeeklyPricingReport] Report saved: ${filePath}`);
      return { success: true, url };
    } catch (error) {
      console.error('[WeeklyPricingReport] Local save failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send Teams notification
   */
  async sendToTeams(productsCount, reportUrl) {
    if (!this.webhookUrl) {
      console.log('[WeeklyPricingReport] Teams webhook not configured, skipping notification');
      return { success: false, error: 'Teams webhook not configured' };
    }

    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const cardBody = [
      {
        type: 'TextBlock',
        text: `📊 Weekly Pricing Report - ${dateStr}`,
        weight: 'bolder',
        size: 'medium'
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Products', value: String(productsCount) },
          { title: 'Marketplaces', value: 'Bol.com, Amazon DE/FR/NL/BE' }
        ]
      },
      {
        type: 'TextBlock',
        text: 'Price comparison across Bol.com and Amazon marketplaces, matched by SKU.',
        wrap: true,
        isSubtle: true,
        size: 'small'
      }
    ];

    const actions = [];
    if (reportUrl) {
      actions.push({
        type: 'Action.OpenUrl',
        title: '📥 Download Report',
        url: reportUrl
      });
    }

    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: cardBody,
      actions: actions.length > 0 ? actions : undefined
    };

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: card
          }]
        })
      });

      if (!response.ok) {
        throw new Error(`Teams webhook failed: ${response.status}`);
      }

      console.log('[WeeklyPricingReport] Teams notification sent');
      return { success: true };
    } catch (error) {
      console.error('[WeeklyPricingReport] Teams notification failed:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// Singleton instance
let pricingReportServiceInstance = null;

/**
 * Get the singleton WeeklyPricingReportService instance
 */
function getWeeklyPricingReportService() {
  if (!pricingReportServiceInstance) {
    pricingReportServiceInstance = new WeeklyPricingReportService();
  }
  return pricingReportServiceInstance;
}

/**
 * Run the weekly pricing report (for scheduler)
 */
async function runWeeklyPricingReport() {
  const service = getWeeklyPricingReportService();
  return service.generateReport();
}

module.exports = {
  WeeklyPricingReportService,
  getWeeklyPricingReportService,
  runWeeklyPricingReport
};
