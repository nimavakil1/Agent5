/**
 * EU Country Configuration for Amazon Integration
 *
 * Handles:
 * - Journal selection based on ship-from country
 * - Fiscal position selection based on B2B/B2C and countries
 * - Generic customer lookup
 * - VAT rate validation
 */

// EU country data with VAT rates
const EU_COUNTRIES = {
  AT: { name: 'Austria', vatRate: 20, currency: 'EUR' },
  BE: { name: 'Belgium', vatRate: 21, currency: 'EUR' },
  BG: { name: 'Bulgaria', vatRate: 20, currency: 'BGN' },
  HR: { name: 'Croatia', vatRate: 25, currency: 'EUR' },
  CY: { name: 'Cyprus', vatRate: 19, currency: 'EUR' },
  CZ: { name: 'Czech Republic', vatRate: 21, currency: 'CZK' },
  DK: { name: 'Denmark', vatRate: 25, currency: 'DKK' },
  EE: { name: 'Estonia', vatRate: 22, currency: 'EUR' },
  FI: { name: 'Finland', vatRate: 24, currency: 'EUR' },
  FR: { name: 'France', vatRate: 20, currency: 'EUR' },
  DE: { name: 'Germany', vatRate: 19, currency: 'EUR' },
  GR: { name: 'Greece', vatRate: 24, currency: 'EUR' },
  HU: { name: 'Hungary', vatRate: 27, currency: 'HUF' },
  IE: { name: 'Ireland', vatRate: 23, currency: 'EUR' },
  IT: { name: 'Italy', vatRate: 22, currency: 'EUR' },
  LV: { name: 'Latvia', vatRate: 21, currency: 'EUR' },
  LT: { name: 'Lithuania', vatRate: 21, currency: 'EUR' },
  LU: { name: 'Luxembourg', vatRate: 17, currency: 'EUR' },
  MT: { name: 'Malta', vatRate: 18, currency: 'EUR' },
  NL: { name: 'Netherlands', vatRate: 21, currency: 'EUR' },
  PL: { name: 'Poland', vatRate: 23, currency: 'PLN' },
  PT: { name: 'Portugal', vatRate: 23, currency: 'EUR' },
  RO: { name: 'Romania', vatRate: 19, currency: 'RON' },
  SK: { name: 'Slovakia', vatRate: 20, currency: 'EUR' },
  SI: { name: 'Slovenia', vatRate: 22, currency: 'EUR' },
  ES: { name: 'Spain', vatRate: 21, currency: 'EUR' },
  SE: { name: 'Sweden', vatRate: 25, currency: 'SEK' },
  GB: { name: 'United Kingdom', vatRate: 20, currency: 'GBP', isEU: false },
};

// Countries where you have VAT registration and dedicated journals
// Based on Amazon Seller Central VAT registrations (IT rejected, not included)
const VAT_REGISTERED_COUNTRIES = ['BE', 'CZ', 'DE', 'FR', 'NL', 'PL', 'GB'];

// Amazon marketplace to country mapping
const MARKETPLACE_TO_COUNTRY = {
  'A13V1IB3VIYBER': 'DE', // Amazon.de
  'A1PA6795UKMFR9': 'FR', // Amazon.fr
  'A1RKKUPIHCS9HS': 'ES', // Amazon.es
  'APJ6JRA9NG5V4': 'ES',  // Amazon.es (alternate)
  'A2NODRKZP88ZB9': 'SE', // Amazon.se
  'A1805IZSGTT6HS': 'NL', // Amazon.nl
  'A1C3SOZRARQ6R3': 'PL', // Amazon.pl
  'A33AVAJ2PDY3EV': 'TR', // Amazon.com.tr
  'AMEN7PMS3EDWL': 'BE',  // Amazon.com.be
  'A2VIGQ35RCS4UG': 'AE', // Amazon.ae
  'A1F83G8C2ARO7P': 'GB', // Amazon.co.uk
  'A21TJRUUN4KGV': 'IN',  // Amazon.in
  'A1AM78C64UM0Y8': 'MX', // Amazon.com.mx
  'ATVPDKIKX0DER': 'US',  // Amazon.com
  'A2Q3Y263D00KWC': 'BR', // Amazon.com.br
  'A39IBJ37TRP1C6': 'AU', // Amazon.com.au
  'A1VC38T7YXB528': 'JP', // Amazon.co.jp
  'AAHKV2X7AFYLW': 'CN',  // Amazon.cn
  'A17E79C6D8DWNP': 'SA', // Amazon.sa
  'APO4EQ8B3QMEF': 'IT',  // Amazon.it (alternate seller central)
};

