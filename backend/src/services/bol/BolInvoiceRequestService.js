/**
 * BolInvoiceRequestService - Handle customer invoice requests from Bol.com
 *
 * When customers (B2B or B2C) request an invoice on Bol.com, we need to:
 * 1. Fetch open invoice requests from Bol.com API
 * 2. Match to Odoo invoices using shipmentId → orderId → sale.order → invoice
 * 3. Download PDF from Odoo
 * 4. Upload PDF to Bol.com
 *
 * Bol.com API endpoints used:
 * - GET /retailer/shipments/invoices/requests - Get list of invoice requests
 * - POST /retailer/shipments/invoices/{shipment-id} - Upload invoice PDF
 *
 * Requirements:
 * - Invoice must be uploaded within 24 hours of request
 * - PDF format only, max 2MB
 * - Language must match customer's country
 */

const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const { TeamsNotificationService } = require('../../core/agents/services/TeamsNotificationService');
const BolShipment = require('../../models/BolShipment');
const { getDb } = require('../../db');

// Rate limiting configuration
const REQUEST_DELAY_MS = 100;
const MAX_RETRIES = 3;

// Token cache (shared)
let accessToken = null;
let tokenExpiry = null;

class BolInvoiceRequestService {
  constructor() {
    this.odoo = null;
    this.isRunning = false;
    this.lastRun = null;
    this.lastResult = null;
  }

  /**
   * Initialize the service
   */
  async init() {
    if (!this.odoo) {
      this.odoo = new OdooDirectClient();
      await this.odoo.authenticate();
    }
    return this;
  }

  /**
   * Get Bol.com access token
   */
  async getAccessToken() {
    const clientId = process.env.BOL_CLIENT_ID;
    const clientSecret = process.env.BOL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Bol.com credentials not configured');
    }

