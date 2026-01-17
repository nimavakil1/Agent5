/**
 * FbmStockFallbackGenerator - Generate TSV files for manual Amazon upload
 *
 * When the automated FBM stock sync fails, this generates an Amazon-compatible
 * TSV file that can be manually uploaded to Seller Central.
 *
 * File format: Tab-separated values with Amazon inventory template headers
 *
 * @module FbmStockFallbackGenerator
 */

const oneDriveService = require('../../onedriveService');

// OneDrive folder for fallback files
const FALLBACK_FOLDER = process.env.FBM_STOCK_FALLBACK_FOLDER || 'FBM_Stock_Fallback';

/**
 * FbmStockFallbackGenerator - Creates Amazon-compatible TSV files for manual upload
 */
class FbmStockFallbackGenerator {
  constructor() {
    // Default fulfillment latency (days to ship)
    this.defaultFulfillmentLatency = 3;
  }

  /**
   * Generate TSV content from stock items
   * Format compatible with Amazon Seller Central inventory upload
   *
   * @param {Array} stockItems - Array of { sellerSku, quantity, fulfillmentLatency }
   * @returns {string} TSV content
   */
  generateTsv(stockItems) {
    // Amazon inventory file headers
    const headers = ['sku', 'quantity', 'fulfillment-latency'];
    const lines = [headers.join('\t')];

    for (const item of stockItems) {
      const row = [
        this.escapeTsvValue(item.sellerSku || item.amazonSku || ''),
        String(item.quantity ?? 0),
        String(item.fulfillmentLatency || this.defaultFulfillmentLatency)
      ];
      lines.push(row.join('\t'));
    }

    return lines.join('\n');
  }

  /**
   * Generate TSV from sync results (including failed items)
   * @param {Object} syncResults - Results from SellerFbmStockExport.syncStock()
   * @returns {string} TSV content
   */
  generateTsvFromSyncResults(syncResults) {
    const stockItems = [];

    // Use detailed results if available
    if (syncResults.detailedResults && syncResults.detailedResults.length > 0) {
      for (const item of syncResults.detailedResults) {
        stockItems.push({
          sellerSku: item.amazonSku,
          quantity: item.newAmazonQty,
          fulfillmentLatency: 3
        });
      }
    } else if (syncResults.stockItems && syncResults.stockItems.length > 0) {
      // Fall back to stockItems
      stockItems.push(...syncResults.stockItems);
    }

    return this.generateTsv(stockItems);
  }

  /**
   * Escape special characters for TSV
   */
  escapeTsvValue(value) {
    if (typeof value !== 'string') return String(value);

    // If value contains tab, newline, or double quote, wrap in quotes and escape internal quotes
    if (value.includes('\t') || value.includes('\n') || value.includes('"')) {
      return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
  }

  /**
   * Generate TSV buffer
   * @param {Array} stockItems - Array of stock items
   * @returns {Buffer} TSV file buffer
   */
  generateTsvBuffer(stockItems) {
    const content = this.generateTsv(stockItems);
    return Buffer.from(content, 'utf-8');
  }

  /**
   * Upload TSV file to OneDrive
   * @param {Buffer|string} content - TSV content (string or buffer)
   * @param {string} filename - Filename for the TSV file
   * @returns {Object} { success, url, fileId, error }
   */
  async uploadToOneDrive(content, filename) {
    try {
      if (!oneDriveService.graphClient) {
        console.log('[FbmStockFallbackGenerator] OneDrive not configured, skipping upload');
        return { success: false, error: 'OneDrive not configured' };
      }

      // Create folder structure: /FBM_Stock_Fallback/YYYY/MM/
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const folderPath = `/${FALLBACK_FOLDER}/${year}/${month}`;

      await oneDriveService.ensureFolderExists(folderPath);

      const remotePath = `${folderPath}/${filename}`;
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');

      // Upload file
      const uploadedFile = await oneDriveService.graphClient
        .api(`/me/drive/root:${remotePath}:/content`)
        .put(buffer);

      // Create sharing link
      const sharingLink = await oneDriveService.graphClient
        .api(`/me/drive/items/${uploadedFile.id}/createLink`)
        .post({
          type: 'view',
          scope: 'organization'
        });

      console.log(`[FbmStockFallbackGenerator] TSV uploaded to OneDrive: ${filename}`);

      return {
        success: true,
        url: sharingLink.link.webUrl,
        fileId: uploadedFile.id
      };
    } catch (error) {
      console.error('[FbmStockFallbackGenerator] OneDrive upload failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate and upload fallback TSV file
   * @param {Object} syncResults - Results from SellerFbmStockExport.syncStock()
   * @param {string} errorReason - Reason for generating fallback
   * @returns {Object} { success, url, filename, itemCount, error }
   */
  async generateAndUploadFallback(syncResults, errorReason = 'sync_failed') {
    const result = {
      success: false,
      url: null,
      filename: null,
      itemCount: 0,
      error: null
    };

    try {
      // Generate TSV content
      const tsvContent = this.generateTsvFromSyncResults(syncResults);
      const lines = tsvContent.split('\n');
      result.itemCount = lines.length - 1; // Exclude header

      if (result.itemCount === 0) {
        result.error = 'No stock items to export';
        return result;
      }

      // Generate filename
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `FBM_Stock_Fallback_${timestamp}.tsv`;
      result.filename = filename;

      // Upload to OneDrive
      const uploadResult = await this.uploadToOneDrive(tsvContent, filename);

      if (uploadResult.success) {
        result.success = true;
        result.url = uploadResult.url;
        console.log(`[FbmStockFallbackGenerator] Fallback TSV generated: ${filename} (${result.itemCount} items)`);
      } else {
        result.error = uploadResult.error;
      }

      return result;

    } catch (error) {
      console.error('[FbmStockFallbackGenerator] Fallback generation failed:', error.message);
      result.error = error.message;
      return result;
    }
  }

  /**
   * Generate full fallback file from FBM listings when sync completely fails
   * Use this when we can't even calculate new quantities
   * @param {Array} fbmListings - Raw FBM listings from Amazon
   * @param {Map} stockMap - Map of SKU to quantity (from Odoo)
   * @returns {string} TSV content
   */
  generateFromListingsAndStock(fbmListings, stockMap) {
    const stockItems = [];

    for (const listing of fbmListings) {
      const sku = listing.sellerSku;
      const quantity = stockMap.get(sku) ?? listing.quantity ?? 0;

      stockItems.push({
        sellerSku: sku,
        quantity: Math.max(0, quantity),
        fulfillmentLatency: 3
      });
    }

    return this.generateTsv(stockItems);
  }
}

// Singleton instance
let fallbackGeneratorInstance = null;

/**
 * Get the singleton FbmStockFallbackGenerator instance
 */
function getFbmStockFallbackGenerator() {
  if (!fallbackGeneratorInstance) {
    fallbackGeneratorInstance = new FbmStockFallbackGenerator();
  }
  return fallbackGeneratorInstance;
}

module.exports = {
  FbmStockFallbackGenerator,
  getFbmStockFallbackGenerator
};
