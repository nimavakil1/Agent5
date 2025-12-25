/**
 * VendorClient - Amazon Vendor Central SP-API Client
 *
 * Handles all SP-API communication for Vendor Central operations.
 * Supports multiple marketplaces with per-marketplace refresh tokens.
 *
 * @module VendorClient
 */

const SellingPartner = require('amazon-sp-api');

/**
 * Amazon Marketplace IDs for EU
 */
const MARKETPLACE_IDS = {
  UK: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYBER',
  IT: 'APJ6JRA9NG5V4',
  ES: 'A1RKKUPIHCS9HS',
  NL: 'A1805IZSGTT6HS',
  SE: 'A2NODRKZP88ZB9',
  PL: 'A1C3SOZRARQ6R3',
  BE: 'AMEN7PMS3EDWL'
};

/**
 * Vendor Token Environment Variable Mapping
 * Maps marketplace codes to their refresh token env vars
 */
const VENDOR_TOKEN_MAP = {
  FR: 'AMAZON_VENDOR_REFRESH_TOKEN_FR',
  DE: 'AMAZON_VENDOR_REFRESH_TOKEN_DE',
  NL: 'AMAZON_VENDOR_REFRESH_TOKEN_NL',
  UK: 'AMAZON_VENDOR_REFRESH_TOKEN_UK',
  IT: 'AMAZON_VENDOR_REFRESH_TOKEN_IT',
  ES: 'AMAZON_VENDOR_REFRESH_TOKEN_ES',
  SE: 'AMAZON_VENDOR_REFRESH_TOKEN_SE',
  PL: 'AMAZON_VENDOR_REFRESH_TOKEN_PL',
  DE_FR: 'AMAZON_VENDOR_REFRESH_TOKEN_DE_FR' // Pan-EU from DE
};

/**
 * Vendor Account Configuration
 * Based on Emipro accounts in Odoo
 */
const VENDOR_ACCOUNTS = {
  // Acropaq FR Office Products - France
  FR: {
    name: 'Acropaq FR Office Products',
    vendorCode: 'C86K8',
    tokenKey: 'FR',
    marketplaceIds: [MARKETPLACE_IDS.FR]
  },
  // Acropaq DE Office Products - Pan-EU from Germany
  DE: {
    name: 'Acropaq DE Office Products',
    vendorCode: '5O6JS',
    tokenKey: 'DE',
    marketplaceIds: [
      MARKETPLACE_IDS.DE,
      MARKETPLACE_IDS.FR,
      MARKETPLACE_IDS.IT,
      MARKETPLACE_IDS.ES,
      MARKETPLACE_IDS.NL,
      MARKETPLACE_IDS.SE,
      MARKETPLACE_IDS.PL,
      MARKETPLACE_IDS.UK
    ]
  },
  // Acropaq NL Office Products - Pan-EU from Netherlands
  NL: {
    name: 'Acropaq NL Office Products',
    vendorCode: 'HN6VB',
    tokenKey: 'NL',
    marketplaceIds: [
      MARKETPLACE_IDS.NL,
      MARKETPLACE_IDS.DE,
      MARKETPLACE_IDS.FR,
      MARKETPLACE_IDS.IT,
      MARKETPLACE_IDS.ES,
      MARKETPLACE_IDS.SE,
      MARKETPLACE_IDS.PL,
      MARKETPLACE_IDS.UK
    ]
  }
};

/**
 * Purchase Order States
 */
const PO_STATES = {
  NEW: 'New',
  ACKNOWLEDGED: 'Acknowledged',
  CLOSED: 'Closed'
};

/**
 * Purchase Order Types
 */
const PO_TYPES = {
  REGULAR: 'RegularOrder',
  RUSH: 'RushOrder',
  CONSIGNED: 'ConsignedOrder',
  NEW_PRODUCT: 'NewProductIntroduction'
};

/**
 * VendorClient - SP-API client for Vendor Central
 */