    // Check cached token
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 30000) {
      return accessToken;
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://login.bol.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${credentials}`
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
      throw new Error(`Failed to get Bol.com access token: ${await response.text()}`);
    }

    const data = await response.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000);

    return accessToken;
  }

  /**
   * Make a Bol.com API request with retry logic
   */
  async bolRequest(endpoint, method = 'GET', body = null, retries = MAX_RETRIES) {
    const token = await this.getAccessToken();

    const options = {
      method,
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Authorization': `Bearer ${token}`
      }
    };

    if (body && !(body instanceof Buffer)) {
      options.headers['Content-Type'] = 'application/vnd.retailer.v10+json';
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`https://api.bol.com/retailer${endpoint}`, options);

    // Handle rate limiting
    if (response.status === 429 && retries > 0) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
      console.log(`[BolInvoiceRequest] Rate limited, waiting ${retryAfter}s...`);
      await this.sleep(retryAfter * 1000);
      return this.bolRequest(endpoint, method, body, retries - 1);
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ detail: response.statusText }));
      const errorMsg = errorBody.detail || errorBody.title ||
                       (errorBody.violations ? errorBody.violations.map(v => v.reason).join(', ') : null) ||
                       JSON.stringify(errorBody);
      throw new Error(`${errorMsg} (status: ${response.status})`);
    }

    if (response.status === 202 || response.status === 204) {
      return { success: true };
    }

    return response.json();
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get invoice requests from Bol.com
   * @param {string} status - Filter: 'OPEN', 'UPLOAD_ERROR', 'ALL' (default)
   * @param {number} page - Page number (1-based)
   * @returns {Object} Invoice requests response
   */
  async getInvoiceRequests(state = 'OPEN', page = 1) {
    console.log(`[BolInvoiceRequest] Fetching invoice requests (state=${state}, page=${page})...`);

    // Correct endpoint: /shipments/invoices/requests (not /invoices/requests)
    const endpoint = `/shipments/invoices/requests?state=${state}&page=${page}`;
    const response = await this.bolRequest(endpoint);

    return response;
  }

  /**
   * Get all open invoice requests (paginated)
   * @returns {Array} All open invoice requests
   */
  async getAllOpenRequests() {
    const allRequests = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getInvoiceRequests('OPEN', page);
      const requests = response.invoiceRequests || [];

      allRequests.push(...requests);
      console.log(`[BolInvoiceRequest] Page ${page}: ${requests.length} requests`);

      // Check if there are more pages
      if (requests.length < 50) {
        hasMore = false;
      } else {
        page++;
        await this.sleep(REQUEST_DELAY_MS);
      }
    }

    console.log(`[BolInvoiceRequest] Total open requests: ${allRequests.length}`);
    return allRequests;
  }

  /**
   * Upload invoice PDF to Bol.com for a shipment
   * @param {string} shipmentId - Bol.com shipment ID
   * @param {Buffer} pdfBuffer - Invoice PDF as buffer
   * @returns {Object} Upload result with processStatusId
   */
  async uploadInvoice(shipmentId, pdfBuffer) {
    const token = await this.getAccessToken();

    // Create form boundary
    const boundary = '----BolInvoiceUpload' + Date.now();

    // Build multipart form data manually
    const bodyParts = [];
    bodyParts.push(`--${boundary}`);
    bodyParts.push('Content-Disposition: form-data; name="invoice"; filename="invoice.pdf"');
    bodyParts.push('Content-Type: application/pdf');
    bodyParts.push('');

    // Convert parts to buffer and combine with PDF
    const headerBuffer = Buffer.from(bodyParts.join('\r\n') + '\r\n');
    const footerBuffer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fullBody = Buffer.concat([headerBuffer, pdfBuffer, footerBuffer]);

    const response = await fetch(`https://api.bol.com/retailer/shipments/invoices/${shipmentId}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.retailer.v10+json',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bearer ${token}`
      },
      body: fullBody
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ detail: response.statusText }));
      const errorMsg = errorBody.detail || errorBody.title || JSON.stringify(errorBody);
      throw new Error(`Failed to upload invoice: ${errorMsg} (status: ${response.status})`);
    }

    const result = await response.json();
    console.log(`[BolInvoiceRequest] Uploaded invoice for shipment ${shipmentId}, processStatusId: ${result.processStatusId}`);

    return {
      success: true,
      processStatusId: result.processStatusId
    };
  }

  /**
   * Get invoice PDF from Odoo
   * @param {number} invoiceId - Odoo invoice ID (account.move)
   * @returns {Buffer} PDF buffer
   */
  async getInvoicePdfFromOdoo(invoiceId) {
    await this.init();

    const odooUrl = process.env.ODOO_URL;

    console.log(`[BolInvoiceRequest] Fetching invoice PDF from Odoo for invoice ${invoiceId}...`);

    // First, try to find existing PDF attachment (fastest)
    const attachments = await this.odoo.searchRead('ir.attachment',
      [
        ['res_model', '=', 'account.move'],
        ['res_id', '=', invoiceId],
        ['mimetype', '=', 'application/pdf']
      ],
      ['id', 'name', 'datas'],
      { limit: 1, order: 'create_date desc' }
    );

    if (attachments.length > 0 && attachments[0].datas) {
      console.log(`[BolInvoiceRequest] Using attached PDF: ${attachments[0].name}`);
      return Buffer.from(attachments[0].datas, 'base64');
    }

    // No attachment found, use portal download with access token
    console.log(`[BolInvoiceRequest] No attachment found, generating access token...`);

    // Get or generate access token for portal download
    let invoice = await this.odoo.searchRead('account.move',
      [['id', '=', invoiceId]],
      ['id', 'access_token']
    );

    if (!invoice.length) {
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    let accessToken = invoice[0].access_token;

    // Generate token if not exists
    if (!accessToken) {
      const crypto = require('crypto');
      accessToken = crypto.randomBytes(20).toString('hex');
      await this.odoo.execute('account.move', 'write', [[invoiceId], { access_token: accessToken }]);
      console.log(`[BolInvoiceRequest] Generated new access token`);
    }

    // Download PDF via portal URL
    const pdfUrl = `${odooUrl}/my/invoices/${invoiceId}?access_token=${accessToken}&report_type=pdf&download=true`;
    console.log(`[BolInvoiceRequest] Downloading PDF via portal...`);

    const pdfResponse = await fetch(pdfUrl, {
      redirect: 'follow'
    });

    if (!pdfResponse.ok) {
      throw new Error(`Failed to download PDF: ${pdfResponse.status} ${pdfResponse.statusText}`);
    }

    const contentType = pdfResponse.headers.get('content-type');
    if (!contentType || !contentType.includes('pdf')) {
      const body = await pdfResponse.text();
      if (body.includes('login') || body.includes('Login') || body.includes('Access Denied')) {
        throw new Error('PDF download failed - access denied');
      }
      throw new Error(`Unexpected content type: ${contentType}`);
    }

    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
    console.log(`[BolInvoiceRequest] Downloaded PDF: ${pdfBuffer.length} bytes`);

    return pdfBuffer;
  }

  /**
   * Find Odoo invoice for a Bol.com shipment
   * @param {string} shipmentId - Bol.com shipment ID
   * @param {string} orderId - Bol.com order ID
   * @returns {Object|null} Invoice info or null
   */
  async findOdooInvoice(shipmentId, orderId) {
    await this.init();

    // First try to find via shipment in MongoDB
    let bolOrderId = orderId;

    if (shipmentId && !bolOrderId) {
      const shipment = await BolShipment.findOne({ shipmentId }).lean();
      if (shipment) {
        bolOrderId = shipment.orderId;
        console.log(`[BolInvoiceRequest] Found order ${bolOrderId} for shipment ${shipmentId}`);
      }
    }

    if (!bolOrderId) {
      console.log(`[BolInvoiceRequest] Could not find order ID for shipment ${shipmentId}`);
      return null;
    }

    // Find sale order in Odoo by client_order_ref (which contains Bol order ID)
    const saleOrders = await this.odoo.searchRead('sale.order',
      [['client_order_ref', '=', bolOrderId]],
      ['id', 'name', 'invoice_ids', 'invoice_status']
    );

    if (saleOrders.length === 0) {
      // Try with different prefixes
      const prefixedRefs = [`BOL${bolOrderId}`, `FBB${bolOrderId}`, `FBR${bolOrderId}`];
      for (const ref of prefixedRefs) {
        const orders = await this.odoo.searchRead('sale.order',
          [['name', '=', ref]],
          ['id', 'name', 'invoice_ids', 'invoice_status']
        );
        if (orders.length > 0) {
          saleOrders.push(...orders);
          break;
        }
      }
    }

    if (saleOrders.length === 0) {
      console.log(`[BolInvoiceRequest] No Odoo order found for Bol order ${bolOrderId}`);
      return null;
    }

    const saleOrder = saleOrders[0];
    console.log(`[BolInvoiceRequest] Found Odoo order: ${saleOrder.name}`);

    // Check if there's an invoice
    if (!saleOrder.invoice_ids || saleOrder.invoice_ids.length === 0) {
      console.log(`[BolInvoiceRequest] Order ${saleOrder.name} has no invoice yet`);
      return {
        found: false,
        reason: 'no_invoice',
        saleOrderId: saleOrder.id,
        saleOrderName: saleOrder.name,
        invoiceStatus: saleOrder.invoice_status
      };
    }

    // Get the invoice details
    const invoices = await this.odoo.searchRead('account.move',
      [['id', 'in', saleOrder.invoice_ids], ['state', '=', 'posted']],
      ['id', 'name', 'state', 'amount_total', 'invoice_date', 'partner_id']
    );

    if (invoices.length === 0) {
      console.log(`[BolInvoiceRequest] Order ${saleOrder.name} has no posted invoice`);
      return {
        found: false,
        reason: 'invoice_not_posted',
        saleOrderId: saleOrder.id,
        saleOrderName: saleOrder.name
      };
    }

    const invoice = invoices[0];
    console.log(`[BolInvoiceRequest] Found posted invoice: ${invoice.name}`);

    return {
      found: true,
      invoiceId: invoice.id,
      invoiceName: invoice.name,
      invoiceDate: invoice.invoice_date,
      amountTotal: invoice.amount_total,
      saleOrderId: saleOrder.id,
      saleOrderName: saleOrder.name
    };
  }

  /**
   * Process a single invoice request
   * @param {Object} request - Invoice request from Bol.com
   * @returns {Object} Processing result
   */
  async processRequest(request) {
    const shipmentId = request.shipmentId;
    const orderId = request.orderId;

    const result = {
      shipmentId,
      orderId,
      success: false,
      error: null,
      invoiceName: null,
      processStatusId: null
    };

    try {
      // Find Odoo invoice
      const invoiceInfo = await this.findOdooInvoice(shipmentId, orderId);

      if (!invoiceInfo || !invoiceInfo.found) {
        result.error = invoiceInfo?.reason || 'invoice_not_found';
        result.saleOrderName = invoiceInfo?.saleOrderName;
        return result;
      }

      result.invoiceName = invoiceInfo.invoiceName;
      result.saleOrderName = invoiceInfo.saleOrderName;

      // Get PDF from Odoo
      const pdfBuffer = await this.getInvoicePdfFromOdoo(invoiceInfo.invoiceId);

      // Check file size (max 2MB)
      if (pdfBuffer.length > 2 * 1024 * 1024) {
        result.error = 'pdf_too_large';
        return result;
      }

      // Upload to Bol.com
      const uploadResult = await this.uploadInvoice(shipmentId, pdfBuffer);

      result.success = true;
      result.processStatusId = uploadResult.processStatusId;

      console.log(`[BolInvoiceRequest] Successfully uploaded invoice ${invoiceInfo.invoiceName} for shipment ${shipmentId}`);

    } catch (error) {
      result.error = error.message;
      console.error(`[BolInvoiceRequest] Error processing request for shipment ${shipmentId}:`, error.message);
    }

    return result;
  }

  /**
   * Process all open invoice requests
   * @returns {Object} Processing results
   */
  async processOpenRequests() {
    if (this.isRunning) {
      console.log('[BolInvoiceRequest] Already running, skipping');
      return { success: false, message: 'Already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    const results = {
      total: 0,
      processed: 0,
      success: 0,
      failed: 0,
      noInvoice: 0,
      requests: []
    };

    try {
      await this.init();

      // Get all open requests
      const requests = await this.getAllOpenRequests();
      results.total = requests.length;

      if (requests.length === 0) {
        console.log('[BolInvoiceRequest] No open invoice requests');
        return { success: true, ...results, message: 'No open requests' };
      }

      console.log(`[BolInvoiceRequest] Processing ${requests.length} invoice requests...`);

      // Process each request
      for (const request of requests) {
        results.processed++;

        const requestResult = await this.processRequest(request);
        results.requests.push(requestResult);

        if (requestResult.success) {
          results.success++;
        } else if (requestResult.error === 'no_invoice' || requestResult.error === 'invoice_not_posted') {
          results.noInvoice++;
        } else {
          results.failed++;
        }

        await this.sleep(REQUEST_DELAY_MS);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastRun = new Date();
      this.lastResult = { ...results, duration };

      console.log(`[BolInvoiceRequest] Complete in ${duration}s:`, {
        total: results.total,
        success: results.success,
        noInvoice: results.noInvoice,
        failed: results.failed
      });

      // Send Teams notification if there are results
      if (results.total > 0) {
        await this.sendTeamsNotification(results);
      }

      return {
        success: true,
        ...results,
        duration: `${duration}s`
      };

    } catch (error) {
      console.error('[BolInvoiceRequest] Error:', error);
      return { success: false, error: error.message };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Send Teams notification with results
   */
  async sendTeamsNotification(results) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) {
      return;
    }

    try {
      const teams = new TeamsNotificationService({ webhookUrl });

      const now = new Date();
      const dateStr = now.toLocaleString('nl-NL', {
        timeZone: 'Europe/Amsterdam',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const hasIssues = results.failed > 0 || results.noInvoice > 0;

      const cardBody = [
        {
          type: 'TextBlock',
          text: `📄 Bol.com Invoice Requests - ${dateStr}`,
          weight: 'bolder',
          size: 'medium',
          color: hasIssues ? 'warning' : 'default'
        },
        {
          type: 'FactSet',
          facts: [
            { title: 'Total Requests', value: String(results.total) },
            { title: 'Uploaded', value: `✅ ${results.success}` },
            { title: 'No Invoice Yet', value: `⏳ ${results.noInvoice}` },
            { title: 'Failed', value: results.failed > 0 ? `❌ ${results.failed}` : '0' }
          ]
        }
      ];

      // Add failed items
      if (results.failed > 0) {
        const failedItems = results.requests
          .filter(r => !r.success && r.error !== 'no_invoice' && r.error !== 'invoice_not_posted')
          .slice(0, 5);

        if (failedItems.length > 0) {
          cardBody.push({
            type: 'TextBlock',
            text: '**Failed uploads:**',
            wrap: true,
            separator: true
          });

          for (const item of failedItems) {
            cardBody.push({
              type: 'TextBlock',
              text: `• ${item.orderId || item.shipmentId}: ${item.error}`,
              wrap: true,
              size: 'small'
            });
          }
        }
      }

      // Add pending invoices
      if (results.noInvoice > 0) {
        const pendingItems = results.requests
          .filter(r => r.error === 'no_invoice' || r.error === 'invoice_not_posted')
          .slice(0, 5);

        if (pendingItems.length > 0) {
          cardBody.push({
            type: 'TextBlock',
            text: '**Awaiting invoice in Odoo:**',
            wrap: true,
            separator: true
          });

          for (const item of pendingItems) {
            const status = item.error === 'no_invoice' ? 'no invoice' : 'draft';
            cardBody.push({
              type: 'TextBlock',
              text: `• ${item.saleOrderName || item.orderId}: ${status}`,
              wrap: true,
              size: 'small'
            });
          }
        }
      }

      const card = {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: cardBody
      };

      await teams.sendMessage(card);
      console.log('[BolInvoiceRequest] Teams notification sent');
    } catch (error) {
      console.error('[BolInvoiceRequest] Failed to send Teams notification:', error.message);
    }
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      lastResult: this.lastResult
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the BolInvoiceRequestService instance
 */
function getBolInvoiceRequestService() {
  if (!instance) {
    instance = new BolInvoiceRequestService();
  }
  return instance;
}

/**
 * Process open invoice requests (for scheduler)
 */
async function processInvoiceRequests() {
  const service = getBolInvoiceRequestService();
  return service.processOpenRequests();
}

module.exports = {
  BolInvoiceRequestService,
  getBolInvoiceRequestService,
  processInvoiceRequests
};
