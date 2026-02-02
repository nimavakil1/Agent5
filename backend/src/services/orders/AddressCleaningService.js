/**
 * AddressCleaningService - Unified AI-powered address cleaning for all marketplaces
 *
 * Uses Claude AI to intelligently parse and clean shipping addresses from:
 * - Amazon Seller Central (TSV and API)
 * - Bol.com
 * - Future marketplaces
 *
 * @module AddressCleaningService
 */

const Anthropic = require('@anthropic-ai/sdk');

// System prompt for address parsing - marketplace agnostic
const ADDRESS_PARSING_PROMPT = `You are an expert at parsing shipping addresses from e-commerce data. Your task is to take raw address fields and structure them correctly for import into an ERP system.

IMPORTANT CONTEXT:
- The data comes from various marketplaces (Amazon, Bol.com, etc.)
- Address data is often INCONSISTENT - company names may be in street fields, streets may be in address-2, etc.
- For B2B orders, buyer names like "Amazon Business EU SARL" are billing intermediaries, NOT the real customer
- PO numbers are sometimes concatenated with recipient names (e.g., "CompanyNamePO12345")

YOUR TASK:
Analyze the provided address fields and return a CLEAN, STRUCTURED address.

RULES FOR PARSING:

1. IDENTIFYING COMPANY vs PERSON:
   - Legal terms indicate a company: GmbH, AG, KG, OHG, UG, e.V., mbH, Co. KG, Ltd, Inc, LLC, SARL, SAS, BV, NV, S.A., gGmbH, e.K., PLC, SA, S.r.l., VOF, CV
   - Words like "Hospital", "Krankenhaus", "School", "College", "Institut", "Verein", "Stiftung", "Ziekenhuis", "Universiteit" indicate organizations
   - ALL CAPS text in address fields often indicates a company name
   - If address-1 contains a company name and address-2 contains a street, the company is in the WRONG field

2. IDENTIFYING STREET ADDRESSES:
   - German streets: "Straße", "Str.", "Weg", "Platz", "Allee", "Ring", "Gasse", "Damm" + house number
   - French streets: "Rue", "Avenue", "Boulevard", "Allée", "Place", "Chemin" + number
   - Dutch streets: "straat", "weg", "laan", "plein", "gracht", "kade", "singel" + number
   - Belgian streets: same as Dutch + French patterns
   - A line with ONLY a number + street name is likely the actual street address

3. HANDLING PO NUMBERS IN NAMES:
   - Pattern "NamePO12345" or "NamePOABC" - split the PO number out
   - The PO should go in a separate field, not be part of the name

4. HANDLING ATTENTION/CONTACT INFO:
   - "z.Hd." or "c/o" or "Attn:" or "t.a.v." indicates a contact person
   - "- Name" at the end of a company name often indicates the contact person

5. BILLING ENTITIES TO IGNORE (these are NOT the real customer):
   - "Amazon Business EU SARL"
   - "Amazon EU SARL"
   - "Amazon EU S.a.r.l"
   - "bol.com"

OUTPUT FORMAT:
Return a JSON object with these fields:
{
  "company_name": "The company/organization name if B2B order, or null for B2C",
  "contact_person": "The individual person's name (for delivery attention)",
  "street": "The actual street address with house number",
  "street2": "Additional address info (floor, apartment, building, etc.) or null",
  "zip": "Postal code",
  "city": "City name",
  "state": "State/region or null",
  "country": "2-letter country code (DE, FR, AT, NL, BE, etc.)",
  "is_business": true/false,
  "po_number": "Extracted PO number if found, or null",
  "confidence": "high/medium/low - your confidence in the parsing",
  "notes": "Any notes about unusual parsing decisions"
}

EXAMPLES:

Input:
recipient-name: "Joanna Zielinski"
address-1: "Drk Schwesternschaft Hamburg Bildungszentrum Schlump Ggmbh"
address-2: "Beim Schlump 86"
city: "Hamburg"
postal-code: "20144"
country: "DE"

Output:
{
  "company_name": "DRK Schwesternschaft Hamburg Bildungszentrum Schlump gGmbH",
  "contact_person": "Joanna Zielinski",
  "street": "Beim Schlump 86",
  "street2": null,
  "zip": "20144",
  "city": "Hamburg",
  "state": null,
  "country": "DE",
  "is_business": true,
  "po_number": null,
  "confidence": "high",
  "notes": "Company was in address-1, street was in address-2"
}

Input:
first-name: "Jan"
surname: "de Vries"
address-1: "Keizersgracht 123"
address-2: "2e verdieping"
city: "Amsterdam"
postal-code: "1015 CJ"
country: "NL"
company: ""

Output:
{
  "company_name": null,
  "contact_person": "Jan de Vries",
  "street": "Keizersgracht 123",
  "street2": "2e verdieping",
  "zip": "1015 CJ",
  "city": "Amsterdam",
  "state": null,
  "country": "NL",
  "is_business": false,
  "po_number": null,
  "confidence": "high",
  "notes": "B2C order, Dutch address format"
}

Now parse the following address:`;

