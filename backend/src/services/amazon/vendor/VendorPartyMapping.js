/**
 * VendorPartyMapping - Map Amazon Vendor Central party IDs to Odoo partners
 *
 * This service manages the mapping between Amazon party codes (BRE4, XDT8, etc.)
 * and Odoo res.partner records. This ensures:
 * - No automatic partner creation in Odoo
 * - Explicit control over which party maps to which partner
 * - Proper VAT numbers and addresses for invoicing
 *
 * @module VendorPartyMapping
 */

const { getDb } = require('../../../db');
const { OdooDirectClient } = require('../../../core/agents/integrations/OdooMCP');

const COLLECTION_NAME = 'vendor_party_mapping';

/**
 * Party types
 */
const PARTY_TYPES = {
  SHIP_TO: 'shipTo',
  BILL_TO: 'billTo',
  BUYING: 'buying',
  SELLING: 'selling'
};

class VendorPartyMapping {
  constructor() {
    this.db = null;
    this.cache = new Map(); // partyId -> mapping
  }

  /**
   * Initialize the service
   */
  async init() {
    this.db = getDb();
    await this.ensureIndexes();
    await this.loadCache();
    return this;
  }

  /**
   * Ensure MongoDB indexes exist
   */
  async ensureIndexes() {
    const collection = this.db.collection(COLLECTION_NAME);

    await collection.createIndexes([
      { key: { partyId: 1 }, unique: true },
      { key: { odooPartnerId: 1 } },
      { key: { partyType: 1 } },
      { key: { marketplace: 1 } },
      { key: { active: 1 } }
    ]);
  }

  /**
   * Load all mappings into cache for fast lookup
   */
  async loadCache() {
    const collection = this.db.collection(COLLECTION_NAME);
    const mappings = await collection.find({ active: true }).toArray();

    this.cache.clear();
    for (const m of mappings) {
      this.cache.set(m.partyId, m);
    }

    console.log(`[VendorPartyMapping] Loaded ${this.cache.size} active mappings into cache`);
  }

  /**
   * Get mapping for a party ID
   * @param {string} partyId - Amazon party code (e.g., "BRE4")
   * @returns {object|null} Mapping or null if not found
   */
  getMapping(partyId) {
    return this.cache.get(partyId) || null;
  }

  /**
   * Get Odoo partner ID for a party ID
   * @param {string} partyId - Amazon party code
   * @returns {number|null} Odoo partner ID or null
   */
  getOdooPartnerId(partyId) {
    const mapping = this.getMapping(partyId);
    return mapping?.odooPartnerId || null;
  }

  /**
   * Check if a party ID is mapped
   * @param {string} partyId - Amazon party code
   * @returns {boolean}
   */
  isMapped(partyId) {
    return this.cache.has(partyId);
  }

  /**
   * Get all mappings
   * @param {object} filters - Optional filters
   * @returns {Array} All mappings
   */
  async getAllMappings(filters = {}) {
    const collection = this.db.collection(COLLECTION_NAME);

    const query = {};
    if (filters.partyType) query.partyType = filters.partyType;
    if (filters.marketplace) query.marketplace = filters.marketplace;
    if (filters.active !== undefined) query.active = filters.active;

    return collection.find(query).sort({ partyId: 1 }).toArray();
  }

