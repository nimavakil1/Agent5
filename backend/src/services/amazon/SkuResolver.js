/**
 * Amazon SKU Resolver Service
 *
 * Converts Amazon Seller SKU to Odoo internal reference (default_code)
 *
 * SKU Patterns:
 * 1. Direct match: "18011" → "18011"
 * 2. FBM suffix: "18011-FBM" → "18011" (strip -FBM)
 * 3. FBMA suffix: "18011-FBMA" → "18011" (strip -FBMA)
 * 4. Custom mapping: "18009A" → "18009" (stored in database)
 * 5. Returns pattern: Regex-based (configurable)
 */

const { getDb } = require('../../db');

class SkuResolver {
  constructor() {
    this.customMappings = new Map();
    this.returnPatterns = [];
    this.loaded = false;
  }

  /**
   * Load custom mappings and patterns from database
   */
  async load() {
    try {
      const db = getDb();
      if (!db) {
        console.warn('[SkuResolver] Database not connected');
        return;
      }

      // Load custom mappings
      const mappings = await db.collection('amazon_sku_mappings').find({}).toArray();
      for (const m of mappings) {
        this.customMappings.set(m.amazonSku.toUpperCase(), m.odooSku);
      }

      // Load return patterns
      const config = await db.collection('amazon_config').findOne({ type: 'sku_patterns' });
      if (config && config.returnPatterns) {
        this.returnPatterns = config.returnPatterns.map(p => ({
          regex: new RegExp(p.pattern, p.flags || 'i'),
          extractGroup: p.extractGroup || 1
        }));
      }

      this.loaded = true;
      console.log(`[SkuResolver] Loaded ${this.customMappings.size} custom mappings, ${this.returnPatterns.length} return patterns`);
    } catch (error) {
      console.error('[SkuResolver] Load error:', error);
    }
  }

  /**
   * Resolve Amazon SKU to Odoo SKU
   * @param {string} amazonSku - The Seller SKU from Amazon
   * @returns {object} { odooSku, fulfillmentType, isReturn, originalSku }
   */
  resolve(amazonSku) {
    if (!amazonSku) {
      return { odooSku: null, fulfillmentType: 'unknown', isReturn: false, originalSku: amazonSku };
    }

    const original = amazonSku.trim();
    const upper = original.toUpperCase();

    // Step 1: Check custom mapping first (highest priority)
    if (this.customMappings.has(upper)) {
      return {
        odooSku: this.customMappings.get(upper),
        fulfillmentType: upper.includes('-FBM') ? 'FBM' : 'FBA',
        isReturn: false,
        originalSku: original,
        matchType: 'custom_mapping'
      };
    }

    // Step 2: Check return patterns
    for (const pattern of this.returnPatterns) {
      const match = original.match(pattern.regex);
      if (match) {
        const extractedSku = match[pattern.extractGroup] || match[1];
        // Recursively resolve the extracted SKU
        const resolved = this.resolve(extractedSku);
        return {
          ...resolved,
          isReturn: true,
          originalSku: original,
          matchType: 'return_pattern'
        };
      }
    }

    // Step 3: Strip known suffixes
    let sku = original;
    let fulfillmentType = 'FBA';

    // FBM suffixes
    if (upper.endsWith('-FBMA')) {
      sku = original.slice(0, -5); // Remove "-FBMA"
      fulfillmentType = 'FBM';
    } else if (upper.endsWith('-FBM')) {
      sku = original.slice(0, -4); // Remove "-FBM"
      fulfillmentType = 'FBM';
    }

    // Other common suffixes to strip (case insensitive)
    const suffixesToStrip = ['-stickerless', '-stickered', '-bundle', '-new', '-refurb'];
    for (const suffix of suffixesToStrip) {
      if (sku.toLowerCase().endsWith(suffix)) {
        sku = sku.slice(0, -suffix.length);
        break;
      }
    }

    // Step 4: Strip trailing "A" suffix only (Amazon variation pattern)
    // Only strip for 5-digit SKUs with trailing A: "01023A" → "01023", "09002A" → "09002"
    // Do NOT strip B/C/K/S/W etc. - these are usually color/variant codes
    if (/^[0-9]{5}A$/i.test(sku)) {
      sku = sku.slice(0, -1);
    }

    // Step 5: Pad with leading zeros to 5 digits if it looks like a numeric SKU
    // e.g., "1006" → "01006", "9002" → "09002"
    if (/^[0-9]{1,4}$/.test(sku)) {
      sku = sku.padStart(5, '0');
    }

    // Step 6: Check if the cleaned SKU needs custom mapping
    if (this.customMappings.has(sku.toUpperCase())) {
      return {
        odooSku: this.customMappings.get(sku.toUpperCase()),
        fulfillmentType,
        isReturn: false,
        originalSku: original,
        matchType: 'custom_mapping_after_strip'
      };
    }

    // Step 5: Direct use (no mapping needed)
    return {
      odooSku: sku,
      fulfillmentType,
      isReturn: false,
      originalSku: original,
      matchType: 'direct'
    };
  }