// FBA Warehouse codes to country mapping
const FBA_WAREHOUSE_COUNTRY = {
  // German warehouses
  'FRA1': 'DE', 'FRA3': 'DE', 'FRA7': 'DE', 'STR1': 'DE', 'MUC1': 'DE', 'MUC3': 'DE',
  'BER3': 'DE', 'CGN1': 'DE', 'DUS2': 'DE', 'DTM1': 'DE', 'DTM2': 'DE', 'HAM2': 'DE',
  'LEJ1': 'DE', 'PAD1': 'DE', 'EDE4': 'DE', 'EDE5': 'DE',
  // French warehouses
  'ORY1': 'FR', 'ORY4': 'FR', 'LYS1': 'FR', 'MRS1': 'FR', 'SXB1': 'FR', 'LIL1': 'FR',
  'ETZ1': 'FR', 'CDG7': 'FR', 'BVA1': 'FR',
  // Italian warehouses
  'MXP5': 'IT', 'FCO1': 'IT', 'TRN1': 'IT', 'MXP3': 'IT',
  // Spanish warehouses
  'MAD4': 'ES', 'BCN1': 'ES', 'SVQ1': 'ES',
  // UK warehouses
  'LBA1': 'GB', 'LBA2': 'GB', 'LBA3': 'GB', 'LBA4': 'GB', 'MAN1': 'GB', 'MAN2': 'GB',
  'BHX1': 'GB', 'BHX2': 'GB', 'BHX3': 'GB', 'BHX4': 'GB', 'EDI4': 'GB', 'CWL1': 'GB',
  'EUK5': 'GB', 'LTN1': 'GB', 'LTN2': 'GB', 'LTN4': 'GB', 'EMA1': 'GB', 'GLA1': 'GB',
  // Polish warehouses
  'WRO1': 'PL', 'WRO2': 'PL', 'WRO5': 'PL', 'KTW1': 'PL', 'KTW2': 'PL',
  'POZ1': 'PL', 'POZ2': 'PL', 'SZZ1': 'PL', 'LCJ4': 'PL', 'XPO1': 'PL', 'XWR1': 'PL', 'XWR3': 'PL',
  // Czech warehouses
  'PRG1': 'CZ', 'PRG2': 'CZ',
  // Netherlands warehouses
  'EIN1': 'NL', 'RTM1': 'NL',
  // Belgium warehouses
  'LGG1': 'BE', 'ANR1': 'BE',
  // Swedish warehouses
  'ARN1': 'SE',
};

class EuCountryConfig {
  /**
   * Get journal code for invoicing
   * @param {string} shipFromCountry - 2-letter country code
   * @returns {string} Journal code (e.g., VDE, VFR, VOS)
   */
  getJournalCode(shipFromCountry) {
    const country = shipFromCountry?.toUpperCase();

    // Countries with dedicated journals
    if (VAT_REGISTERED_COUNTRIES.includes(country)) {
      return `V${country}`;
    }

    // All other EU countries use OSS
    return 'VOS';
  }

  /**
   * Get fiscal position name for invoicing
   * @param {string} shipFromCountry - 2-letter country code (where stock is)
   * @param {string} buyerCountry - 2-letter country code
   * @param {boolean} hasVatNumber - B2B with VAT
   * @returns {string} Fiscal position name pattern
   */
  getFiscalPosition(shipFromCountry, buyerCountry, hasVatNumber = false) {
    const from = shipFromCountry?.toUpperCase();
    const to = buyerCountry?.toUpperCase();

    // B2B with VAT number - reverse charge
    if (hasVatNumber && from !== to) {
      // Use ship-from country's intra-EU fiscal position
      if (VAT_REGISTERED_COUNTRIES.includes(from)) {
        return `${from}*VAT | Régime Intra-Communautaire`;
      }
      return `BE*VAT | Régime Intra-Communautaire`; // Fallback to Belgium
    }

    // B2C domestic (ship from = buyer country)
    if (from === to) {
      if (VAT_REGISTERED_COUNTRIES.includes(from)) {
        return `${from}*VAT | Régime National`;
      }
      // For countries without dedicated journal, use OSS with that country's rate
      return `${to}*OSS | B2C ${this.getCountryName(to)}`;
    }

    // B2C cross-border - use OSS
    return `${to}*OSS | B2C ${this.getCountryName(to)}`;
  }

  /**
   * Get country info
   * @param {string} countryCode
   * @returns {object|null}
   */
  getCountryInfo(countryCode) {
    return EU_COUNTRIES[countryCode?.toUpperCase()] || null;
  }

