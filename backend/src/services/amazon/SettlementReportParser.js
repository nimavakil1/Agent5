/**
 * Amazon Settlement Report Parser
 *
 * Parses Amazon Flat File V2 Settlement Reports for RECONCILIATION ONLY.
 *
 * NOTE: Vendor bills are NOT created from settlement reports - they come
 * from PEPPOL invoices sent by Amazon. This parser aggregates fee data
 * for reconciliation against those PEPPOL invoices.
 *
 * KEY PRINCIPLE: Amazon collects payment for ALL orders and deducts fees.
 * Both sales AND fees are tracked per marketplace for reconciliation.
 *
 * Settlement Report Columns (Flat File V2):
 * - settlement-id, settlement-start-date, settlement-end-date, deposit-date
 * - total-amount, currency, transaction-type, order-id, merchant-order-id
 * - adjustment-id, shipment-id, marketplace-name, amount-type, amount-description
 * - amount, fulfillment-id, posted-date, posted-date-time
 * - order-item-code, merchant-order-item-id, merchant-adjustment-item-id
 * - sku, quantity-purchased, promotion-id
 */

const { getDb } = require('../../db');

// Marketplace name to country code mapping
const MARKETPLACE_TO_COUNTRY = {
  'Amazon.de': 'DE',
  'Amazon.fr': 'FR',
  'Amazon.it': 'IT',
  'Amazon.es': 'ES',
  'Amazon.nl': 'NL',
  'Amazon.co.uk': 'GB',
  'Amazon.com.be': 'BE',
  'Amazon.pl': 'PL',
  'Amazon.se': 'SE',
  'Amazon.com.tr': 'TR',
  // Also accept short names
  'DE': 'DE',
  'FR': 'FR',
  'IT': 'IT',
  'ES': 'ES',
  'NL': 'NL',
  'UK': 'GB',
  'GB': 'GB',
  'BE': 'BE',
  'PL': 'PL',
  'SE': 'SE',
  'TR': 'TR',
};

// Marketplace-specific receivable account IDs (for reference - used by PEPPOL processor)
// These accounts are where both sales and Amazon fee vendor bills are booked
const MARKETPLACE_RECEIVABLE_ACCOUNTS = {
  'DE': 820,  // 400102DE Trade debtors - Amazon Seller Germany
  'FR': 821,  // 400102FR Trade debtors - Amazon Seller France
  'NL': 822,  // 400102NL Trade debtors - Amazon Seller Netherlands
  'ES': 823,  // 400102ES Trade debtors - Amazon Seller Spain
  'IT': 824,  // 400102IT Trade debtors - Amazon Seller Italy
  'SE': 825,  // 400102SE Trade debtors - Amazon Seller Sweden
  'PL': 826,  // 400102PL Trade debtors - Amazon Seller Poland
  'GB': 827,  // 400102UK Trade debtors - Amazon Seller United Kingdom
  'UK': 827,  // Alias for GB
  'BE': 828,  // 400102BE Trade debtors - Amazon Seller Belgium
  'TR': 829,  // 400102TR Trade debtors - Amazon Seller Turkey
};

// Transaction types that are fees (not order-related revenue)
const FEE_TRANSACTION_TYPES = [
  'ServiceFee',
  'FBA Inventory Fee',
  'Adjustment',
  'Subscription Fee',
  'Cost of Advertising',
  'Removal',
  'Disposal',
  'Liquidations',
  'Other',
];

// Transaction types that are order-related (already handled by VCS invoicing)
const ORDER_TRANSACTION_TYPES = [
  'Order',
  'Refund',
  'Chargeback',
];

class SettlementReportParser {
  constructor(odooClient) {
    this.odoo = odooClient;
  }

