/**
 * AddressCleaner - Simple regex-based address cleaning for shipping labels
 *
 * Removes legal terms (GmbH, AG, SARL, etc.) from names.
 * Passes through address fields directly from Amazon TSV.
 *
 * @module AddressCleaner
 */

// Legal terms to remove from names
const LEGAL_TERMS_REGEX = /\b(GmbH|AG|KG|OHG|UG|e\.?V\.?|mbH|Co\.?\s*KG|Inhaber|Inh\.|Ltd\.?|Inc\.?|LLC|PLC|SA|SARL|SAS|BV|NV|S\.?A\.?R\.?L\.?|S\.?A\.?S\.?|B\.?V\.?|N\.?V\.?)\b\.?/gi;

// Amazon billing entities - these are INVOICE recipients, NOT delivery locations
const AMAZON_BILLING_ENTITIES = [
  'Amazon Business EU SARL',
  'Amazon Business EU S.a.r.l',
  'Amazon EU SARL',
  'Amazon EU S.a.r.l',
  'Amazon Business',
  'AMAZON BUSINESS EU SARL',
];

/**
 * AddressCleaner class - Simple regex-only cleaning
 */
class AddressCleaner {
  constructor() {
    // No options needed - regex only
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
   * Remove legal terms from a name using regex
   * @param {string} name - Name to clean
   * @returns {string} Cleaned name
   */
  _removeLegalTerms(name) {
    if (!name) return '';
    return name.replace(LEGAL_TERMS_REGEX, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Clean and parse a shipping address
   * Simply removes legal terms from names and passes through addresses directly.
   *
   * @param {Object} rawAddress - Raw address from Amazon TSV
   * @param {string} rawAddress.recipientName - Recipient name field
   * @param {string} rawAddress.addressLine1 - Address line 1 (street)
   * @param {string} rawAddress.addressLine2 - Address line 2 (street2)
   * @param {string} rawAddress.addressLine3 - Address line 3 (additional)
   * @param {string} rawAddress.city - City
   * @param {string} rawAddress.state - State/region
   * @param {string} rawAddress.postalCode - Postal code
   * @param {string} rawAddress.countryCode - Country code (DE, FR, etc.)
   * @param {string} rawAddress.buyerName - Buyer name
   * @param {string} rawAddress.buyerCompanyName - Buyer company name (B2B orders)
   * @returns {Object} Cleaned address
   */
  cleanAddress(rawAddress) {
    const recipientName = rawAddress.recipientName?.trim() || '';
    const buyerName = rawAddress.buyerName?.trim() || '';
    const buyerCompanyName = rawAddress.buyerCompanyName?.trim() || '';

    // Filter out Amazon billing entities from buyer name
    const filteredBuyerName = this._isAmazonBillingEntity(buyerName) ? '' : buyerName;

    // Clean legal terms from names
    const cleanedRecipient = this._removeLegalTerms(recipientName);
    const cleanedBuyer = this._removeLegalTerms(filteredBuyerName);
    const cleanedCompany = this._removeLegalTerms(buyerCompanyName);

    // Determine company vs personal name
    let company = null;
    let name = null;

    // If buyerCompanyName is provided (B2B order), use it as company
    if (buyerCompanyName) {
      company = cleanedCompany;
      name = cleanedRecipient || cleanedBuyer || null;
    } else {
      // B2C order - just use recipient name
      name = cleanedRecipient || cleanedBuyer || null;
    }

    // Build street - use addressLine1 and addressLine2 directly
    const street = rawAddress.addressLine1?.trim() || null;

    // Combine addressLine2 and addressLine3 for street2 if both exist
    const addr2 = rawAddress.addressLine2?.trim() || '';
    const addr3 = rawAddress.addressLine3?.trim() || '';
    let street2 = null;
    if (addr2 && addr3) {
      street2 = `${addr2}, ${addr3}`;
    } else if (addr2) {
      street2 = addr2;
    } else if (addr3) {
      street2 = addr3;
    }

    return {
      company: company || null,
      name: name || null,
      street: street,
      street2: street2,
      zip: rawAddress.postalCode?.trim() || null,
      city: rawAddress.city?.trim() || null,
      country: rawAddress.countryCode?.trim() || null,
    };
  }
}

// Singleton instance
let addressCleanerInstance = null;

/**
 * Get the singleton AddressCleaner instance
 */
function getAddressCleaner() {
  if (!addressCleanerInstance) {
    addressCleanerInstance = new AddressCleaner();
  }
  return addressCleanerInstance;
}

module.exports = {
  AddressCleaner,
  getAddressCleaner,
  LEGAL_TERMS_REGEX,
  AMAZON_BILLING_ENTITIES,
};
