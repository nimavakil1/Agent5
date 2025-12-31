/**
 * AmazonProductMapper - Manages Amazon ASIN to Odoo product mappings
 *
 * This is our own mapping table, independent of Emipro modules.
 * Supports:
 * - ASIN to Odoo product lookups
 * - Multiple marketplaces per ASIN
 * - Seller SKU tracking
 * - Barcode/EAN associations
 */

const { getDb } = require('../../db');

const COLLECTION_NAME = 'amazon_product_mappings';

/**
 * Marketplace codes used in mapping
 */
const MARKETPLACES = {
  DE: 'DE',
  FR: 'FR',
  UK: 'UK',
  IT: 'IT',
  ES: 'ES',
  NL: 'NL',
  BE: 'BE',
  PL: 'PL',
  SE: 'SE',
  ALL: 'ALL' // Global/default mapping
};

class AmazonProductMapper {
  constructor() {
    this.db = null;
  }

  async init() {
    this.db = getDb();
    await this.ensureIndexes();
    return this;
  }

  async ensureIndexes() {
    const collection = this.db.collection(COLLECTION_NAME);
    await collection.createIndexes([
      { key: { asin: 1, marketplace: 1 }, unique: true },
      { key: { asin: 1 } },
      { key: { odooProductId: 1 } },
      { key: { odooSku: 1 } },
      { key: { sellerSku: 1 } },
      { key: { barcode: 1 } }
    ]);
  }

  /**
   * Find Odoo product by ASIN
   * First tries exact marketplace match, then falls back to 'ALL'
   *
   * @param {string} asin - Amazon ASIN
   * @param {string} marketplace - Marketplace code (DE, FR, etc.)
   * @returns {Object|null} Mapping with odooProductId, odooSku, etc.
   */
  async findByAsin(asin, marketplace = 'ALL') {
    const collection = this.db.collection(COLLECTION_NAME);

    // Try exact marketplace match first
    let mapping = await collection.findOne({
      asin,
      marketplace,
      active: { $ne: false }
    });

    // Fallback to 'ALL' (global) mapping
    if (!mapping && marketplace !== 'ALL') {
      mapping = await collection.findOne({
        asin,
        marketplace: 'ALL',
        active: { $ne: false }
      });
    }

    // Fallback to any marketplace
    if (!mapping) {
      mapping = await collection.findOne({
        asin,
        active: { $ne: false }
      });
    }

    return mapping;
  }

  /**
   * Find Odoo product by barcode/EAN
   *
   * @param {string} barcode - EAN or barcode
   * @returns {Object|null} Mapping
   */
  async findByBarcode(barcode) {
    const collection = this.db.collection(COLLECTION_NAME);
    return await collection.findOne({
      barcode,
      active: { $ne: false }
    });
  }

  /**
   * Find all mappings for an Odoo product
   *
   * @param {number} odooProductId - Odoo product.product ID
   * @returns {Array} All mappings for this product
   */
  async findByOdooProduct(odooProductId) {
    const collection = this.db.collection(COLLECTION_NAME);
    return await collection.find({
      odooProductId,
      active: { $ne: false }
    }).toArray();
  }

  /**
   * Create or update a mapping
   *
   * @param {Object} data - Mapping data
   * @returns {Object} Result with upserted document
   */
  async upsertMapping(data) {
    const collection = this.db.collection(COLLECTION_NAME);

    const { asin, marketplace = 'ALL' } = data;
    if (!asin) {
      throw new Error('ASIN is required');
    }

    const now = new Date();
    const updateData = {
      asin,
      marketplace,
      odooProductId: data.odooProductId,
      odooSku: data.odooSku,
      odooProductName: data.odooProductName,
      sellerSku: data.sellerSku,
      barcode: data.barcode,
      fulfillmentBy: data.fulfillmentBy || 'FBM',
      active: data.active !== false,
      updatedAt: now
    };

    const result = await collection.updateOne(
      { asin, marketplace },
      {
        $set: updateData,
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );

    return {
      upserted: result.upsertedCount > 0,
      modified: result.modifiedCount > 0,
      asin,
      marketplace
    };
  }

  /**
   * Delete a mapping
   *
   * @param {string} asin - Amazon ASIN
   * @param {string} marketplace - Marketplace code
   * @returns {boolean} True if deleted
   */
  async deleteMapping(asin, marketplace = 'ALL') {
    const collection = this.db.collection(COLLECTION_NAME);
    const result = await collection.deleteOne({ asin, marketplace });
    return result.deletedCount > 0;
  }

  /**
   * Soft delete (deactivate) a mapping
   */
  async deactivateMapping(asin, marketplace = 'ALL') {
    const collection = this.db.collection(COLLECTION_NAME);
    const result = await collection.updateOne(
      { asin, marketplace },
      { $set: { active: false, updatedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Get all mappings with pagination
   *
   * @param {Object} options - Query options
   * @returns {Object} { mappings, total, page, pageSize }
   */
  async getMappings(options = {}) {
    const collection = this.db.collection(COLLECTION_NAME);
    const {
      page = 1,
      pageSize = 50,
      search = '',
      marketplace = null,
      includeInactive = false
    } = options;

    const query = {};

    if (!includeInactive) {
      query.active = { $ne: false };
    }

    if (marketplace) {
      query.marketplace = marketplace;
    }

    if (search) {
      query.$or = [
        { asin: { $regex: search, $options: 'i' } },
        { odooSku: { $regex: search, $options: 'i' } },
        { sellerSku: { $regex: search, $options: 'i' } },
        { odooProductName: { $regex: search, $options: 'i' } },
        { barcode: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (page - 1) * pageSize;
    const [mappings, total] = await Promise.all([
      collection.find(query)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(query)
    ]);

    return {
      mappings,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  /**
   * Get mapping statistics
   */
  async getStats() {
    const collection = this.db.collection(COLLECTION_NAME);

    const [total, byMarketplace, uniqueAsins, uniqueProducts] = await Promise.all([
      collection.countDocuments({ active: { $ne: false } }),
      collection.aggregate([
        { $match: { active: { $ne: false } } },
        { $group: { _id: '$marketplace', count: { $sum: 1 } } }
      ]).toArray(),
      collection.distinct('asin', { active: { $ne: false } }),
      collection.distinct('odooProductId', { active: { $ne: false } })
    ]);

    return {
      totalMappings: total,
      uniqueAsins: uniqueAsins.length,
      uniqueProducts: uniqueProducts.length,
      byMarketplace: Object.fromEntries(
        byMarketplace.map(m => [m._id, m.count])
      )
    };
  }

  /**
   * Import mappings in bulk
   *
   * @param {Array} mappings - Array of mapping objects
   * @returns {Object} Import result stats
   */
  async bulkImport(mappings) {
    const collection = this.db.collection(COLLECTION_NAME);
    const now = new Date();

    let inserted = 0;
    let updated = 0;
    let errors = [];

    for (const mapping of mappings) {
      try {
        const result = await this.upsertMapping(mapping);
        if (result.upserted) {
          inserted++;
        } else if (result.modified) {
          updated++;
        }
      } catch (err) {
        errors.push({ mapping, error: err.message });
      }
    }

    return { inserted, updated, errors, total: mappings.length };
  }
}

// Singleton instance
let instance = null;

async function getAmazonProductMapper() {
  if (!instance) {
    instance = new AmazonProductMapper();
    await instance.init();
  }
  return instance;
}

module.exports = {
  AmazonProductMapper,
  getAmazonProductMapper,
  MARKETPLACES
};
