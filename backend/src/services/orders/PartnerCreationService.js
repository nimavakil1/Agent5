/**
 * PartnerCreationService - Unified Odoo partner creation for all marketplaces
 *
 * Creates consistent res.partner records from marketplace orders.
 * Uses a single partner structure (not parent/child) with combined name format.
 *
 * Partner name format:
 * - B2B: "Company Name - Contact Person"
 * - B2C: "Contact Person"
 *
 * @module PartnerCreationService
 */

const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const { getAddressCleaningService } = require('./AddressCleaningService');

// Country code to Odoo country ID mapping
const COUNTRY_IDS = {
  'NL': 165,  // Netherlands
  'BE': 20,   // Belgium
  'DE': 57,   // Germany
  'FR': 75,   // France
  'AT': 14,   // Austria
  'IT': 109,  // Italy (was 107 which is Iran - bug fix)
  'ES': 68,   // Spain
  'PL': 177,  // Poland
  'LU': 126,  // Luxembourg
  'CH': 43,   // Switzerland
};

/**
 * PartnerCreationService - Unified partner creation for marketplace orders
 */
class PartnerCreationService {
  constructor(odooClient = null) {
    this.odoo = odooClient || new OdooDirectClient();
    this.addressCleaner = getAddressCleaningService();
    this.partnerCache = {};
    this.countryIdCache = {};
  }

  /**
   * Initialize the service
   */
  async init() {
    if (!this.odoo.authenticated) {
      await this.odoo.authenticate();
    }
    return this;
  }

  /**
   * Build display name from company and contact person
   *
   * Format:
   * - B2B: "Company Name - Contact Person"
   * - B2C: "Contact Person"
   *
   * @param {string|null} company - Company name
   * @param {string|null} name - Contact person name
   * @returns {string} Display name
   */
  buildDisplayName(company, name) {
    const cleanCompany = company?.trim() || '';
    const cleanName = name?.trim() || '';

    if (cleanCompany && cleanName) {
      return `${cleanCompany} - ${cleanName}`;
    } else if (cleanCompany) {
      return cleanCompany;
    } else if (cleanName) {
      return cleanName;
    } else {
      return 'Unknown Customer';
    }
  }

  /**
   * Get Odoo country ID from country code
   *
   * @param {string} countryCode - 2-letter country code
   * @returns {Promise<number|null>} Odoo country ID
   */
  async getCountryId(countryCode) {
    if (!countryCode) return null;

    const code = countryCode.toUpperCase();

    // Check cache first
    if (this.countryIdCache[code]) {
      return this.countryIdCache[code];
    }

    // Check static mapping
    if (COUNTRY_IDS[code]) {
      this.countryIdCache[code] = COUNTRY_IDS[code];
      return COUNTRY_IDS[code];
    }

    // Search Odoo for unknown country codes
    try {
      const countries = await this.odoo.searchRead('res.country',
        [['code', '=', code]],
        ['id'],
        { limit: 1 }
      );
      if (countries.length > 0) {
        this.countryIdCache[code] = countries[0].id;
        return countries[0].id;
      }
    } catch (error) {
      console.error(`[PartnerCreationService] Error looking up country ${code}:`, error.message);
    }

    return null;
  }

  /**
   * Find existing partner by display name and postal code
   *
   * @param {string} displayName - Partner display name
   * @param {string} postalCode - Postal code for matching
   * @returns {Promise<number|null>} Partner ID if found
   */
  async findExistingPartner(displayName, postalCode) {
    if (!displayName) return null;

    // Check cache
    const cacheKey = `${displayName}|${postalCode || ''}`;
    if (this.partnerCache[cacheKey]) {
      return this.partnerCache[cacheKey];
    }

    // Search by name + postal code
    const domain = [['name', '=', displayName]];
    if (postalCode) {
      domain.push(['zip', '=', postalCode]);
    }

    const existing = await this.odoo.searchRead('res.partner', domain, ['id', 'name']);

    if (existing.length > 0) {
      this.partnerCache[cacheKey] = existing[0].id;
      return existing[0].id;
    }

    return null;
  }

