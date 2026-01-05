/**
 * AddressCleaner - AI-powered address parsing and cleaning for shipping labels
 *
 * Uses Claude API to:
 * - Parse raw Amazon address fields into structured data
 * - Extract company name vs personal name
 * - Clean up legal terms (GmbH, e.V., Inhaber, etc.)
 * - Deduplicate redundant information
 * - Format for carrier labels
 *
 * @module AddressCleaner
 */

const { AnthropicProvider } = require('../../../core/agents/llm/AnthropicProvider');

// Cache to avoid re-processing identical addresses
const addressCache = new Map();
const CACHE_MAX_SIZE = 1000;

// Legal terms to remove (for fallback regex cleaning)
const LEGAL_TERMS_REGEX = /\b(GmbH|AG|KG|OHG|UG|e\.?V\.?|mbH|Co\.?\s*KG|Inhaber|Inh\.|Ltd\.?|Inc\.?|LLC|PLC|SA|SARL|SAS|BV|NV)\b\.?/gi;

// Amazon billing entities - these are INVOICE recipients, NOT delivery locations
// When these appear as buyer-name, they should be IGNORED for delivery addresses
const AMAZON_BILLING_ENTITIES = [
  'Amazon Business EU SARL',
  'Amazon Business EU S.a.r.l',
  'Amazon EU SARL',
  'Amazon EU S.a.r.l',
  'Amazon Business',
  'AMAZON BUSINESS EU SARL',
];

/**
 * AddressCleaner class
 */
class AddressCleaner {
  constructor(options = {}) {
    this.llm = null;
    this.useAI = options.useAI !== false; // Enable AI by default
    this.model = options.model || 'haiku'; // Use Haiku for speed/cost
  }

  /**
   * Initialize the LLM provider
   */
  async init() {
    if (this.llm) return;

    if (this.useAI && process.env.ANTHROPIC_API_KEY) {
      this.llm = new AnthropicProvider({
        model: this.model,
        maxTokens: 1024,
        temperature: 0, // Deterministic for consistency
      });
    }
  }

  /**
   * Check if a name is an Amazon billing entity (not a real delivery location)
   */
  _isAmazonBillingEntity(name) {
    if (!name) return false;
    const normalized = name.trim().toLowerCase();
    return AMAZON_BILLING_ENTITIES.some(entity =>
      normalized === entity.toLowerCase() ||
      normalized.includes('amazon business eu') ||
      normalized.includes('amazon eu sarl')
    );
  }

  /**
   * Filter out Amazon billing entities from buyer name
   * These are invoice recipients, NOT delivery locations
   */
  _filterBuyerName(buyerName) {
    if (!buyerName) return null;
    if (this._isAmazonBillingEntity(buyerName)) {
      return null; // Ignore Amazon billing entities for delivery
    }
    return buyerName;
  }

  /**
   * Clean and parse a shipping address
   *
   * @param {Object} rawAddress - Raw address from Amazon TSV
   * @param {string} rawAddress.recipientName - Recipient name field
   * @param {string} rawAddress.addressLine1 - Address line 1
   * @param {string} rawAddress.addressLine2 - Address line 2
   * @param {string} rawAddress.addressLine3 - Address line 3
   * @param {string} rawAddress.city - City
   * @param {string} rawAddress.state - State/region
   * @param {string} rawAddress.postalCode - Postal code
   * @param {string} rawAddress.countryCode - Country code (DE, FR, etc.)
   * @param {string} rawAddress.buyerName - Buyer name (often same as recipient)
   * @returns {Object} Cleaned address with company, name, street, street2, city, zip, country
   */
  async cleanAddress(rawAddress) {
    await this.init();

    // Filter out Amazon billing entities from buyer name BEFORE processing
    const filteredAddress = {
      ...rawAddress,
      buyerName: this._filterBuyerName(rawAddress.buyerName)
    };

    // Generate cache key (use filtered address)
    const cacheKey = this._getCacheKey(filteredAddress);
    if (addressCache.has(cacheKey)) {
      return addressCache.get(cacheKey);
    }

    let result;

    if (this.llm) {
      try {
        result = await this._cleanWithAI(filteredAddress);
      } catch (error) {
        console.error('[AddressCleaner] AI cleaning failed, using fallback:', error.message);
        result = this._cleanWithFallback(filteredAddress);
      }
    } else {
      result = this._cleanWithFallback(filteredAddress);
    }

    // Cache the result
    if (addressCache.size >= CACHE_MAX_SIZE) {
      // Remove oldest entry
      const firstKey = addressCache.keys().next().value;
      addressCache.delete(firstKey);
    }
    addressCache.set(cacheKey, result);

    return result;
  }