  /**
   * Bulk resolve multiple SKUs
   * @param {string[]} amazonSkus
   * @returns {Map<string, object>}
   */
  resolveMany(amazonSkus) {
    const results = new Map();
    for (const sku of amazonSkus) {
      results.set(sku, this.resolve(sku));
    }
    return results;
  }

  /**
   * Add a custom mapping
   * @param {string} amazonSku
   * @param {string} odooSku
   */
  async addMapping(amazonSku, odooSku) {
    const db = getDb();
    if (!db) throw new Error('Database not connected');

    await db.collection('amazon_sku_mappings').updateOne(
      { amazonSku: amazonSku.toUpperCase() },
      {
        $set: {
          amazonSku: amazonSku.toUpperCase(),
          odooSku,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    this.customMappings.set(amazonSku.toUpperCase(), odooSku);
  }

  /**
   * Add a return pattern
   * @param {string} pattern - Regex pattern
   * @param {number} extractGroup - Which capture group contains the SKU
   * @param {string} flags - Regex flags
   */
  async addReturnPattern(pattern, extractGroup = 1, flags = 'i') {
    const db = getDb();
    if (!db) throw new Error('Database not connected');

    await db.collection('amazon_config').updateOne(
      { type: 'sku_patterns' },
      {
        $push: {
          returnPatterns: { pattern, extractGroup, flags }
        },
        $set: { updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    this.returnPatterns.push({
      regex: new RegExp(pattern, flags),
      extractGroup
    });
  }

  /**
   * Get all custom mappings
   */
  getMappings() {
    return Array.from(this.customMappings.entries()).map(([amazonSku, odooSku]) => ({
      amazonSku,
      odooSku
    }));
  }

  /**
   * Get all return patterns
   */
  getReturnPatterns() {
    return this.returnPatterns.map(p => ({
      pattern: p.regex.source,
      flags: p.regex.flags,
      extractGroup: p.extractGroup
    }));
  }

  /**
   * Delete a custom mapping
   */
  async deleteMapping(amazonSku) {
    const db = getDb();
    if (!db) throw new Error('Database not connected');

    await db.collection('amazon_sku_mappings').deleteOne({
      amazonSku: amazonSku.toUpperCase()
    });
    this.customMappings.delete(amazonSku.toUpperCase());
  }

  /**
   * Import mappings from CSV/array
   * @param {Array<{amazonSku: string, odooSku: string}>} mappings
   */
  async importMappings(mappings) {
    const db = getDb();
    if (!db) throw new Error('Database not connected');

    const operations = mappings.map(m => ({
      updateOne: {
        filter: { amazonSku: m.amazonSku.toUpperCase() },
        update: {
          $set: {
            amazonSku: m.amazonSku.toUpperCase(),
            odooSku: m.odooSku,
            updatedAt: new Date()
          },
          $setOnInsert: { createdAt: new Date() }
        },
        upsert: true
      }
    }));

    if (operations.length > 0) {
      await db.collection('amazon_sku_mappings').bulkWrite(operations);
    }

    // Reload
    await this.load();
    return { imported: mappings.length };
  }
}

// Singleton instance
const skuResolver = new SkuResolver();

module.exports = { SkuResolver, skuResolver };
