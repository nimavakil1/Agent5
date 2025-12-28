/**
 * SellerReviewsSync - Sync seller feedback/reviews from Amazon
 *
 * Imports seller feedback using GET_SELLER_FEEDBACK_DATA report:
 * 1. Request the feedback report
 * 2. Download and parse the report (CSV with Order ID, Rating, Comments, Response, Date)
 * 3. Store in MongoDB for display
 *
 * @module SellerReviewsSync
 */

const { getDb } = require('../../../db');
const { getSellerClient } = require('./SellerClient');
const { MARKETPLACE_CONFIG, getAllMarketplaceIds, getCountryFromMarketplace } = require('./SellerMarketplaceConfig');

// Feedback report type
const FEEDBACK_REPORT = 'GET_SELLER_FEEDBACK_DATA';

// Collections
const REVIEWS_COLLECTION = 'seller_reviews';
const REPORTS_COLLECTION = 'seller_reports';

/**
 * SellerReviewsSync - Syncs seller feedback from Amazon
 */
class SellerReviewsSync {
  constructor() {
    this.client = null;
    this.db = null;
  }

  /**
   * Initialize the sync service
   */
  async init() {
    if (this.db) return;

    this.client = getSellerClient();
    await this.client.init();

    this.db = getDb();

    // Create indexes
    await this.db.collection(REVIEWS_COLLECTION).createIndex({ orderId: 1 }, { unique: true, sparse: true });
    await this.db.collection(REVIEWS_COLLECTION).createIndex({ rating: 1 });
    await this.db.collection(REVIEWS_COLLECTION).createIndex({ marketplaceId: 1 });
    await this.db.collection(REVIEWS_COLLECTION).createIndex({ feedbackDate: -1 });
  }