  /**
   * Parse settlement report CSV/TSV buffer
   */
  parseReport(buffer) {
    const content = buffer.toString('utf-8');
    const lines = content.split(/\r?\n/);

    // Detect delimiter (tab or comma)
    const firstLine = lines[0] || '';
    const delimiter = firstLine.includes('\t') ? '\t' : ',';

    // Parse headers (convert to camelCase)
    const rawHeaders = this.parseLine(lines[0], delimiter);
    const headers = rawHeaders.map(h => this.toCamelCase(h.trim()));

    const transactions = [];
    let settlementId = null;
    let startDate = null;
    let endDate = null;
    let depositDate = null;
    let currency = null;
    let totalAmount = 0;

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = this.parseLine(line, delimiter);
      const row = {};

      headers.forEach((header, idx) => {
        let value = values[idx] || '';
        // Handle EU number format (95,00 -> 95.00)
        if (header === 'amount' || header === 'totalAmount') {
          value = this.parseAmount(value);
        }
        row[header] = value;
      });

      // Extract settlement metadata from first data row
      if (!settlementId && row.settlementId) {
        settlementId = row.settlementId;
      }
      if (!startDate && row.settlementStartDate) {
        startDate = this.parseDate(row.settlementStartDate);
      }
      if (!endDate && row.settlementEndDate) {
        endDate = this.parseDate(row.settlementEndDate);
      }
      if (!depositDate && row.depositDate) {
        depositDate = this.parseDate(row.depositDate);
      }
      if (!currency && row.currency) {
        currency = row.currency;
      }

      // Only include rows with amount
      if (row.amount !== undefined && row.amount !== '') {
        const amount = parseFloat(row.amount) || 0;
        totalAmount += amount;
        transactions.push({
          ...row,
          amount,
          marketplaceCountry: this.getMarketplaceCountry(row.marketplaceName),
        });
      }
    }