  /**
   * Clean address using Claude AI
   */
  async _cleanWithAI(rawAddress) {
    const prompt = this._buildPrompt(rawAddress);

    const response = await this.llm.chat([
      {
        role: 'system',
        content: `You are an address parser for Odoo ERP. Parse shipping addresses and return ONLY valid JSON.
Your goal is to correctly identify company vs personal names for B2B/B2C orders.

CRITICAL Rules:
1. COMPANY NAME detection - Look for business names in ALL fields (recipient, buyer, address lines):
   - Business indicators: GmbH, AG, KG, e.V., Ltd, Inc, LLC, SARL, BV, NV, Shop, Store, Restaurant, Hotel, Praxis, Werkstatt, Service, Center, Verlag, Verein, Stiftung
   - Trade names that don't look like person names (e.g., "Der Soltauer Hausfreund", "Blumen Müller", "Auto-Center Schmidt")
   - If company name is in address-line-2 or address-line-3 (common in Amazon B2B), extract it to "company" field

2. PERSONAL NAME: The actual person receiving the delivery (often the recipient-name or buyer-name)
   - If recipient looks like a person's name (first + last name), use it as "name"
   - If recipient is a company, look for personal name in other fields

3. STREET ADDRESS: Must contain a street name and usually a house number
   - "Hauptstraße 15" = street address
   - "Der Soltauer Hausfreund" = NOT a street address (it's a company name!)

4. Remove legal suffixes (GmbH, AG, etc.) from the company name but KEEP the actual business name

5. NEVER put a company name in street2. Company names go in "company" field only.

Return ONLY a JSON object: { "company": string|null, "name": string|null, "street": string, "street2": string|null, "zip": string, "city": string, "country": string }`
      },
      {
        role: 'user',
        content: prompt
      }
    ]);

    // Parse the JSON response
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return this._normalizeResult(parsed, rawAddress);
  }

  /**
   * Build the prompt for AI parsing
   */
  _buildPrompt(rawAddress) {
    const lines = [];

    // Add order type indicator
    if (rawAddress.isBusinessOrder) {
      lines.push(`order-type: B2B (Business Order - likely has a company name)`);
    }

    if (rawAddress.recipientName) {
      lines.push(`recipient-name: ${rawAddress.recipientName}`);
    }
    if (rawAddress.buyerName && rawAddress.buyerName !== rawAddress.recipientName) {
      lines.push(`buyer-name: ${rawAddress.buyerName}`);
    }
    if (rawAddress.buyerCompanyName) {
      lines.push(`buyer-company-name: ${rawAddress.buyerCompanyName}`);
    }
    if (rawAddress.addressLine1) {
      lines.push(`address-line-1: ${rawAddress.addressLine1}`);
    }
    if (rawAddress.addressLine2) {
      lines.push(`address-line-2: ${rawAddress.addressLine2}`);
    }
    if (rawAddress.addressLine3) {
      lines.push(`address-line-3: ${rawAddress.addressLine3}`);
    }
    if (rawAddress.city) {
      lines.push(`city: ${rawAddress.city}`);
    }
    if (rawAddress.state) {
      lines.push(`state: ${rawAddress.state}`);
    }
    if (rawAddress.postalCode) {
      lines.push(`postal-code: ${rawAddress.postalCode}`);
    }
    if (rawAddress.countryCode) {
      lines.push(`country: ${rawAddress.countryCode}`);
    }

    return `Parse this shipping address:\n\n${lines.join('\n')}`;
  }

