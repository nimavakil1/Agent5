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
const { LEGAL_TERMS_REGEX } = require('../amazon/seller/AddressCleaner');

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
   * - B2B: "Company Name - Contact Person - PO: 12345"
   * - B2C: "Contact Person"
   *
   * Also:
   * - Strips legal terms (GmbH, AG, e.V., etc.) from company name
   * - Removes duplicate parts (e.g., "Denis - Company - Denis" → "Company - Denis")
   * - Appends PO number if provided
   *
   * @param {string|null} company - Company name
   * @param {string|null} name - Contact person name
   * @param {string|null} poNumber - Optional PO number to append
   * @returns {string} Display name
   */
  buildDisplayName(company, name, poNumber = null) {
    // Strip legal terms from company name
    let cleanCompany = company?.trim() || '';
    if (cleanCompany) {
      cleanCompany = cleanCompany
        .replace(LEGAL_TERMS_REGEX, '')
        .replace(/\s+/g, ' ')
        .trim();
      // Reset regex lastIndex since it's global
      LEGAL_TERMS_REGEX.lastIndex = 0;
    }

    const cleanName = name?.trim() || '';

    let result;
    if (cleanCompany && cleanName) {
      result = `${cleanCompany} - ${cleanName}`;
    } else if (cleanCompany) {
      result = cleanCompany;
    } else if (cleanName) {
      result = cleanName;
    } else {
      return 'Unknown Customer';
    }

    // Remove duplicate parts (case-insensitive)
    result = this._removeDuplicateParts(result);

    // Append PO number if provided
    if (poNumber?.trim()) {
      result = `${result} - PO: ${poNumber.trim()}`;
    }

    return result;
  }

  /**
   * Remove duplicate parts from a name string
   * @param {string} name - Name with parts separated by " - "
   * @returns {string} Name with duplicates removed
   * @private
   */
  _removeDuplicateParts(name) {
    const parts = name.split(' - ').map(p => p.trim()).filter(Boolean);
    const seen = new Set();
    const uniqueParts = [];

    for (const part of parts) {
      const lowerPart = part.toLowerCase();
      if (!seen.has(lowerPart)) {
        seen.add(lowerPart);
        uniqueParts.push(part);
      }
    }

    return uniqueParts.join(' - ') || 'Unknown Customer';
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
   * Find or create a partner from address data
   *
   * This is the main entry point. It:
   * 1. Cleans the address using AI (unless skipCleaning is true)
   * 2. Searches for existing partner
   * 3. Creates new partner if not found
   *
   * @param {Object} addressData - Address data (raw or already cleaned)
   * @param {Object} options - Additional options
   * @param {string} options.email - Customer email
   * @param {string} options.phone - Customer phone
   * @param {string} options.source - Source marketplace (amazon, bol, etc.)
   * @param {string} options.orderId - Order ID for comments
   * @param {boolean} options.skipCleaning - If true, skip AI address cleaning (address already cleaned)
   * @returns {Promise<Object>} { partnerId, displayName, isNew, cleanedAddress }
   */
  async findOrCreatePartner(addressData, options = {}) {
    const { email, phone, source, orderId, skipCleaning = false } = options;

    // Step 1: Clean address using AI (unless already cleaned)
    const cleanedAddress = skipCleaning
      ? addressData
      : await this.addressCleaner.cleanAddress({
          ...addressData,
          source: source || addressData.source
        });

    // Step 2: Find or create the partner using cleaned address
    return this._findOrCreateFromCleanedAddress(cleanedAddress, { email, phone, source, orderId });
  }

  /**
   * @deprecated Use findOrCreatePartner(address, { skipCleaning: true }) instead
   * Kept for backward compatibility - will be removed in future version
   */
  async findOrCreatePartnerFromCleaned(cleanedAddress, options = {}) {
    console.warn('[PartnerCreationService] findOrCreatePartnerFromCleaned is deprecated. Use findOrCreatePartner(address, { skipCleaning: true }) instead.');
    return this.findOrCreatePartner(cleanedAddress, { ...options, skipCleaning: true });
  }

  /**
   * Internal method: Find or create partner from cleaned address data
   * Single source of truth for all partner creation logic
   * @private
   */
  async _findOrCreateFromCleanedAddress(cleanedAddress, options = {}) {
    const { email, phone, source, orderId } = options;

    // Build base name (without PO) for searching
    const baseName = this.buildDisplayName(cleanedAddress.company, cleanedAddress.name);

    // Check for existing partner (search without PO number)
    const existingId = await this.findExistingPartner(baseName, cleanedAddress.zip);
    if (existingId) {
      // Build full name with PO for the response
      const displayName = this.buildDisplayName(cleanedAddress.company, cleanedAddress.name, cleanedAddress.poNumber);
      return {
        partnerId: existingId,
        displayName,
        isNew: false,
        cleanedAddress
      };
    }

    // Get country ID
    const countryId = await this.getCountryId(cleanedAddress.country);

    // Build display name with PO number for the partner
    const displayName = this.buildDisplayName(cleanedAddress.company, cleanedAddress.name, cleanedAddress.poNumber);

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

    // Cache the new partner (cache by base name for future lookups)
    const cacheKey = `${baseName}|${cleanedAddress.zip || ''}`;
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
   * Update an existing partner with new address data
   *
   * @param {number} partnerId - Odoo partner ID
   * @param {Object} cleanedAddress - Cleaned address data
   * @returns {Promise<boolean>} Success
   */
  async updatePartnerAddress(partnerId, cleanedAddress) {
    try {
      const displayName = this.buildDisplayName(cleanedAddress.company, cleanedAddress.name, cleanedAddress.poNumber);
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
