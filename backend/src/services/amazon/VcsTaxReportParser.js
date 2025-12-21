/**
 * VCS Tax Report Parser
 *
 * Parses Amazon VCS (VAT Calculation Service) Tax Reports
 * and prepares data for Odoo invoice creation.
 *
 * Report is manually downloaded from:
 * Amazon Seller Central → Reports → Tax Document Library → VAT Transaction Report
 */

const { parse } = require('csv-parse/sync');
const { getDb } = require('../../db');

// Column mappings for VCS Tax Report
const COLUMN_MAP = {
  marketplaceId: 'Marketplace ID',
  merchantId: 'Merchant ID',
  orderDate: 'Order Date',
  transactionType: 'Transaction Type',
  isInvoiceCorrected: 'Is Invoice Corrected',
  orderId: 'Order ID',
  shipmentDate: 'Shipment Date',
  shipmentId: 'Shipment ID',
  transactionId: 'Transaction ID',
  asin: 'ASIN',
  sku: 'SKU',
  quantity: 'Quantity',
  taxCalculationDate: 'Tax Calculation Date',
  taxRate: 'Tax Rate',
  productTaxCode: 'Product Tax Code',
  currency: 'Currency',
  taxType: 'Tax Type',
  taxCalculationReasonCode: 'Tax Calculation Reason Code',
  taxReportingScheme: 'Tax Reporting Scheme',
  taxCollectionResponsibility: 'Tax Collection Responsibility',
  taxAddressRole: 'Tax Address Role',
  jurisdictionLevel: 'Jurisdiction Level',
  jurisdictionName: 'Jurisdiction Name',
  // Price fields
  priceInclusive: 'OUR_PRICE Tax Inclusive Selling Price',
  taxAmount: 'OUR_PRICE Tax Amount',
  priceExclusive: 'OUR_PRICE Tax Exclusive Selling Price',
  promoInclusive: 'OUR_PRICE Tax Inclusive Promo Amount',
  promoTax: 'OUR_PRICE Tax Amount Promo',
  promoExclusive: 'OUR_PRICE Tax Exclusive Promo Amount',
  // Shipping
  shippingInclusive: 'SHIPPING Tax Inclusive Selling Price',
  shippingTax: 'SHIPPING Tax Amount',
  shippingExclusive: 'SHIPPING Tax Exclusive Selling Price',
  shippingPromoInclusive: 'SHIPPING Tax Inclusive Promo Amount',
  shippingPromoTax: 'SHIPPING Tax Amount Promo',
  shippingPromoExclusive: 'SHIPPING Tax Exclusive Promo Amount',
  // Gift wrap
  giftWrapInclusive: 'GIFTWRAP Tax Inclusive Selling Price',
  giftWrapTax: 'GIFTWRAP Tax Amount',
  giftWrapExclusive: 'GIFTWRAP Tax Exclusive Selling Price',
  // Tax registration
  sellerTaxRegistration: 'Seller Tax Registration',
  sellerTaxJurisdiction: 'Seller Tax Registration Jurisdiction',
  buyerTaxRegistration: 'Buyer Tax Registration',
  buyerTaxJurisdiction: 'Buyer Tax Registration Jurisdiction',
  buyerTaxRegistrationType: 'Buyer Tax Registration Type',
  // Invoice
  vatInvoiceNumber: 'VAT Invoice Number',
  invoiceUrl: 'Invoice Url',
  // Shipping addresses
  exportOutsideEu: 'Export Outside EU',
  shipFromCity: 'Ship From City',
  shipFromState: 'Ship From State',
  shipFromCountry: 'Ship From Country',
  shipFromPostalCode: 'Ship From Postal Code',
  shipToCity: 'Ship To City',
  shipToState: 'Ship To State',
  shipToCountry: 'Ship To Country',
  shipToPostalCode: 'Ship To Postal Code',
  isAmazonInvoiced: 'Is Amazon Invoiced',
};

// VAT rates by country
const VAT_RATES = {
  'DE': 0.19,
  'FR': 0.20,
  'IT': 0.22,
  'ES': 0.21,
  'NL': 0.21,
  'BE': 0.21,
  'AT': 0.20,
  'PL': 0.23,
  'SE': 0.25,
  'GB': 0.20,
  'LU': 0.17,
  'CZ': 0.21,
  'CH': 0.077, // Swiss VAT
};