    return {
      settlementId: settlementId || `manual-${Date.now()}`,
      startDate,
      endDate,
      depositDate,
      currency: currency || 'EUR',
      totalAmount,
      transactionCount: transactions.length,
      transactions,
    };
  }

  /**
   * Parse a CSV/TSV line, handling quoted fields
   */
  parseLine(line, delimiter) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }

  /**
   * Convert header to camelCase
   */
  toCamelCase(str) {
    return str.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
  }

  /**
   * Parse amount from various formats
   */
  parseAmount(value) {
    if (!value || value === '') return 0;
    // Handle EU format: 1.234,56 -> 1234.56
    let normalized = value.toString()
      .replace(/[^0-9.,\-]/g, '')  // Remove non-numeric except . , -
      .replace(/\.(?=.*\.)/g, '')   // Remove all but last period
      .replace(',', '.');           // Replace comma with period
    return parseFloat(normalized) || 0;
  }

  /**
   * Parse date from various formats
   */
  parseDate(value) {
    if (!value) return null;
    // Try ISO format first
    let date = new Date(value);
    if (!isNaN(date.getTime())) return date;

    // Try MM/DD/YY format
    const mmddyy = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (mmddyy) {
      const year = mmddyy[3].length === 2 ? 2000 + parseInt(mmddyy[3]) : parseInt(mmddyy[3]);
      return new Date(year, parseInt(mmddyy[1]) - 1, parseInt(mmddyy[2]));
    }

    return null;
  }

  /**
   * Get marketplace country code from marketplace name
   */
  getMarketplaceCountry(marketplaceName) {
    if (!marketplaceName) return 'BE'; // Default to BE
    return MARKETPLACE_TO_COUNTRY[marketplaceName] || 'BE';
  }

  /**
   * Aggregate fees by marketplace and category for Odoo vendor bills
   */
  aggregateFees(transactions) {
    const feesByMarketplace = {};

    for (const tx of transactions) {
      const txType = tx.transactionType || '';
      const amountType = tx.amountType || '';
      const marketplace = tx.marketplaceCountry || 'BE';
      const amount = tx.amount || 0;

      // Skip order-related transactions (handled by VCS invoicing)
      if (ORDER_TRANSACTION_TYPES.some(t => txType.includes(t))) {
        continue;
      }

      // Initialize marketplace entry
      if (!feesByMarketplace[marketplace]) {
        feesByMarketplace[marketplace] = {
          commission: 0,
          fbaFulfillment: 0,
          fbaStorage: 0,
          fbaInbound: 0,
          fbaRemoval: 0,
          subscription: 0,
          advertising: 0,
          liquidations: 0,
          other: 0,
          total: 0,
        };
      }

      // Categorize the fee
      if (amountType.includes('Commission')) {
        feesByMarketplace[marketplace].commission += amount;
      } else if (amountType.includes('FBAPerOrder') || amountType.includes('FBAPerUnit') || amountType.includes('FBAWeight')) {
        feesByMarketplace[marketplace].fbaFulfillment += amount;
      } else if (amountType.includes('Storage')) {
        feesByMarketplace[marketplace].fbaStorage += amount;
      } else if (amountType.includes('Inbound') || amountType.includes('Transportation')) {
        feesByMarketplace[marketplace].fbaInbound += amount;
      } else if (amountType.includes('Removal') || amountType.includes('Disposal')) {
        feesByMarketplace[marketplace].fbaRemoval += amount;
      } else if (amountType.includes('Subscription')) {
        feesByMarketplace[marketplace].subscription += amount;
      } else if (amountType.includes('Advertising') || txType.includes('Advertising')) {
        feesByMarketplace[marketplace].advertising += amount;
      } else if (amountType.includes('Liquidation')) {
        feesByMarketplace[marketplace].liquidations += amount;
      } else {
        feesByMarketplace[marketplace].other += amount;
      }

      feesByMarketplace[marketplace].total += amount;
    }

    return feesByMarketplace;
  }

  /**
   * Calculate order-related totals by marketplace (for reconciliation)
   */
  aggregateOrderTotals(transactions) {
    const ordersByMarketplace = {};

    for (const tx of transactions) {
      const txType = tx.transactionType || '';
      const marketplace = tx.marketplaceCountry || 'BE';
      const amount = tx.amount || 0;

      // Only order-related transactions
      if (!ORDER_TRANSACTION_TYPES.some(t => txType.includes(t))) {
        continue;
      }

      if (!ordersByMarketplace[marketplace]) {
        ordersByMarketplace[marketplace] = {
          orders: 0,
          refunds: 0,
          chargebacks: 0,
          total: 0,
        };
      }

      if (txType.includes('Order')) {
        ordersByMarketplace[marketplace].orders += amount;
      } else if (txType.includes('Refund')) {
        ordersByMarketplace[marketplace].refunds += amount;
      } else if (txType.includes('Chargeback')) {
        ordersByMarketplace[marketplace].chargebacks += amount;
      }

      ordersByMarketplace[marketplace].total += amount;
    }

    return ordersByMarketplace;
  }

  /**
   * Process a settlement report end-to-end
   * NOTE: Vendor bills are NOT created here - they come from PEPPOL invoices
   * This parser is for reconciliation and reporting only
   */
  async processSettlement(buffer, options = {}) {
    const { dryRun = false } = options;

    // Parse the report
    const parsed = this.parseReport(buffer);

    // Aggregate fees by marketplace
    const feesByMarketplace = this.aggregateFees(parsed.transactions);

    // Aggregate order totals for reconciliation info
    const ordersByMarketplace = this.aggregateOrderTotals(parsed.transactions);

    // Store in MongoDB
    const db = getDb();
    const settlementDoc = {
      settlementId: parsed.settlementId,
      settlementStartDate: parsed.startDate,
      settlementEndDate: parsed.endDate,
      depositDate: parsed.depositDate,
      totalAmount: parsed.totalAmount,
      currency: parsed.currency,
      transactionCount: parsed.transactionCount,
      feesByMarketplace,
      ordersByMarketplace,
      source: 'csv-upload',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (!dryRun) {
      await db.collection('amazon_settlements').updateOne(
        { settlementId: parsed.settlementId },
        { $set: settlementDoc, $setOnInsert: { firstUploadedAt: new Date() } },
        { upsert: true }
      );
    }

    return {
      settlementId: parsed.settlementId,
      period: {
        start: parsed.startDate,
        end: parsed.endDate,
      },
      depositDate: parsed.depositDate,
      currency: parsed.currency,
      totalAmount: parsed.totalAmount,
      transactionCount: parsed.transactionCount,
      feesByMarketplace,
      ordersByMarketplace,
      dryRun,
    };
  }
}

module.exports = { SettlementReportParser };