  /**
   * Find or create a partner from raw address data
   *
   * This is the main entry point. It:
   * 1. Cleans the address using AI
   * 2. Searches for existing partner
   * 3. Creates new partner if not found
   *
   * @param {Object} rawAddress - Raw address data from marketplace
   * @param {Object} options - Additional options
   * @param {string} options.email - Customer email
   * @param {string} options.phone - Customer phone
   * @param {string} options.source - Source marketplace (amazon, bol, etc.)
   * @param {string} options.orderId - Order ID for comments
   * @returns {Promise<Object>} { partnerId, displayName, isNew, cleanedAddress }
   */
  async findOrCreatePartner(rawAddress, options = {}) {
    const { email, phone, source, orderId } = options;

    // Step 1: Clean address using AI
    const cleanedAddress = await this.addressCleaner.cleanAddress({
      ...rawAddress,
      source: source || rawAddress.source
    });

    // Step 2: Build display name
    const displayName = this.buildDisplayName(cleanedAddress.company, cleanedAddress.name);

    // Step 3: Check for existing partner
    const existingId = await this.findExistingPartner(displayName, cleanedAddress.zip);
    if (existingId) {
      return {
        partnerId: existingId,
        displayName,
        isNew: false,
        cleanedAddress
      };
    }

    // Step 4: Get country ID
    const countryId = await this.getCountryId(cleanedAddress.country);

    // Step 5: Create new partner
    const partnerData = {
      name: displayName,
      street: cleanedAddress.street || false,
      street2: cleanedAddress.street2 || false,
      zip: cleanedAddress.zip || false,
      city: cleanedAddress.city || false,
      country_id: countryId || false,
      email: email || false,
      phone: phone || false,
      customer_rank: 1,
      type: 'contact',
      comment: this._buildComment(source, orderId, cleanedAddress)
    };

    const partnerId = await this.odoo.create('res.partner', partnerData);

    // Cache the new partner
    const cacheKey = `${displayName}|${cleanedAddress.zip || ''}`;
    this.partnerCache[cacheKey] = partnerId;

    console.log(`[PartnerCreationService] Created partner ${partnerId}: ${displayName} (${source || 'unknown'})`);

    return {
      partnerId,
      displayName,
      isNew: true,
      cleanedAddress
    };
  }

  /**
   * Find or create a partner from already-cleaned address data
   *
   * Use this when address is already cleaned (e.g., from stored cleanedAddress).
   *
   * @param {Object} cleanedAddress - Already cleaned address
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} { partnerId, displayName, isNew }
   */
  async findOrCreatePartnerFromCleaned(cleanedAddress, options = {}) {
    const { email, phone, source, orderId } = options;

    // Build display name
    const displayName = this.buildDisplayName(cleanedAddress.company, cleanedAddress.name);

    // Check for existing partner
    const existingId = await this.findExistingPartner(displayName, cleanedAddress.zip);
    if (existingId) {
      return {
        partnerId: existingId,
        displayName,
        isNew: false
      };
    }

    // Get country ID
    const countryId = await this.getCountryId(cleanedAddress.country);

    // Create new partner
    const partnerData = {
      name: displayName,
      street: cleanedAddress.street || false,
      street2: cleanedAddress.street2 || false,
      zip: cleanedAddress.zip || false,
      city: cleanedAddress.city || false,
      country_id: countryId || false,
      email: email || false,
      phone: phone || false,
      customer_rank: 1,
      type: 'contact',
      comment: this._buildComment(source, orderId, cleanedAddress)
    };

    const partnerId = await this.odoo.create('res.partner', partnerData);

    // Cache the new partner
    const cacheKey = `${displayName}|${cleanedAddress.zip || ''}`;
    this.partnerCache[cacheKey] = partnerId;

    console.log(`[PartnerCreationService] Created partner ${partnerId}: ${displayName} (${source || 'unknown'})`);

    return {
      partnerId,
      displayName,
      isNew: true
    };
  }

  /**
   * Update an existing partner with new address data
   *
   * @param {number} partnerId - Odoo partner ID
   * @param {Object} cleanedAddress - Cleaned address data
   * @returns {Promise<boolean>} Success
   */
  async updatePartnerAddress(partnerId, cleanedAddress) {
    try {
      const displayName = this.buildDisplayName(cleanedAddress.company, cleanedAddress.name);
      const countryId = await this.getCountryId(cleanedAddress.country);

      await this.odoo.write('res.partner', [partnerId], {
        name: displayName,
        street: cleanedAddress.street || false,
        street2: cleanedAddress.street2 || false,
        zip: cleanedAddress.zip || false,
        city: cleanedAddress.city || false,
        country_id: countryId || false
      });

      console.log(`[PartnerCreationService] Updated partner ${partnerId}: ${displayName}`);
      return true;
    } catch (error) {
      console.error(`[PartnerCreationService] Error updating partner ${partnerId}:`, error.message);
      return false;
    }
  }

  /**
   * Build comment for partner record
   * @private
   */
  _buildComment(source, orderId, cleanedAddress) {
    const lines = [];

    if (source) {
      lines.push(`Source: ${source}`);
    }
    if (orderId) {
      lines.push(`First order: ${orderId}`);
    }
    if (cleanedAddress.isCompany) {
      lines.push('Type: B2B');
    }
    if (cleanedAddress.confidence && cleanedAddress.confidence !== 'high') {
      lines.push(`Address parsing confidence: ${cleanedAddress.confidence}`);
    }
    if (cleanedAddress.notes) {
      lines.push(`Notes: ${cleanedAddress.notes}`);
    }

    lines.push(`Created: ${new Date().toISOString()}`);

    return lines.join('\n');
  }

  /**
   * Clear the partner cache
   */
  clearCache() {
    this.partnerCache = {};
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the PartnerCreationService instance
 */
async function getPartnerCreationService(odooClient = null) {
  if (!instance) {
    instance = new PartnerCreationService(odooClient);
    await instance.init();
  }
  return instance;
}

module.exports = {
  PartnerCreationService,
  getPartnerCreationService,
  COUNTRY_IDS
};