class VcsTaxReportParser {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Parse VCS Tax Report CSV content
   * @param {string|Buffer} csvContent - CSV file content
   * @returns {Array} Parsed transactions
   */
  parseCSV(csvContent) {
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relaxColumnCount: true,
    });

    return records.map(row => this.mapRow(row));
  }

  /**
   * Map CSV row to normalized transaction object
   * @param {object} row - CSV row
   * @returns {object} Normalized transaction
   */
  mapRow(row) {
    return {
      marketplaceId: row[COLUMN_MAP.marketplaceId],
      merchantId: row[COLUMN_MAP.merchantId],
      orderDate: this.parseDate(row[COLUMN_MAP.orderDate]),
      transactionType: row[COLUMN_MAP.transactionType],
      isInvoiceCorrected: row[COLUMN_MAP.isInvoiceCorrected] === 'TRUE',
      orderId: row[COLUMN_MAP.orderId],
      shipmentDate: this.parseDate(row[COLUMN_MAP.shipmentDate]),
      shipmentId: row[COLUMN_MAP.shipmentId],
      transactionId: row[COLUMN_MAP.transactionId],
      asin: row[COLUMN_MAP.asin],
      sku: row[COLUMN_MAP.sku],
      quantity: parseInt(row[COLUMN_MAP.quantity], 10) || 1,
      taxCalculationDate: this.parseDate(row[COLUMN_MAP.taxCalculationDate]),
      taxRate: parseFloat(row[COLUMN_MAP.taxRate]) || 0,
      productTaxCode: row[COLUMN_MAP.productTaxCode],
      currency: row[COLUMN_MAP.currency],
      taxType: row[COLUMN_MAP.taxType],
      taxReportingScheme: row[COLUMN_MAP.taxReportingScheme],
      taxCollectionResponsibility: row[COLUMN_MAP.taxCollectionResponsibility],

      // Prices
      priceInclusive: parseFloat(row[COLUMN_MAP.priceInclusive]) || 0,
      taxAmount: parseFloat(row[COLUMN_MAP.taxAmount]) || 0,
      priceExclusive: parseFloat(row[COLUMN_MAP.priceExclusive]) || 0,
      promoAmount: parseFloat(row[COLUMN_MAP.promoExclusive]) || 0,

      // Shipping
      shippingInclusive: parseFloat(row[COLUMN_MAP.shippingInclusive]) || 0,
      shippingTax: parseFloat(row[COLUMN_MAP.shippingTax]) || 0,
      shippingExclusive: parseFloat(row[COLUMN_MAP.shippingExclusive]) || 0,
      // Shipping promo (discount)
      shippingPromoExclusive: parseFloat(row[COLUMN_MAP.shippingPromoExclusive]) || 0,

      // Tax registration
      sellerTaxRegistration: row[COLUMN_MAP.sellerTaxRegistration],
      sellerTaxJurisdiction: row[COLUMN_MAP.sellerTaxJurisdiction],
      buyerTaxRegistration: row[COLUMN_MAP.buyerTaxRegistration],
      buyerTaxJurisdiction: row[COLUMN_MAP.buyerTaxJurisdiction],
      buyerTaxRegistrationType: row[COLUMN_MAP.buyerTaxRegistrationType],

      // Invoice
      vatInvoiceNumber: row[COLUMN_MAP.vatInvoiceNumber],
      invoiceUrl: row[COLUMN_MAP.invoiceUrl],

      // Addresses
      exportOutsideEu: row[COLUMN_MAP.exportOutsideEu] === 'true',
      shipFromCountry: row[COLUMN_MAP.shipFromCountry],
      shipFromCity: row[COLUMN_MAP.shipFromCity],
      shipFromPostalCode: row[COLUMN_MAP.shipFromPostalCode],
      shipToCountry: row[COLUMN_MAP.shipToCountry],
      shipToCity: row[COLUMN_MAP.shipToCity],
      shipToPostalCode: row[COLUMN_MAP.shipToPostalCode],

      isAmazonInvoiced: row[COLUMN_MAP.isAmazonInvoiced] === 'true',
    };
  }

  /**
   * Parse Amazon date format "06-Dec-2025 UTC"
   * @param {string} dateStr
   * @returns {Date|null}
   */
  parseDate(dateStr) {
    if (!dateStr) return null;

    // Format: "06-Dec-2025 UTC"
    const match = dateStr.match(/(\d{2})-([A-Za-z]{3})-(\d{4})/);
    if (match) {
      const [, day, month, year] = match;
      const monthMap = {
        'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
        'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
      };
      return new Date(Date.UTC(parseInt(year), monthMap[month], parseInt(day)));
    }

    return new Date(dateStr);
  }

  /**
   * Group transactions by order ID for invoice creation
   * @param {Array} transactions
   * @returns {Map} Orders grouped by order ID
   */
  groupByOrder(transactions) {
    const orders = new Map();

    for (const tx of transactions) {
      // Skip non-shipment transactions (like returns)
      if (tx.transactionType !== 'SHIPMENT') continue;

      if (!orders.has(tx.orderId)) {
        orders.set(tx.orderId, {
          orderId: tx.orderId,
          orderDate: tx.orderDate,
          shipmentDate: tx.shipmentDate,
          currency: tx.currency,
          marketplaceId: tx.marketplaceId,
          vatInvoiceNumber: tx.vatInvoiceNumber,
          invoiceUrl: tx.invoiceUrl,
          sellerTaxRegistration: tx.sellerTaxRegistration,
          sellerTaxJurisdiction: tx.sellerTaxJurisdiction,
          buyerTaxRegistration: tx.buyerTaxRegistration,
          taxReportingScheme: tx.taxReportingScheme,
          shipFromCountry: tx.shipFromCountry,
          shipToCountry: tx.shipToCountry,
          shipToCity: tx.shipToCity,
          shipToPostalCode: tx.shipToPostalCode,
          exportOutsideEu: tx.exportOutsideEu,
          isAmazonInvoiced: tx.isAmazonInvoiced,
          items: [],
          totalExclusive: 0,
          totalTax: 0,
          totalInclusive: 0,
          totalShipping: 0,
          totalShippingTax: 0,
          totalShippingPromo: 0,
        });
      }

      const order = orders.get(tx.orderId);

      // Add item
      order.items.push({
        sku: tx.sku,
        asin: tx.asin,
        quantity: tx.quantity,
        priceExclusive: tx.priceExclusive,
        taxAmount: tx.taxAmount,
        priceInclusive: tx.priceInclusive,
        taxRate: tx.taxRate,
        promoAmount: tx.promoAmount,
        shippingExclusive: tx.shippingExclusive,
        shippingTax: tx.shippingTax,
      });

      // Update totals
      order.totalExclusive += tx.priceExclusive - tx.promoAmount;
      order.totalTax += tx.taxAmount;
      order.totalInclusive += tx.priceInclusive - (parseFloat(tx.promoInclusive) || 0);
      order.totalShipping += tx.shippingExclusive;
      order.totalShippingTax += tx.shippingTax;
      order.totalShippingPromo += tx.shippingPromoExclusive;
    }

    return orders;
  }

  /**
   * Filter orders that need to be invoiced (seller responsibility)
   * @param {Map} orders
   * @returns {Array} Orders to invoice
   */
  filterInvoiceableOrders(orders) {
    const invoiceable = [];

    for (const order of orders.values()) {
      // Only invoice orders where seller has tax responsibility
      // Skip deemed reseller orders (Amazon handles VAT)
      const isDeemed = order.taxReportingScheme === 'DEEMED_RESELLER';

      // We need to create invoices for:
      // 1. VCS_EU_OSS orders (selling from BE to other EU countries)
      // 2. Direct sales where seller has tax responsibility
      // Skip: DEEMED_RESELLER (Amazon invoices), CH_VOEC (Swiss low-value)

      if (!isDeemed && order.taxReportingScheme !== 'CH_VOEC') {
        invoiceable.push(order);
      }
    }

    return invoiceable;
  }

  /**
   * Determine which VAT registration and fiscal position to use
   * @param {object} order
   * @returns {object} VAT config
   */
  determineVatConfig(order) {
    const config = {
      sellerVat: order.sellerTaxRegistration,
      sellerCountry: order.sellerTaxJurisdiction,
      customerVat: order.buyerTaxRegistration,
      customerCountry: order.shipToCountry,
      taxRate: 0,
      fiscalPosition: null,
      journalCode: 'AMZN', // Default Amazon journal
    };

    // Determine tax rate based on destination country
    if (order.items.length > 0 && order.items[0].taxRate > 0) {
      config.taxRate = order.items[0].taxRate;
    } else {
      config.taxRate = VAT_RATES[order.shipToCountry] || 0.21;
    }

    // Determine fiscal position based on seller VAT registration
    // OSS: Selling from BE to other EU countries under OSS
    if (order.taxReportingScheme === 'VCS_EU_OSS') {
      config.fiscalPosition = 'OSS';
      config.journalCode = 'OSS'; // OSS journal if exists
    }
    // B2B: Customer has VAT number (reverse charge)
    else if (order.buyerTaxRegistration && order.buyerTaxRegistration !== order.sellerTaxRegistration) {
      config.fiscalPosition = 'B2B_EU';
      config.taxRate = 0; // Reverse charge
    }
    // Export outside EU
    else if (order.exportOutsideEu) {
      config.fiscalPosition = 'EXPORT';
      config.taxRate = 0;
    }

    return config;
  }

  /**
   * Store parsed report in database
   * @param {string} filename - Original filename
   * @param {Array} transactions - Parsed transactions
   * @param {Map} orders - Grouped orders
   * @returns {object} Storage result
   */
  async storeReport(filename, transactions, orders) {
    const db = getDb();

    const doc = {
      filename,
      uploadedAt: new Date(),
      transactionCount: transactions.length,
      orderCount: orders.size,
      dateRange: {
        from: this.getMinDate(transactions),
        to: this.getMaxDate(transactions),
      },
      summary: {
        totalExclusive: 0,
        totalTax: 0,
        totalInclusive: 0,
        currencies: new Set(),
        countries: new Set(),
      },
      status: 'pending',
    };

    // Calculate summary
    for (const order of orders.values()) {
      doc.summary.totalExclusive += order.totalExclusive;
      doc.summary.totalTax += order.totalTax;
      doc.summary.totalInclusive += order.totalInclusive;
      doc.summary.currencies.add(order.currency);
      doc.summary.countries.add(order.shipToCountry);
    }

    doc.summary.currencies = Array.from(doc.summary.currencies);
    doc.summary.countries = Array.from(doc.summary.countries);

    const result = await db.collection('amazon_vcs_reports').insertOne(doc);

    // Store individual orders for processing
    const orderDocs = Array.from(orders.values()).map(order => ({
      reportId: result.insertedId,
      ...order,
      status: 'pending',
      createdAt: new Date(),
    }));

    if (orderDocs.length > 0) {
      await db.collection('amazon_vcs_orders').insertMany(orderDocs);
    }

    return {
      reportId: result.insertedId.toString(),
      transactionCount: transactions.length,
      orderCount: orders.size,
      summary: doc.summary,
    };
  }

  /**
   * Get minimum date from transactions
   */
  getMinDate(transactions) {
    const dates = transactions.map(t => t.orderDate).filter(d => d);
    return dates.length > 0 ? new Date(Math.min(...dates)) : null;
  }

  /**
   * Get maximum date from transactions
   */
  getMaxDate(transactions) {
    const dates = transactions.map(t => t.orderDate).filter(d => d);
    return dates.length > 0 ? new Date(Math.max(...dates)) : null;
  }

  /**
   * Process uploaded VCS report file
   * @param {string|Buffer} content - File content
   * @param {string} filename - Original filename
   * @returns {object} Processing result
   */
  async processReport(content, filename) {
    // Parse CSV
    const transactions = this.parseCSV(content);

    // Group by order
    const orders = this.groupByOrder(transactions);

    // Store in database
    const result = await this.storeReport(filename, transactions, orders);

    // Get invoiceable orders
    const invoiceable = this.filterInvoiceableOrders(orders);

    return {
      ...result,
      invoiceableOrders: invoiceable.length,
      readyForImport: invoiceable.length > 0,
    };
  }
}

module.exports = { VcsTaxReportParser, VAT_RATES, COLUMN_MAP };
