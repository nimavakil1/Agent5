/**
 * AddressCleanerAI - Claude Sonnet 4.5 powered address parsing
 *
 * Uses AI to intelligently parse inconsistent Amazon address data where:
 * - Company names may appear in street fields
 * - Street addresses may appear in address-2 or address-3
 * - PO numbers may be concatenated with recipient names
 * - Department info may be mixed with company names
 *
 * @module AddressCleanerAI
 */

const Anthropic = require('@anthropic-ai/sdk');
const { LEGAL_TERMS_REGEX } = require('./AddressCleaner');

// System prompt for address parsing
const ADDRESS_PARSING_PROMPT = `You are an expert at parsing shipping addresses from e-commerce data. Your task is to take raw address fields from Amazon and structure them correctly for import into an ERP system.

IMPORTANT CONTEXT:
- The data comes from Amazon FBM (Fulfilled by Merchant) orders
- Amazon's data is often INCONSISTENT - company names may be in street fields, streets may be in address-2, etc.
- For B2B orders, "buyer-name" is often "Amazon Business EU SARL" which is NOT the real customer
- PO numbers are sometimes concatenated with recipient names (e.g., "CompanyNamePO12345")

YOUR TASK:
Analyze the provided address fields and return a CLEAN, STRUCTURED address.

RULES FOR PARSING:

1. IDENTIFYING COMPANY vs PERSON:
   - Legal terms indicate a company: GmbH, AG, KG, OHG, UG, e.V., mbH, Co. KG, Ltd, Inc, LLC, SARL, SAS, BV, NV, S.A., gGmbH, e.K., PLC, SA, S.r.l.
   - Words like "Hospital", "Krankenhaus", "School", "College", "Institut", "Verein", "Stiftung" indicate organizations
   - ALL CAPS text in address fields often indicates a company name
   - If address-1 contains a company name and address-2 contains a street, the company is in the WRONG field

2. IDENTIFYING STREET ADDRESSES:
   - German streets: "Straße", "Str.", "Weg", "Platz", "Allee", "Ring", "Gasse", "Damm" + house number
   - French streets: "Rue", "Avenue", "Boulevard", "Allée", "Place", "Chemin" + number
   - Dutch streets: "straat", "weg", "laan", "plein", "gracht" + number
   - A line with ONLY a number + street name is likely the actual street address

3. HANDLING PO NUMBERS IN NAMES:
   - Pattern "NamePO12345" or "NamePOABC" - split the PO number out
   - IMPORTANT: The PO number is EVERYTHING after "PO" until the end of that text block
   - Example: "CompanyPORouter JHZ & Gefü Büro" → PO is "Router JHZ & Gefü Büro" (not just "Router")
   - The PO should go in a separate field, not be part of the name

4. HANDLING DEPARTMENT/OFFICE/BUILDING INFO:
   - Text like "JHZ & Gefü Büro", "Abteilung X", "Gebäude B", "Haus 3" is department/building info
   - This should go in street2, NOT be lost
   - If it appears in the recipient name after extracting the PO, put it in street2

5. HANDLING ATTENTION/CONTACT INFO:
   - "z.Hd." or "c/o" or "Attn:" indicates a contact person
   - "- Name" at the end of a company name often indicates the contact person

6. AMAZON BILLING ENTITIES (IGNORE these as buyer):
   - "Amazon Business EU SARL"
   - "Amazon EU SARL"
   - "Amazon EU S.a.r.l"
   These are billing intermediaries, not the actual customer.

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
ship-address-1: "Drk Schwesternschaft Hamburg Bildungszentrum Schlump Ggmbh"
ship-address-2: "Beim Schlump 86"
ship-city: "Hamburg"
ship-postal-code: "20144"
ship-country: "DE"
buyer-company-name: ""

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
recipient-name: "Klauck BenediktPOOPB"
ship-address-1: "Merziger Straße 3"
ship-address-2: ""
ship-city: "Losheim Am See"
ship-postal-code: "66679"
ship-country: "DE"
buyer-company-name: ""

Output:
{
  "company_name": null,
  "contact_person": "Benedikt Klauck",
  "street": "Merziger Straße 3",
  "street2": null,
  "zip": "66679",
  "city": "Losheim Am See",
  "state": null,
  "country": "DE",
  "is_business": false,
  "po_number": "OPB",
  "confidence": "high",
  "notes": "Extracted PO number 'OPB' from concatenated recipient name, corrected name order"
}

Input:
recipient-name: "Jugendhof Obermeyer Lena SchutenPORouter JHZ & Gefü Büro"
ship-address-1: "Heggestraße 11"
ship-address-2: ""
ship-city: "Hagen Am Teutoburger Wald"
ship-postal-code: "49170"
ship-country: "DE"
buyer-company-name: ""

Output:
{
  "company_name": "Jugendhof Obermeyer",
  "contact_person": "Lena Schuten",
  "street": "Heggestraße 11",
  "street2": "JHZ & Gefü Büro",
  "zip": "49170",
  "city": "Hagen Am Teutoburger Wald",
  "state": null,
  "country": "DE",
  "is_business": true,
  "po_number": "Router JHZ & Gefü Büro",
  "confidence": "high",
  "notes": "Jugendhof indicates youth organization. PO number is FULL text after 'PO': 'Router JHZ & Gefü Büro'. Department info 'JHZ & Gefü Büro' placed in street2."
}

Now parse the following address:`;