  /**
   * Fallback cleaning without AI (regex-based)
   */
  _cleanWithFallback(rawAddress) {
    const recipientName = rawAddress.recipientName?.trim() || '';
    const buyerName = rawAddress.buyerName?.trim() || '';
    const addr1 = rawAddress.addressLine1?.trim() || '';
    const addr2 = rawAddress.addressLine2?.trim() || '';
    const addr3 = rawAddress.addressLine3?.trim() || '';

    // Combine address lines
    const addressParts = [addr1, addr2, addr3].filter(Boolean);

    // Try to detect if recipientName looks like a company
    const looksLikeCompany = this._looksLikeCompany(recipientName);

    // Clean legal terms from names
    const cleanedRecipient = recipientName.replace(LEGAL_TERMS_REGEX, '').trim();
    const cleanedBuyer = buyerName.replace(LEGAL_TERMS_REGEX, '').trim();

    let company = null;
    let name = null;

    if (looksLikeCompany) {
      company = cleanedRecipient;
      // Use buyer name as personal name if different
      if (cleanedBuyer && cleanedBuyer.toLowerCase() !== cleanedRecipient.toLowerCase()) {
        name = cleanedBuyer;
      }
    } else {
      name = cleanedRecipient || cleanedBuyer;
    }

    // Build street from address parts
    let street = addressParts[0] || '';
    let street2 = addressParts.slice(1).join(', ') || null;

    // Clean legal terms from street too (in case company name leaked into address)
    street = street.replace(LEGAL_TERMS_REGEX, '').trim();
    if (street2) {
      street2 = street2.replace(LEGAL_TERMS_REGEX, '').trim() || null;
    }

    return {
      company: company || null,
      name: name || null,
      street: street || null,
      street2: street2 || null,
      zip: rawAddress.postalCode?.trim() || null,
      city: rawAddress.city?.trim() || null,
      country: rawAddress.countryCode?.trim() || null,
    };
  }

  /**
   * Check if a name looks like a company name
   */
  _looksLikeCompany(name) {
    if (!name) return false;

    const companyIndicators = [
      /GmbH/i, /AG\b/i, /KG\b/i, /OHG/i, /UG\b/i, /e\.?V\.?/i,
      /Ltd/i, /Inc/i, /LLC/i, /Corp/i, /SA\b/i, /SARL/i, /SAS\b/i,
      /BV\b/i, /NV\b/i, /SRL/i, /Pty/i,
      /Werkstatt/i, /Garage/i, /Service/i, /Shop/i, /Store/i,
      /Restaurant/i, /Hotel/i, /Praxis/i, /Kanzlei/i, /Büro/i,
      /Center/i, /Centre/i, /Institut/i, /Akademie/i,
      /Verein/i, /Stiftung/i, /Foundation/i,
      /\d{5,}/, // Long numbers (might be PO numbers)
    ];

    return companyIndicators.some(pattern => pattern.test(name));
  }

  /**
   * Normalize the AI result
   */
  _normalizeResult(parsed, rawAddress) {
    return {
      company: parsed.company?.trim() || null,
      name: parsed.name?.trim() || null,
      street: parsed.street?.trim() || null,
      street2: parsed.street2?.trim() || null,
      zip: parsed.zip?.trim() || rawAddress.postalCode?.trim() || null,
      city: parsed.city?.trim() || rawAddress.city?.trim() || null,
      country: parsed.country?.trim() || rawAddress.countryCode?.trim() || null,
    };
  }

  /**
   * Generate cache key for an address
   */
  _getCacheKey(rawAddress) {
    return JSON.stringify([
      rawAddress.recipientName,
      rawAddress.buyerName,
      rawAddress.addressLine1,
      rawAddress.addressLine2,
      rawAddress.addressLine3,
      rawAddress.city,
      rawAddress.postalCode,
      rawAddress.countryCode,
    ]);
  }

  /**
   * Clear the address cache
   */
  clearCache() {
    addressCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: addressCache.size,
      maxSize: CACHE_MAX_SIZE,
    };
  }
}

// Singleton instance
let addressCleanerInstance = null;

/**
 * Get the singleton AddressCleaner instance
 */
function getAddressCleaner(options = {}) {
  if (!addressCleanerInstance) {
    addressCleanerInstance = new AddressCleaner(options);
  }
  return addressCleanerInstance;
}

module.exports = {
  AddressCleaner,
  getAddressCleaner,
  LEGAL_TERMS_REGEX,
  AMAZON_BILLING_ENTITIES,
};