// Legal terms regex for fallback parsing
const LEGAL_TERMS_REGEX = /\b(GmbH|AG|KG|OHG|UG|e\.?V\.?|mbH|Co\.?\s*KG|Ltd\.?|Inc\.?|LLC|SARL|SAS|BV|NV|gGmbH|e\.?K\.?|PLC|SA|S\.?r\.?l\.?|VOF|CV)\b\.?/gi;

// Billing entities to filter out
const BILLING_ENTITIES = [
  'amazon business eu sarl',
  'amazon eu sarl',
  'amazon eu s.a.r.l',
  'amazon business',
  'bol.com',
];

/**
 * AddressCleaningService - Unified address cleaning for all marketplaces
 */
class AddressCleaningService {
  constructor(options = {}) {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    this.model = options.model || 'claude-sonnet-4-20250514';
    this.maxTokens = options.maxTokens || 1024;
    this.useAI = options.useAI !== false; // Default to using AI
  }

  /**
   * Check if a name is a billing entity (not a real customer)
   * @private
   */
  _isBillingEntity(name) {
    if (!name) return false;
    const normalized = name.trim().toLowerCase();
    return BILLING_ENTITIES.some(entity => normalized.includes(entity));
  }

  /**
   * Clean and parse a shipping address using AI
   *
   * Accepts address data from any marketplace in a standardized format.
   *
   * @param {Object} rawAddress - Raw address data
   * @param {string} rawAddress.name - Full name or recipient name
   * @param {string} rawAddress.firstName - First name (Bol.com style)
   * @param {string} rawAddress.surname - Surname (Bol.com style)
   * @param {string} rawAddress.company - Company name if provided
   * @param {string} rawAddress.street - Street address or address line 1
   * @param {string} rawAddress.streetName - Street name (Bol.com style)
   * @param {string} rawAddress.houseNumber - House number (Bol.com style)
   * @param {string} rawAddress.houseNumberExtension - House number extension
   * @param {string} rawAddress.street2 - Address line 2 / extra info
   * @param {string} rawAddress.city - City
   * @param {string} rawAddress.state - State/region
   * @param {string} rawAddress.postalCode - Postal code
   * @param {string} rawAddress.countryCode - Country code
   * @param {string} rawAddress.buyerCompanyName - Buyer company name (Amazon B2B)
   * @param {string} rawAddress.purchaseOrderNumber - PO number if any
   * @param {string} rawAddress.source - Source marketplace (amazon, bol, etc.)
   * @returns {Promise<Object>} Cleaned and structured address
   */
  async cleanAddress(rawAddress) {
    // Normalize input from different marketplace formats
    const normalizedInput = this._normalizeInput(rawAddress);

    // If AI is disabled or no API key, use fallback
    if (!this.useAI || !process.env.ANTHROPIC_API_KEY) {
      return this._fallbackParse(normalizedInput);
    }

    // Format for AI prompt
    const addressInput = this._formatAddressInput(normalizedInput);

    try {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: [
          {
            role: 'user',
            content: `${ADDRESS_PARSING_PROMPT}\n\n${addressInput}`
          }
        ]
      });