/**
 * AddressCleanerAI class - Uses Claude Sonnet 4.5 for intelligent address parsing
 */
class AddressCleanerAI {
  constructor(options = {}) {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    this.model = options.model || 'claude-sonnet-4-20250514';
    this.maxTokens = options.maxTokens || 1024;
  }

  /**
   * Clean and parse a shipping address using AI
   *
   * @param {Object} rawAddress - Raw address from Amazon TSV
   * @param {string} rawAddress.recipientName - Recipient name field
   * @param {string} rawAddress.addressLine1 - Address line 1
   * @param {string} rawAddress.addressLine2 - Address line 2
   * @param {string} rawAddress.addressLine3 - Address line 3
   * @param {string} rawAddress.city - City
   * @param {string} rawAddress.state - State/region
   * @param {string} rawAddress.postalCode - Postal code
   * @param {string} rawAddress.countryCode - Country code
   * @param {string} rawAddress.buyerName - Buyer name
   * @param {string} rawAddress.buyerCompanyName - Buyer company name (B2B)
   * @param {string} rawAddress.shippingCompanyName - Shipping company name from SP-API (authoritative)
   * @param {string} rawAddress.purchaseOrderNumber - PO number if any
   * @returns {Promise<Object>} Cleaned and structured address
   */
  async cleanAddress(rawAddress) {
    // Format the address data for the prompt
    const addressInput = this._formatAddressInput(rawAddress);

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
        console.error('AddressCleanerAI: No JSON found in response:', content);
        return this._fallbackParse(rawAddress);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const result = this._normalizeResponse(parsed);

      // If we have SP-API shipping company name, use it intelligently
      if (rawAddress.shippingCompanyName) {
        // Check if recipientName is an organization (has legal terms like GmbH, e.V., etc.)
        const recipientHasLegalTerms = rawAddress.recipientName &&
          LEGAL_TERMS_REGEX.test(rawAddress.recipientName);
        LEGAL_TERMS_REGEX.lastIndex = 0; // Reset regex

        if (recipientHasLegalTerms &&
            rawAddress.recipientName.trim().toLowerCase() !== rawAddress.shippingCompanyName.trim().toLowerCase()) {
          // recipientName is an organization (e.g., "Diakonisches Werk e.V.")
          // shippingCompanyName is a department (e.g., "Ambulanter Pflegedienst")
          // Combine them: "Main Org - Department"
          const cleanedRecipient = rawAddress.recipientName
            .replace(LEGAL_TERMS_REGEX, '')
            .replace(/\s+/g, ' ')
            .trim();
          result.company = `${cleanedRecipient} - ${rawAddress.shippingCompanyName}`;
          result.name = null; // No separate contact person
        } else {
          // recipientName is a person (e.g., "Ulrike Feegers")
          // shippingCompanyName is the actual company (e.g., "BurdaVerlag Data Publishing GmbH")
          // Use shippingCompanyName as company, keep AI's extracted name as contact
          result.company = rawAddress.shippingCompanyName;
          // Keep result.name from AI parsing (already cleaned, PO stripped)
        }
        result.isCompany = true;
        result.spApiCompanyUsed = true;
      }

      return result;

    } catch (error) {
      console.error('AddressCleanerAI error:', error.message);
      return this._fallbackParse(rawAddress);
    }
  }

  /**
   * Clean multiple addresses in batch (more efficient for large imports)
   *
   * @param {Array<Object>} addresses - Array of raw addresses
   * @returns {Promise<Array<Object>>} Array of cleaned addresses
   */
  async cleanAddressesBatch(addresses) {
    // Process in batches of 5 to balance speed vs API limits
    const batchSize = 5;
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
   * Format raw address data for the AI prompt
   * @private
   */
  _formatAddressInput(rawAddress) {
    const lines = [];

    if (rawAddress.recipientName) {
      lines.push(`recipient-name: "${rawAddress.recipientName}"`);
    }
    if (rawAddress.addressLine1) {
      lines.push(`ship-address-1: "${rawAddress.addressLine1}"`);
    }
    if (rawAddress.addressLine2) {
      lines.push(`ship-address-2: "${rawAddress.addressLine2}"`);
    }
    if (rawAddress.addressLine3) {
      lines.push(`ship-address-3: "${rawAddress.addressLine3}"`);
    }
    if (rawAddress.city) {
      lines.push(`ship-city: "${rawAddress.city}"`);
    }
    if (rawAddress.state) {
      lines.push(`ship-state: "${rawAddress.state}"`);
    }
    if (rawAddress.postalCode) {
      lines.push(`ship-postal-code: "${rawAddress.postalCode}"`);
    }
    if (rawAddress.countryCode) {
      lines.push(`ship-country: "${rawAddress.countryCode}"`);
    }
    if (rawAddress.buyerName) {
      lines.push(`buyer-name: "${rawAddress.buyerName}"`);
    }
    if (rawAddress.buyerCompanyName) {
      lines.push(`buyer-company-name: "${rawAddress.buyerCompanyName}"`);
    }
    // SP-API shipping company name - this is the ACTUAL destination company
    // (different from buyer-company-name which may be Amazon Business EU SARL)
    if (rawAddress.shippingCompanyName) {
      lines.push(`shipping-company-name (from SP-API): "${rawAddress.shippingCompanyName}"`);
    }
    if (rawAddress.purchaseOrderNumber) {
      lines.push(`purchase-order-number: "${rawAddress.purchaseOrderNumber}"`);
    }

    return lines.join('\n');
  }

  /**
   * Normalize the AI response to our expected format
   * @private
   */
  _normalizeResponse(parsed) {
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
      notes: parsed.notes || null
    };
  }

  /**
   * Fallback parsing if AI fails - uses simple regex approach
   * @private
   */
  _fallbackParse(rawAddress) {
    // Simple fallback - just pass through with basic cleaning
    const recipientHasLegalTerms = LEGAL_TERMS_REGEX.test(rawAddress.recipientName || '');
    LEGAL_TERMS_REGEX.lastIndex = 0;

    const addressHasLegalTerms = LEGAL_TERMS_REGEX.test(rawAddress.addressLine1 || '');
    LEGAL_TERMS_REGEX.lastIndex = 0;

    const hasLegalTerm = recipientHasLegalTerms || addressHasLegalTerms || !!rawAddress.shippingCompanyName;

    // Build company name and contact
    let companyName = null;
    let contactName = null;

    if (rawAddress.shippingCompanyName) {
      if (recipientHasLegalTerms &&
          rawAddress.recipientName.trim().toLowerCase() !== rawAddress.shippingCompanyName.trim().toLowerCase()) {
        // recipientName is an organization - combine them
        const cleanedRecipient = rawAddress.recipientName
          .replace(LEGAL_TERMS_REGEX, '')
          .replace(/\s+/g, ' ')
          .trim();
        companyName = `${cleanedRecipient} - ${rawAddress.shippingCompanyName}`;
        contactName = null;
      } else {
        // recipientName is a person - use shippingCompanyName as company
        companyName = rawAddress.shippingCompanyName;
        // Try to extract person name (strip PO patterns)
        contactName = (rawAddress.recipientName || '')
          .replace(/PO\d+/gi, '')
          .replace(/\s+/g, ' ')
          .trim() || null;
      }
    } else if (hasLegalTerm) {
      companyName = rawAddress.buyerCompanyName || rawAddress.addressLine1;
      contactName = rawAddress.recipientName || null;
    }

    return {
      company: companyName || null,
      name: contactName,
      street: rawAddress.addressLine1 || null,
      street2: rawAddress.addressLine2 || null,
      zip: rawAddress.postalCode || null,
      city: rawAddress.city || null,
      state: rawAddress.state || null,
      country: rawAddress.countryCode || null,
      isCompany: hasLegalTerm || !!rawAddress.shippingCompanyName,
      poNumber: rawAddress.purchaseOrderNumber || null,
      confidence: rawAddress.shippingCompanyName ? 'sp-api-fallback' : 'low',
      notes: rawAddress.shippingCompanyName
        ? 'Fallback parsing with SP-API company name'
        : 'Fallback parsing used due to AI error',
      spApiCompanyUsed: !!rawAddress.shippingCompanyName
    };
  }
}

// Singleton instance
let addressCleanerAIInstance = null;

/**
 * Get the singleton AddressCleanerAI instance
 */
function getAddressCleanerAI(options = {}) {
  if (!addressCleanerAIInstance) {
    addressCleanerAIInstance = new AddressCleanerAI(options);
  }
  return addressCleanerAIInstance;
}

module.exports = {
  AddressCleanerAI,
  getAddressCleanerAI,
  ADDRESS_PARSING_PROMPT
};