  /**
   * Create or update a mapping
   * @param {object} mapping - Mapping data
   */
  async upsertMapping(mapping) {
    const collection = this.db.collection(COLLECTION_NAME);

    const doc = {
      partyId: mapping.partyId,
      partyType: mapping.partyType || PARTY_TYPES.SHIP_TO,
      marketplace: mapping.marketplace || null,
      odooPartnerId: mapping.odooPartnerId,
      odooPartnerName: mapping.odooPartnerName || null,
      vatNumber: mapping.vatNumber || null,
      address: mapping.address || null,
      country: mapping.country || null,
      notes: mapping.notes || null,
      active: mapping.active !== false,
      updatedAt: new Date()
    };

    await collection.updateOne(
      { partyId: mapping.partyId },
      {
        $set: doc,
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    // Update cache
    if (doc.active) {
      this.cache.set(doc.partyId, doc);
    } else {
      this.cache.delete(doc.partyId);
    }

    return doc;
  }

  /**
   * Delete a mapping
   * @param {string} partyId - Party ID to delete
   */
  async deleteMapping(partyId) {
    const collection = this.db.collection(COLLECTION_NAME);
    await collection.deleteOne({ partyId });
    this.cache.delete(partyId);
  }

  /**
   * Deactivate a mapping (soft delete)
   * @param {string} partyId - Party ID to deactivate
   */
  async deactivateMapping(partyId) {
    const collection = this.db.collection(COLLECTION_NAME);
    await collection.updateOne(
      { partyId },
      { $set: { active: false, updatedAt: new Date() } }
    );
    this.cache.delete(partyId);
  }

  /**
   * Import mappings from existing Odoo partners
   * Searches for partners with names like "Amazon EU SARL {partyId}"
   * @param {object} options - Import options
   * @returns {object} Import results
   */
  async importFromOdoo(options = {}) {
    const { dryRun = false, overwrite = false } = options;

    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    const results = {
      found: 0,
      imported: 0,
      skipped: 0,
      errors: [],
      mappings: []
    };

    // Search for Amazon partners in Odoo
    // Pattern: "Amazon EU SARL {CODE}" or "AMAZON EU SARL {CODE}"
    const amazonPartners = await odoo.searchRead('res.partner',
      [['name', 'ilike', 'Amazon EU SARL']],
      ['id', 'name', 'vat', 'street', 'street2', 'city', 'zip', 'country_id', 'ref'],
      { limit: 500 }
    );

    results.found = amazonPartners.length;
    console.log(`[VendorPartyMapping] Found ${amazonPartners.length} Amazon partners in Odoo`);

    // Extract party IDs from partner names
    // Pattern: "Amazon EU SARL BRE4" -> partyId = "BRE4"
    const partyIdRegex = /Amazon\s+EU\s+SARL\s+(\w+)/i;

    for (const partner of amazonPartners) {
      try {
        const match = partner.name.match(partyIdRegex);
        if (!match) {
          // Try to get partyId from ref field
          const partyId = partner.ref?.split('/')?.pop() || null;
          if (!partyId) {
            continue; // Skip partners without identifiable party ID
          }
        }

        const partyId = match ? match[1] : partner.ref?.split('/')?.pop();
        if (!partyId || partyId.length < 2) continue;

        // Check if already exists
        const existing = this.getMapping(partyId);
        if (existing && !overwrite) {
          results.skipped++;
          continue;
        }

        // Build address string
        const addressParts = [
          partner.street,
          partner.street2,
          [partner.zip, partner.city].filter(Boolean).join(' ')
        ].filter(Boolean);

        const mapping = {
          partyId: partyId.toUpperCase(),
          partyType: PARTY_TYPES.SHIP_TO, // Default, can be updated later
          odooPartnerId: partner.id,
          odooPartnerName: partner.name,
          vatNumber: partner.vat || null,
          address: addressParts.join(', ') || null,
          country: partner.country_id ? partner.country_id[1] : null,
          notes: `Imported from Odoo partner ID ${partner.id}`,
          active: true
        };

        results.mappings.push(mapping);

        if (!dryRun) {
          await this.upsertMapping(mapping);
          results.imported++;
        }

      } catch (error) {
        results.errors.push(`Partner ${partner.id} (${partner.name}): ${error.message}`);
      }
    }

    if (dryRun) {
      console.log(`[VendorPartyMapping] Dry run: Would import ${results.mappings.length} mappings`);
    } else {
      console.log(`[VendorPartyMapping] Imported ${results.imported} mappings, skipped ${results.skipped}`);
    }

    return results;
  }

  /**
   * Get unmapped party IDs from existing vendor orders
   * @returns {Array} List of unmapped party IDs with usage counts
   */
  async getUnmappedPartyIds() {
    const ordersCollection = this.db.collection('vendor_purchase_orders');

    // Aggregate all unique party IDs from orders
    const partyIds = await ordersCollection.aggregate([
      {
        $project: {
          partyIds: [
            '$buyingParty.partyId',
            '$sellingParty.partyId',
            '$shipToParty.partyId',
            '$billToParty.partyId'
          ]
        }
      },
      { $unwind: '$partyIds' },
      { $match: { partyIds: { $ne: null } } },
      {
        $group: {
          _id: '$partyIds',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();

    // Filter to unmapped only
    const unmapped = partyIds.filter(p => !this.isMapped(p._id));

    return unmapped.map(p => ({
      partyId: p._id,
      usageCount: p.count,
      isMapped: false
    }));
  }

  /**
   * Get statistics about mappings
   */
  async getStats() {
    const collection = this.db.collection(COLLECTION_NAME);

    const stats = await collection.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ['$active', 1, 0] } },
          inactive: { $sum: { $cond: ['$active', 0, 1] } },
          withVat: { $sum: { $cond: [{ $ne: ['$vatNumber', null] }, 1, 0] } },
          withAddress: { $sum: { $cond: [{ $ne: ['$address', null] }, 1, 0] } }
        }
      }
    ]).toArray();

    const unmapped = await this.getUnmappedPartyIds();

    return {
      ...(stats[0] || { total: 0, active: 0, inactive: 0, withVat: 0, withAddress: 0 }),
      unmappedCount: unmapped.length,
      unmappedPartyIds: unmapped.slice(0, 20) // Top 20 unmapped
    };
  }

  /**
   * Search Odoo partners for potential matches
   * @param {string} searchTerm - Search term
   * @returns {Array} Matching partners
   */
  async searchOdooPartners(searchTerm) {
    const odoo = new OdooDirectClient();
    await odoo.authenticate();

    const partners = await odoo.searchRead('res.partner',
      [['name', 'ilike', searchTerm]],
      ['id', 'name', 'vat', 'street', 'city', 'country_id'],
      { limit: 20 }
    );

    return partners.map(p => ({
      id: p.id,
      name: p.name,
      vat: p.vat,
      address: [p.street, p.city].filter(Boolean).join(', '),
      country: p.country_id ? p.country_id[1] : null
    }));
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the VendorPartyMapping instance
 */
async function getVendorPartyMapping() {
  if (!instance) {
    instance = new VendorPartyMapping();
    await instance.init();
  }
  return instance;
}

module.exports = {
  VendorPartyMapping,
  getVendorPartyMapping,
  COLLECTION_NAME,
  PARTY_TYPES
};
