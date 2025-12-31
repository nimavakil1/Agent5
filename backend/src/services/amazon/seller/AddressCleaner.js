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

    // Generate cache key
    const cacheKey = this._getCacheKey(rawAddress);
    if (addressCache.has(cacheKey)) {
      return addressCache.get(cacheKey);
    }

    let result;

    if (this.llm) {
      try {
        result = await this._cleanWithAI(rawAddress);
      } catch (error) {
        console.error('[AddressCleaner] AI cleaning failed, using fallback:', error.message);
        result = this._cleanWithFallback(rawAddress);
      }
    } else {
      result = this._cleanWithFallback(rawAddress);
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
        content: `You are an address parser for shipping labels. Parse addresses and return ONLY valid JSON.
Your goal is to create clean, readable addresses for delivery drivers.

Rules:
1. If there's a company/business name, put it in "company" field
2. Personal name goes in "name" field
3. Remove legal terms: GmbH, AG, KG, e.V., Inhaber, Ltd, etc. but KEEP the business name
4. Street address in "street", overflow in "street2"
5. Don't repeat information that's already in another field
6. If the same name appears as both company and person, only use it once (prefer company if it looks like a business)
7. Keep the address as SHORT as possible while retaining essential delivery info

Return ONLY a JSON object with these fields: company, name, street, street2, zip, city, country`
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

    if (rawAddress.recipientName) {
      lines.push(`recipient-name: ${rawAddress.recipientName}`);
    }
    if (rawAddress.buyerName && rawAddress.buyerName !== rawAddress.recipientName) {
      lines.push(`buyer-name: ${rawAddress.buyerName}`);
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
};
