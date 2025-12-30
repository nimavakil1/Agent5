/**
 * Amazon Ads Module
 *
 * Exports all Amazon Advertising API components.
 *
 * @module amazon/ads
 */

const { AmazonAdsClient, ENDPOINTS, CAMPAIGN_TYPE, SP_REPORT_TYPES } = require('./AmazonAdsClient');
const { AmazonAdsImporter, getAmazonAdsImporter, COLLECTIONS } = require('./AmazonAdsImporter');

module.exports = {
  // Client
  AmazonAdsClient,
  ENDPOINTS,
  CAMPAIGN_TYPE,
  SP_REPORT_TYPES,

  // Importer
  AmazonAdsImporter,
  getAmazonAdsImporter,
  COLLECTIONS
};