  /**
   * Get country name
   * @param {string} countryCode
   * @returns {string}
   */
  getCountryName(countryCode) {
    const info = this.getCountryInfo(countryCode);
    return info?.name || countryCode;
  }

  /**
   * Get VAT rate for country
   * @param {string} countryCode
   * @returns {number}
   */
  getVatRate(countryCode) {
    const info = this.getCountryInfo(countryCode);
    return info?.vatRate || 0;
  }

  /**
   * Get country from marketplace ID
   * @param {string} marketplaceId
   * @returns {string|null}
   */
  getCountryFromMarketplace(marketplaceId) {
    return MARKETPLACE_TO_COUNTRY[marketplaceId] || null;
  }

  /**
   * Get country from FBA fulfillment center code
   * @param {string} fcCode - e.g., "WRO1", "FRA3"
   * @returns {string|null}
   */
  getCountryFromFulfillmentCenter(fcCode) {
    if (!fcCode) return null;
    // FC code is usually in format like "WRO1" or "Amazon EU SARL WRO1"
    const match = fcCode.match(/([A-Z]{3,4}\d)/i);
    if (match) {
      return FBA_WAREHOUSE_COUNTRY[match[1].toUpperCase()] || null;
    }
    return null;
  }

  /**
   * Get generic B2C customer name pattern
   * @param {string} countryCode
   * @returns {string}
   */
  getGenericCustomerName(countryCode) {
    const country = countryCode?.toUpperCase();
    return `Amazon | AMZ_B2C_${country}`;
  }

  /**
   * Get Odoo warehouse code for FBA country
   * @param {string} countryCode
   * @returns {string}
   */
  getOdooFbaWarehouseCode(countryCode) {
    const country = countryCode?.toLowerCase();
    // Your warehouses are like "de1", "fr1", etc.
    return `${country}1`;
  }

  /**
   * Check if country is EU member
   * @param {string} countryCode
   * @returns {boolean}
   */
  isEuCountry(countryCode) {
    const info = this.getCountryInfo(countryCode);
    return info && info.isEU !== false;
  }

  /**
   * Check if country has dedicated VAT registration
   * @param {string} countryCode
   * @returns {boolean}
   */
  hasVatRegistration(countryCode) {
    return VAT_REGISTERED_COUNTRIES.includes(countryCode?.toUpperCase());
  }

  /**
   * Get all EU countries
   * @returns {Array}
   */
  getAllCountries() {
    return Object.entries(EU_COUNTRIES).map(([code, info]) => ({
      code,
      ...info
    }));
  }

  /**
   * Get countries with VAT registration
   * @returns {string[]}
   */
  getVatRegisteredCountries() {
    return [...VAT_REGISTERED_COUNTRIES];
  }

  /**
   * Determine invoice configuration from Amazon order data
   * @param {object} params
   * @param {string} params.marketplaceId - Amazon marketplace
   * @param {string} params.fulfillmentCenter - FC code if FBA
   * @param {string} params.buyerCountry - 2-letter country
   * @param {string} params.buyerVat - VAT number if B2B
   * @returns {object} { journalCode, fiscalPosition, isB2B, shipFromCountry, buyerCountry }
   */
  getInvoiceConfig({ marketplaceId, fulfillmentCenter, buyerCountry, buyerVat }) {
    // Determine ship-from country
    let shipFromCountry = null;

    // Try FC first (most accurate for FBA)
    if (fulfillmentCenter) {
      shipFromCountry = this.getCountryFromFulfillmentCenter(fulfillmentCenter);
    }

    // Fallback to marketplace country
    if (!shipFromCountry && marketplaceId) {
      shipFromCountry = this.getCountryFromMarketplace(marketplaceId);
    }

    // Default to Belgium if unknown
    if (!shipFromCountry) {
      shipFromCountry = 'BE';
    }

    const isB2B = !!buyerVat && buyerVat.length > 5;
    const buyerCountryUpper = buyerCountry?.toUpperCase() || shipFromCountry;

    return {
      journalCode: this.getJournalCode(shipFromCountry),
      fiscalPosition: this.getFiscalPosition(shipFromCountry, buyerCountryUpper, isB2B),
      isB2B,
      shipFromCountry,
      buyerCountry: buyerCountryUpper,
      genericCustomer: this.getGenericCustomerName(buyerCountryUpper)
    };
  }
}

// Singleton
const euCountryConfig = new EuCountryConfig();

module.exports = { EuCountryConfig, euCountryConfig, EU_COUNTRIES, VAT_REGISTERED_COUNTRIES, MARKETPLACE_TO_COUNTRY, FBA_WAREHOUSE_COUNTRY };