  /**
   * Request a new feedback report for all marketplaces
   */
  async requestReport() {
    await this.init();

    try {
      const spClient = await this.client.getClient();

      // Get all EU marketplace IDs
      const marketplaceIds = getAllMarketplaceIds();

      // Request the report
      const response = await spClient.callAPI({
        operation: 'reports.createReport',
        body: {
          reportType: FEEDBACK_REPORT,
          marketplaceIds: marketplaceIds
        }
      });

      const reportId = response.reportId;
      console.log(`[SellerReviewsSync] Requested feedback report ${reportId}`);

      // Store report request
      await this.db.collection(REPORTS_COLLECTION).insertOne({
        reportId,
        reportType: FEEDBACK_REPORT,
        status: 'IN_QUEUE',
        requestedAt: new Date(),
        processed: false
      });

      return { success: true, reportId };

    } catch (error) {
      console.error('[SellerReviewsSync] Error requesting report:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check status of pending reports and process completed ones
   */
  async processReports() {
    await this.init();

    const result = {
      checked: 0,
      processed: 0,
      reviewsImported: 0,
      errors: []
    };

    try {
      // Find pending reports
      const pendingReports = await this.db.collection(REPORTS_COLLECTION).find({
        reportType: FEEDBACK_REPORT,
        processed: false
      }).toArray();

      const spClient = await this.client.getClient();

      for (const report of pendingReports) {
        result.checked++;

        try {
          // Check report status
          const status = await spClient.callAPI({
            operation: 'reports.getReport',
            path: { reportId: report.reportId }
          });

          console.log(`[SellerReviewsSync] Report ${report.reportId} status: ${status.processingStatus}`);

          if (status.processingStatus === 'DONE') {
            // Download and process the report
            const documentId = status.reportDocumentId;
            const document = await spClient.callAPI({
              operation: 'reports.getReportDocument',
              path: { reportDocumentId: documentId }
            });

            // Download the actual report content
            const reportData = await this._downloadReport(document.url, document.compressionAlgorithm);
            const reviews = this._parseReportData(reportData, status.marketplaceIds);

            // Import reviews
            for (const review of reviews) {
              await this._upsertReview(review);
              result.reviewsImported++;
            }

            // Mark report as processed
            await this.db.collection(REPORTS_COLLECTION).updateOne(
              { reportId: report.reportId },
              { $set: { processed: true, processedAt: new Date(), reviewCount: reviews.length } }
            );

            result.processed++;

          } else if (status.processingStatus === 'CANCELLED' || status.processingStatus === 'FATAL') {
            // Mark as processed (failed)
            await this.db.collection(REPORTS_COLLECTION).updateOne(
              { reportId: report.reportId },
              { $set: { processed: true, processedAt: new Date(), error: status.processingStatus } }
            );
          }

        } catch (error) {
          console.error(`[SellerReviewsSync] Error processing report ${report.reportId}:`, error.message);
          result.errors.push({ reportId: report.reportId, error: error.message });
        }
      }

    } catch (error) {
      console.error('[SellerReviewsSync] Error processing reports:', error.message);
      result.errors.push({ error: error.message });
    }

    return result;
  }

  /**
   * Download report from URL
   */
  async _downloadReport(url, compressionAlgorithm) {
    const https = require('https');
    const http = require('http');
    const zlib = require('zlib');

    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;

      client.get(url, (response) => {
        const chunks = [];

        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          let data = Buffer.concat(chunks);

          // Decompress if needed
          if (compressionAlgorithm === 'GZIP') {
            data = zlib.gunzipSync(data);
          }

          resolve(data.toString('utf-8'));
        });
        response.on('error', reject);
      }).on('error', reject);
    });
  }

  /**
   * Parse report CSV data
   * Expected columns: Order ID, Rating, Comments, Your Response, Date
   */
  _parseReportData(csvData, marketplaceIds) {
    const reviews = [];
    const lines = csvData.split('\n');

    if (lines.length <= 1) return reviews;

    // Parse header to find column indices
    const header = lines[0].split('\t');
    const orderIdIdx = header.findIndex(h => h.toLowerCase().includes('order'));
    const ratingIdx = header.findIndex(h => h.toLowerCase().includes('rating'));
    const commentsIdx = header.findIndex(h => h.toLowerCase().includes('comment'));
    const responseIdx = header.findIndex(h => h.toLowerCase().includes('response'));
    const dateIdx = header.findIndex(h => h.toLowerCase().includes('date'));

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = line.split('\t');
      const orderId = orderIdIdx >= 0 ? cols[orderIdIdx]?.trim() : null;
      const rating = ratingIdx >= 0 ? parseInt(cols[ratingIdx]?.trim()) : null;
      const comments = commentsIdx >= 0 ? cols[commentsIdx]?.trim() : '';
      const response = responseIdx >= 0 ? cols[responseIdx]?.trim() : '';
      const dateStr = dateIdx >= 0 ? cols[dateIdx]?.trim() : null;

      if (!orderId) continue;

      // Parse date
      let feedbackDate = null;
      if (dateStr) {
        feedbackDate = new Date(dateStr);
        if (isNaN(feedbackDate.getTime())) {
          feedbackDate = new Date();
        }
      }

      reviews.push({
        orderId,
        rating: rating || 0,
        comments: comments || '',
        response: response || '',
        feedbackDate: feedbackDate || new Date(),
        marketplaceId: marketplaceIds?.[0] || null,
        marketplaceCountry: marketplaceIds?.[0] ? getCountryFromMarketplace(marketplaceIds[0]) : null
      });
    }

    return reviews;
  }

  /**
   * Upsert a review in the database
   */
  async _upsertReview(review) {
    await this.db.collection(REVIEWS_COLLECTION).updateOne(
      { orderId: review.orderId },
      {
        $set: {
          ...review,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
  }

  /**
   * Get reviews with filters
   */
  async getReviews(filters = {}, options = {}) {
    await this.init();

    const query = {};

    if (filters.rating) {
      query.rating = parseInt(filters.rating);
    }
    if (filters.minRating) {
      query.rating = { $gte: parseInt(filters.minRating) };
    }
    if (filters.maxRating) {
      query.rating = { ...query.rating, $lte: parseInt(filters.maxRating) };
    }
    if (filters.marketplace) {
      query.marketplaceCountry = filters.marketplace.toUpperCase();
    }
    if (filters.orderId) {
      query.orderId = { $regex: filters.orderId, $options: 'i' };
    }
    if (filters.hasComments) {
      query.comments = { $ne: '' };
    }
    if (filters.dateFrom) {
      query.feedbackDate = { $gte: new Date(filters.dateFrom) };
    }
    if (filters.dateTo) {
      query.feedbackDate = { ...query.feedbackDate, $lte: new Date(filters.dateTo) };
    }

    const limit = options.limit || 50;
    const skip = options.skip || 0;

    return this.db.collection(REVIEWS_COLLECTION)
      .find(query)
      .sort({ feedbackDate: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
  }

  /**
   * Count reviews with filters
   */
  async countReviews(filters = {}) {
    await this.init();

    const query = {};
    if (filters.rating) query.rating = parseInt(filters.rating);
    if (filters.marketplace) query.marketplaceCountry = filters.marketplace.toUpperCase();

    return this.db.collection(REVIEWS_COLLECTION).countDocuments(query);
  }

  /**
   * Get review statistics
   */
  async getStats() {
    await this.init();

    const pipeline = [
      {
        $facet: {
          total: [{ $count: 'count' }],
          byRating: [
            { $group: { _id: '$rating', count: { $sum: 1 } } },
            { $sort: { _id: -1 } }
          ],
          byMarketplace: [
            { $group: { _id: '$marketplaceCountry', count: { $sum: 1 }, avgRating: { $avg: '$rating' } } },
            { $sort: { count: -1 } }
          ],
          average: [
            { $group: { _id: null, avgRating: { $avg: '$rating' } } }
          ],
          recent: [
            { $sort: { feedbackDate: -1 } },
            { $limit: 5 },
            { $project: { orderId: 1, rating: 1, comments: 1, feedbackDate: 1, marketplaceCountry: 1 } }
          ],
          withComments: [
            { $match: { comments: { $ne: '' } } },
            { $count: 'count' }
          ],
          negative: [
            { $match: { rating: { $lte: 2 } } },
            { $count: 'count' }
          ]
        }
      }
    ];

    const [result] = await this.db.collection(REVIEWS_COLLECTION).aggregate(pipeline).toArray();

    return {
      total: result.total[0]?.count || 0,
      averageRating: result.average[0]?.avgRating?.toFixed(1) || '0.0',
      byRating: result.byRating.reduce((acc, r) => {
        acc[r._id] = r.count;
        return acc;
      }, {}),
      byMarketplace: result.byMarketplace.map(m => ({
        country: m._id || 'Unknown',
        count: m.count,
        avgRating: m.avgRating?.toFixed(1) || '0.0'
      })),
      recent: result.recent,
      withComments: result.withComments[0]?.count || 0,
      negative: result.negative[0]?.count || 0
    };
  }

  /**
   * Get reviews for a specific order
   */
  async getReviewByOrder(orderId) {
    await this.init();
    return this.db.collection(REVIEWS_COLLECTION).findOne({ orderId });
  }

  /**
   * Get reviews for a specific product (by ASIN/SKU from order items)
   * This requires linking to seller_orders collection
   */
  async getReviewsByProduct(asin, options = {}) {
    await this.init();

    // First find orders with this ASIN
    const ordersWithAsin = await this.db.collection('seller_orders').find(
      { 'items.ASIN': asin },
      { projection: { amazonOrderId: 1 } }
    ).toArray();

    const orderIds = ordersWithAsin.map(o => o.amazonOrderId);

    if (orderIds.length === 0) return [];

    // Then find reviews for those orders
    return this.db.collection(REVIEWS_COLLECTION)
      .find({ orderId: { $in: orderIds } })
      .sort({ feedbackDate: -1 })
      .limit(options.limit || 20)
      .toArray();
  }

  /**
   * Get product review summary (aggregate reviews by product)
   */
  async getProductReviewSummary(asin) {
    await this.init();

    // Find orders with this ASIN
    const ordersWithAsin = await this.db.collection('seller_orders').find(
      { 'items.ASIN': asin },
      { projection: { amazonOrderId: 1, marketplaceId: 1, marketplaceCountry: 1 } }
    ).toArray();

    const orderIds = ordersWithAsin.map(o => o.amazonOrderId);
    if (orderIds.length === 0) {
      return { total: 0, avgRating: 0, byRating: {}, byMarketplace: [] };
    }

    // Aggregate reviews
    const pipeline = [
      { $match: { orderId: { $in: orderIds } } },
      {
        $facet: {
          total: [{ $count: 'count' }],
          average: [{ $group: { _id: null, avg: { $avg: '$rating' } } }],
          byRating: [
            { $group: { _id: '$rating', count: { $sum: 1 } } },
            { $sort: { _id: -1 } }
          ],
          byMarketplace: [
            { $group: { _id: '$marketplaceCountry', count: { $sum: 1 }, avg: { $avg: '$rating' } } }
          ]
        }
      }
    ];

    const [result] = await this.db.collection(REVIEWS_COLLECTION).aggregate(pipeline).toArray();

    return {
      asin,
      total: result.total[0]?.count || 0,
      avgRating: result.average[0]?.avg?.toFixed(1) || '0.0',
      byRating: result.byRating.reduce((acc, r) => {
        acc[r._id] = r.count;
        return acc;
      }, {}),
      byMarketplace: result.byMarketplace.map(m => ({
        country: m._id || 'Unknown',
        count: m.count,
        avgRating: m.avg?.toFixed(1) || '0.0'
      }))
    };
  }

  /**
   * Run full sync: request report if needed, process pending reports
   */
  async sync() {
    await this.init();

    const result = {
      reportRequested: false,
      reportProcessed: false,
      reviewsImported: 0,
      errors: []
    };

    // Check if we have a recent pending report
    const recentReport = await this.db.collection(REPORTS_COLLECTION).findOne({
      reportType: FEEDBACK_REPORT,
      processed: false,
      requestedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Within 24 hours
    });

    // If no recent report, request one
    if (!recentReport) {
      const reportResult = await this.requestReport();
      result.reportRequested = reportResult.success;
      if (!reportResult.success) {
        result.errors.push(reportResult.error);
      }
    }

    // Process any pending reports
    const processResult = await this.processReports();
    result.reportProcessed = processResult.processed > 0;
    result.reviewsImported = processResult.reviewsImported;
    result.errors.push(...processResult.errors);

    return result;
  }

  /**
   * Get sync status
   */
  async getStatus() {
    await this.init();

    const lastReport = await this.db.collection(REPORTS_COLLECTION)
      .findOne(
        { reportType: FEEDBACK_REPORT },
        { sort: { requestedAt: -1 } }
      );

    const lastSync = await this.db.collection(REVIEWS_COLLECTION)
      .findOne({}, { sort: { updatedAt: -1 }, projection: { updatedAt: 1 } });

    const totalReviews = await this.db.collection(REVIEWS_COLLECTION).countDocuments();

    return {
      lastReportRequest: lastReport?.requestedAt || null,
      lastReportStatus: lastReport?.processed ? 'processed' : (lastReport?.status || 'none'),
      lastSync: lastSync?.updatedAt || null,
      totalReviews
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton instance
 */
async function getSellerReviewsSync() {
  if (!instance) {
    instance = new SellerReviewsSync();
    await instance.init();
  }
  return instance;
}

module.exports = {
  SellerReviewsSync,
  getSellerReviewsSync,
  FEEDBACK_REPORT,
  REVIEWS_COLLECTION
};