class VendorClient {
  /**
   * Create a VendorClient instance
   * @param {string} marketplace - Marketplace code (FR, DE, NL, etc.)
   */
  constructor(marketplace = 'DE') {
    this.marketplace = marketplace.toUpperCase();
    this.marketplaceId = MARKETPLACE_IDS[this.marketplace];

    if (!this.marketplaceId) {
      throw new Error(`Unknown marketplace: ${marketplace}`);
    }

    // Determine which token to use
    this.tokenKey = this._getTokenKey(this.marketplace);
    const tokenEnvVar = VENDOR_TOKEN_MAP[this.tokenKey];

    if (!tokenEnvVar || !process.env[tokenEnvVar]) {
      throw new Error(`No refresh token configured for marketplace ${marketplace} (expected ${tokenEnvVar})`);
    }

    this.config = {
      region: 'eu',
      refresh_token: process.env[tokenEnvVar],
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_SP_LWA_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_SP_LWA_CLIENT_SECRET
      },
      options: {
        auto_request_tokens: true,
        auto_request_throttled: true,
        version_fallback: true,
        use_sandbox: process.env.AMAZON_USE_SANDBOX === 'true'
      }
    };

    this.client = null;
  }

  /**
   * Determine which token key to use for a marketplace
   * Some marketplaces share tokens (Pan-EU)
   */
  _getTokenKey(marketplace) {
    // Direct token mappings
    if (VENDOR_TOKEN_MAP[marketplace]) {
      return marketplace;
    }

    // For BE and other EU, use DE (Pan-EU)
    if (['BE'].includes(marketplace)) {
      return 'DE';
    }

    return marketplace;
  }

  /**
   * Initialize the SP-API client
   */
  async init() {
    if (this.client) return this.client;

    try {
      this.client = new SellingPartner(this.config);
      return this.client;
    } catch (error) {
      throw new Error(`Failed to initialize Vendor SP-API client: ${error.message}`);
    }
  }

  /**
   * Get client (initializes if needed)
   */
  async getClient() {
    if (!this.client) {
      await this.init();
    }
    return this.client;
  }

  // ==================== VENDOR ORDERS API ====================

  /**
   * Get purchase orders
   * @param {Object} params - Query parameters
   * @param {string} params.createdAfter - ISO date string
   * @param {string} params.createdBefore - ISO date string
   * @param {string} params.purchaseOrderState - PO state filter
   * @param {number} params.limit - Max results
   */
  async getPurchaseOrders(params = {}) {
    const client = await this.getClient();

    const queryParams = {
      ...(params.createdAfter && { createdAfter: params.createdAfter }),
      ...(params.createdBefore && { createdBefore: params.createdBefore }),
      ...(params.changedAfter && { changedAfter: params.changedAfter }),
      ...(params.changedBefore && { changedBefore: params.changedBefore }),
      ...(params.purchaseOrderState && { purchaseOrderState: params.purchaseOrderState }),
      ...(params.orderingVendorCode && { orderingVendorCode: params.orderingVendorCode }),
      ...(params.limit && { limit: params.limit }),
      ...(params.sortOrder && { sortOrder: params.sortOrder }),
      ...(params.nextToken && { nextToken: params.nextToken })
    };

    return client.callAPI({
      operation: 'vendorOrders.getPurchaseOrders',
      query: queryParams
    });
  }

  /**
   * Get a specific purchase order
   * @param {string} purchaseOrderNumber - The PO number
   */
  async getPurchaseOrder(purchaseOrderNumber) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'vendorOrders.getPurchaseOrder',
      path: { purchaseOrderNumber }
    });
  }

  /**
   * Submit purchase order acknowledgement
   * @param {Object} acknowledgement - Acknowledgement data
   */
  async submitAcknowledgement(acknowledgement) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'vendorOrders.submitAcknowledgement',
      body: acknowledgement
    });
  }

  /**
   * Get purchase order status
   * @param {Object} params - Query parameters
   */
  async getPurchaseOrdersStatus(params = {}) {
    const client = await this.getClient();

    const queryParams = {
      ...(params.createdAfter && { createdAfter: params.createdAfter }),
      ...(params.createdBefore && { createdBefore: params.createdBefore }),
      ...(params.purchaseOrderNumber && { purchaseOrderNumber: params.purchaseOrderNumber }),
      ...(params.purchaseOrderStatus && { purchaseOrderStatus: params.purchaseOrderStatus }),
      ...(params.limit && { limit: params.limit })
    };

    return client.callAPI({
      operation: 'vendorOrders.getPurchaseOrdersStatus',
      query: queryParams
    });
  }

  // ==================== VENDOR DIRECT FULFILLMENT ORDERS ====================

  /**
   * Get direct fulfillment orders (dropship)
   * @param {Object} params - Query parameters
   */
  async getDirectFulfillmentOrders(params = {}) {
    const client = await this.getClient();

    const queryParams = {
      createdAfter: params.createdAfter,
      createdBefore: params.createdBefore,
      ...(params.status && { status: params.status }),
      ...(params.limit && { limit: params.limit })
    };

    return client.callAPI({
      operation: 'vendorDirectFulfillmentOrders.getOrders',
      query: queryParams
    });
  }

  // ==================== VENDOR INVOICES API ====================

  /**
   * Submit vendor invoices to Amazon
   * @param {Object} invoices - Invoice data
   */
  async submitInvoices(invoices) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'vendorInvoices.submitInvoices',
      body: invoices
    });
  }

  // ==================== VENDOR SHIPMENTS API ====================

  /**
   * Submit shipment confirmations (ASN)
   * @param {Object} shipmentConfirmations - Shipment data
   */
  async submitShipmentConfirmations(shipmentConfirmations) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'vendorShipments.SubmitShipmentConfirmations',
      body: shipmentConfirmations
    });
  }

  /**
   * Get shipment details
   * @param {Object} params - Query parameters
   */
  async getShipmentDetails(params = {}) {
    const client = await this.getClient();

    const queryParams = {
      ...(params.createdAfter && { createdAfter: params.createdAfter }),
      ...(params.createdBefore && { createdBefore: params.createdBefore }),
      ...(params.shipmentConfirmedBefore && { shipmentConfirmedBefore: params.shipmentConfirmedBefore }),
      ...(params.shipmentConfirmedAfter && { shipmentConfirmedAfter: params.shipmentConfirmedAfter }),
      ...(params.limit && { limit: params.limit })
    };

    return client.callAPI({
      operation: 'vendorShipments.GetShipmentDetails',
      query: queryParams
    });
  }

  /**
   * Submit shipments
   * @param {Object} shipments - Shipment data
   */
  async submitShipments(shipments) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'vendorShipments.SubmitShipments',
      body: shipments
    });
  }

  // ==================== VENDOR REPORTS API ====================

  /**
   * Create a vendor report request
   * @param {string} reportType - Report type (e.g., GET_VENDOR_SALES_REPORT)
   * @param {Object} options - Report options
   */
  async createReport(reportType, options = {}) {
    const client = await this.getClient();

    const body = {
      reportType,
      marketplaceIds: [this.marketplaceId],
      ...(options.dataStartTime && { dataStartTime: options.dataStartTime }),
      ...(options.dataEndTime && { dataEndTime: options.dataEndTime }),
      ...(options.reportOptions && { reportOptions: options.reportOptions })
    };

    return client.callAPI({
      operation: 'reports.createReport',
      body
    });
  }

  /**
   * Get report status
   * @param {string} reportId - Report ID
   */
  async getReportStatus(reportId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'reports.getReport',
      path: { reportId }
    });
  }

  /**
   * Get report document
   * @param {string} reportDocumentId - Report document ID
   */
  async getReportDocument(reportDocumentId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'reports.getReportDocument',
      path: { reportDocumentId }
    });
  }

  /**
   * Download and parse a report document
   * @param {string} reportDocumentId - Report document ID
   */
  async downloadReport(reportDocumentId) {
    const https = require('https');
    const zlib = require('zlib');

    const doc = await this.getReportDocument(reportDocumentId);

    const data = await new Promise((resolve, reject) => {
      https.get(doc.url, (response) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      });
    });

    let content;
    if (doc.compressionAlgorithm === 'GZIP') {
      content = zlib.gunzipSync(data).toString('utf8');
    } else {
      content = data.toString('utf8');
    }

    // Try to parse as JSON
    try {
      return JSON.parse(content);
    } catch {
      return content; // Return raw content if not JSON
    }
  }

  /**
   * Request and wait for a vendor report
   * @param {string} reportType - Report type
   * @param {Object} options - Report options including date range
   * @param {number} maxWaitMs - Max wait time in milliseconds (default 60000)
   */
  async fetchReport(reportType, options = {}, maxWaitMs = 60000) {
    // Create report request
    const createResult = await this.createReport(reportType, options);
    const reportId = createResult.reportId;

    // Poll for completion
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, 5000));

      const status = await this.getReportStatus(reportId);

      if (status.processingStatus === 'DONE') {
        return this.downloadReport(status.reportDocumentId);
      }

      if (status.processingStatus === 'FATAL' || status.processingStatus === 'CANCELLED') {
        // Try to get error details
        if (status.reportDocumentId) {
          const errorDoc = await this.downloadReport(status.reportDocumentId);
          throw new Error(`Report failed: ${JSON.stringify(errorDoc)}`);
        }
        throw new Error(`Report failed with status: ${status.processingStatus}`);
      }
    }

    throw new Error(`Report timed out after ${maxWaitMs}ms`);
  }

  /**
   * Fetch vendor sales report
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   */
  async fetchSalesReport(startDate, endDate) {
    return this.fetchReport('GET_VENDOR_SALES_REPORT', {
      dataStartTime: startDate.toISOString(),
      dataEndTime: endDate.toISOString(),
      reportOptions: {
        reportPeriod: 'DAY',
        distributorView: 'MANUFACTURING',
        sellingProgram: 'RETAIL'
      }
    });
  }

  /**
   * Fetch vendor inventory report
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   */
  async fetchInventoryReport(startDate, endDate) {
    return this.fetchReport('GET_VENDOR_INVENTORY_REPORT', {
      dataStartTime: startDate.toISOString(),
      dataEndTime: endDate.toISOString(),
      reportOptions: {
        reportPeriod: 'DAY',
        sellingProgram: 'RETAIL'
      }
    });
  }

  /**
   * Fetch vendor traffic report
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   */
  async fetchTrafficReport(startDate, endDate) {
    return this.fetchReport('GET_VENDOR_TRAFFIC_REPORT', {
      dataStartTime: startDate.toISOString(),
      dataEndTime: endDate.toISOString(),
      reportOptions: {
        reportPeriod: 'DAY',
        sellingProgram: 'RETAIL'
      }
    });
  }

  // ==================== VENDOR TRANSACTION STATUS ====================

  /**
   * Get transaction status for submitted data
   * @param {string} transactionId - Transaction ID from submit operation
   */
  async getTransactionStatus(transactionId) {
    const client = await this.getClient();

    return client.callAPI({
      operation: 'vendorTransactionStatus.getTransaction',
      path: { transactionId }
    });
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Poll for new purchase orders
   * @param {number} daysBack - Number of days to look back (default 7)
   */
  async pollNewPurchaseOrders(daysBack = 7) {
    const createdAfter = new Date();
    createdAfter.setDate(createdAfter.getDate() - daysBack);

    return this.getPurchaseOrders({
      createdAfter: createdAfter.toISOString(),
      purchaseOrderState: PO_STATES.NEW,
      sortOrder: 'DESC'
    });
  }

  /**
   * Get all purchase orders including paginated results
   * @param {Object} params - Query parameters
   */
  async getAllPurchaseOrders(params = {}) {
    const allOrders = [];
    let nextToken = null;
    let hasMore = true;

    while (hasMore) {
      const queryParams = {
        ...params,
        ...(nextToken && { nextToken })
      };

      const response = await this.getPurchaseOrders(queryParams);

      if (response.orders && response.orders.length > 0) {
        allOrders.push(...response.orders);
      }

      nextToken = response.pagination?.nextToken;
      hasMore = !!nextToken;

      // Safety limit
      if (allOrders.length > 1000) {
        console.warn('VendorClient: Reached 1000 order limit, stopping pagination');
        break;
      }
    }

    return allOrders;
  }

  /**
   * Build acknowledgement payload for a PO
   * @param {string} purchaseOrderNumber - PO number
   * @param {string} acknowledgementCode - 'Accepted', 'Backordered', 'Rejected'
   * @param {Array} items - Item acknowledgements
   */
  buildAcknowledgement(purchaseOrderNumber, acknowledgementCode, items = []) {
    return {
      acknowledgements: [{
        purchaseOrderNumber,
        sellingParty: {
          partyId: process.env.AMAZON_VENDOR_PARTY_ID || 'ACROPAQ'
        },
        acknowledgementDate: new Date().toISOString(),
        items: items.map(item => ({
          itemSequenceNumber: item.itemSequenceNumber,
          amazonProductIdentifier: item.asin,
          vendorProductIdentifier: item.sku,
          orderedQuantity: item.orderedQuantity,
          netCost: item.netCost,
          acknowledgedQuantity: {
            amount: item.acknowledgedQuantity || item.orderedQuantity.amount,
            unitOfMeasure: item.orderedQuantity.unitOfMeasure
          },
          acknowledgementCode
        }))
      }]
    };
  }

  /**
   * Build invoice payload for a PO
   * @param {Object} invoiceData - Invoice details
   */
  buildInvoice(invoiceData) {
    return {
      invoices: [{
        invoiceType: invoiceData.type || 'Invoice',
        id: invoiceData.invoiceNumber,
        date: invoiceData.date || new Date().toISOString().split('T')[0],
        remitToParty: invoiceData.remitToParty,
        shipToParty: invoiceData.shipToParty,
        billToParty: invoiceData.billToParty,
        shipFromParty: invoiceData.shipFromParty,
        invoiceTotal: invoiceData.total,
        taxDetails: invoiceData.taxDetails,
        items: invoiceData.items.map(item => ({
          itemSequenceNumber: item.itemSequenceNumber,
          amazonProductIdentifier: item.asin,
          vendorProductIdentifier: item.sku,
          invoicedQuantity: item.quantity,
          netCost: item.netCost,
          purchaseOrderNumber: item.purchaseOrderNumber
        }))
      }]
    };
  }

  /**
   * Build shipment confirmation (ASN) payload
   * @param {Object} shipmentData - Shipment details
   */
  buildShipmentConfirmation(shipmentData) {
    return {
      shipmentConfirmations: [{
        shipmentIdentifier: shipmentData.shipmentId,
        shipmentConfirmationType: 'Original',
        shipmentType: shipmentData.type || 'TruckLoad',
        shippedDate: shipmentData.shippedDate || new Date().toISOString(),
        estimatedDeliveryDate: shipmentData.estimatedDeliveryDate,
        sellingParty: shipmentData.sellingParty,
        shipFromParty: shipmentData.shipFromParty,
        shipToParty: shipmentData.shipToParty,
        shipmentMeasurements: shipmentData.measurements,
        transportationDetails: {
          carrierScac: shipmentData.carrierCode,
          carrierShipmentReferenceNumber: shipmentData.trackingNumber,
          transportationMode: shipmentData.transportationMode || 'Road'
        },
        shippedItems: shipmentData.items.map(item => ({
          itemSequenceNumber: item.itemSequenceNumber,
          amazonProductIdentifier: item.asin,
          vendorProductIdentifier: item.sku,
          shippedQuantity: item.quantity,
          itemDetails: {
            purchaseOrderNumber: item.purchaseOrderNumber
          }
        }))
      }]
    };
  }
}

/**
 * Factory function to create clients for all configured marketplaces
 */
function createAllVendorClients() {
  const clients = {};

  for (const [marketplace, tokenKey] of Object.entries(VENDOR_TOKEN_MAP)) {
    try {
      // Skip _FR suffix variant
      if (marketplace === 'DE_FR') continue;

      clients[marketplace] = new VendorClient(marketplace);
    } catch (error) {
      console.warn(`VendorClient: Could not create client for ${marketplace}: ${error.message}`);
    }
  }

  return clients;
}

module.exports = {
  VendorClient,
  createAllVendorClients,
  MARKETPLACE_IDS,
  VENDOR_TOKEN_MAP,
  VENDOR_ACCOUNTS,
  PO_STATES,
  PO_TYPES
};