      // Extract and parse the JSON response
      const content = response.content[0]?.text || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        console.error('[AddressCleaningService] No JSON found in AI response');
        return this._fallbackParse(normalizedInput);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return this._normalizeResponse(parsed, rawAddress.source);

    } catch (error) {
      console.error('[AddressCleaningService] AI error:', error.message);
      return this._fallbackParse(normalizedInput);
    }
  }

  /**
   * Clean multiple addresses in batch
   *
   * @param {Array<Object>} addresses - Array of raw addresses
   * @param {number} batchSize - Batch size for parallel processing
   * @returns {Promise<Array<Object>>} Array of cleaned addresses
   */
  async cleanAddressesBatch(addresses, batchSize = 5) {
    const results = [];

    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(addr => this.cleanAddress(addr))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Normalize input from different marketplace formats to a common structure
   * @private
   */
  _normalizeInput(rawAddress) {
    // Build full name from parts if needed
    let fullName = rawAddress.name || rawAddress.recipientName || '';
    if (!fullName && (rawAddress.firstName || rawAddress.surname)) {
      fullName = `${rawAddress.firstName || ''} ${rawAddress.surname || ''}`.trim();
    }

    // Build street from parts if needed (Bol.com format)
    let street = rawAddress.street || rawAddress.addressLine1 || '';
    if (!street && rawAddress.streetName) {
      street = rawAddress.streetName;
      if (rawAddress.houseNumber) {
        street += ' ' + rawAddress.houseNumber;
      }
      if (rawAddress.houseNumberExtension) {
        street += rawAddress.houseNumberExtension;
      }
    }

    // Filter out billing entities from buyer name
    const buyerName = this._isBillingEntity(rawAddress.buyerName)
      ? ''
      : (rawAddress.buyerName || '');

    // Handle "c/o" (care of) patterns - these should be part of the name, not street2
    // Common patterns: "c/o Name", "C/O Name", "c/o. Name", "z.Hd. Name", "Attn: Name", "t.a.v. Name"
    let street2Raw = rawAddress.street2 || rawAddress.addressLine2 || rawAddress.extraAddressInformation || '';
    let careOfName = '';

    const careOfPatterns = /^(c\/o\.?\s*|z\.?\s*hd\.?\s*|attn:?\s*|t\.?\s*a\.?\s*v\.?\s*)/i;
    if (street2Raw && careOfPatterns.test(street2Raw.trim())) {
      // Extract the care-of name and append to recipient name
      careOfName = street2Raw.trim();
      street2Raw = ''; // Remove from street2 since it's now part of name
    }

    // Append c/o info to name if present
    const finalName = careOfName ? `${fullName} ${careOfName}` : fullName;

    return {
      name: finalName,
      company: rawAddress.company || rawAddress.buyerCompanyName || '',
      street: street,
      street2: street2Raw,
      street3: rawAddress.addressLine3 || '',
      city: rawAddress.city || '',
      state: rawAddress.state || '',
      postalCode: rawAddress.postalCode || rawAddress.zipCode || '',
      countryCode: rawAddress.countryCode || rawAddress.country || '',
      buyerName: buyerName,
      purchaseOrderNumber: rawAddress.purchaseOrderNumber || '',
      source: rawAddress.source || 'unknown'
    };
  }

  /**
   * Format normalized address data for the AI prompt
   * @private
   */
  _formatAddressInput(normalizedAddress) {
    const lines = [];

    if (normalizedAddress.name) {
      lines.push(`recipient-name: "${normalizedAddress.name}"`);
    }
    if (normalizedAddress.company) {
      lines.push(`company: "${normalizedAddress.company}"`);
    }
    if (normalizedAddress.street) {
      lines.push(`address-1: "${normalizedAddress.street}"`);
    }
    if (normalizedAddress.street2) {
      lines.push(`address-2: "${normalizedAddress.street2}"`);
    }
    if (normalizedAddress.street3) {
      lines.push(`address-3: "${normalizedAddress.street3}"`);
    }
    if (normalizedAddress.city) {
      lines.push(`city: "${normalizedAddress.city}"`);
    }
    if (normalizedAddress.state) {
      lines.push(`state: "${normalizedAddress.state}"`);
    }
    if (normalizedAddress.postalCode) {
      lines.push(`postal-code: "${normalizedAddress.postalCode}"`);
    }
    if (normalizedAddress.countryCode) {
      lines.push(`country: "${normalizedAddress.countryCode}"`);
    }
    if (normalizedAddress.buyerName) {
      lines.push(`buyer-name: "${normalizedAddress.buyerName}"`);
    }
    if (normalizedAddress.purchaseOrderNumber) {
      lines.push(`po-number: "${normalizedAddress.purchaseOrderNumber}"`);
    }
    if (normalizedAddress.source) {
      lines.push(`source: "${normalizedAddress.source}"`);
    }

    return lines.join('\n');
  }

  /**
   * Normalize the AI response to our standard format
   * @private
   */
  _normalizeResponse(parsed, source) {
    return {
      company: parsed.company_name || null,
      name: parsed.contact_person || null,
      street: parsed.street || null,
      street2: parsed.street2 || null,
      zip: parsed.zip || null,
      city: parsed.city || null,
      state: parsed.state || null,
      country: parsed.country || null,
      isCompany: parsed.is_business || false,
      poNumber: parsed.po_number || null,
      confidence: parsed.confidence || 'unknown',
      notes: parsed.notes || null,
      source: source || 'unknown'
    };
  }

  /**
   * Fallback parsing if AI fails - uses simple regex approach
   * @private
   */
  _fallbackParse(normalizedAddress) {
    const hasLegalTerm = LEGAL_TERMS_REGEX.test(normalizedAddress.street || '') ||
                         LEGAL_TERMS_REGEX.test(normalizedAddress.name || '') ||
                         LEGAL_TERMS_REGEX.test(normalizedAddress.company || '');

    // Determine company and name
    let company = null;
    let name = normalizedAddress.name || null;

    if (normalizedAddress.company) {
      company = normalizedAddress.company;
    } else if (hasLegalTerm && normalizedAddress.street) {
      // Company might be in street field
      company = normalizedAddress.street;
    }

    return {
      company: company,
      name: name,
      street: normalizedAddress.street || null,
      street2: normalizedAddress.street2 || null,
      zip: normalizedAddress.postalCode || null,
      city: normalizedAddress.city || null,
      state: normalizedAddress.state || null,
      country: normalizedAddress.countryCode || null,
      isCompany: hasLegalTerm || !!normalizedAddress.company,
      poNumber: normalizedAddress.purchaseOrderNumber || null,
      confidence: 'low',
      notes: 'Fallback parsing used (AI unavailable or failed)',
      source: normalizedAddress.source || 'unknown'
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton AddressCleaningService instance
 */
function getAddressCleaningService(options = {}) {
  if (!instance) {
    instance = new AddressCleaningService(options);
  }
  return instance;
}

module.exports = {
  AddressCleaningService,
  getAddressCleaningService,
  LEGAL_TERMS_REGEX,
  BILLING_ENTITIES
};
