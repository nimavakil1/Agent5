/**
 * Bol.com Invoice Uploader
 *
 * Proactively uploads invoice PDFs to Bol.com for all Bol orders.
 * This runs before the invoice request handler to ensure customers
 * have their invoices available on Bol.com.
 *
 * Flow:
 * 1. Find all Bol orders (FBB/FBR/BOL prefix) with posted invoices
 * 2. Check which ones haven't been uploaded to Bol.com yet
 * 3. Get the shipment ID for each order
 * 4. Upload invoice PDF to Bol.com
 *
 * Bol.com API endpoint:
 * - POST /retailer/shipments/invoices/{shipment-id}
 */

const ExcelJS = require('exceljs');
const { OdooDirectClient } = require('../../core/agents/integrations/OdooMCP');
const { TeamsNotificationService } = require('../../core/agents/services/TeamsNotificationService');
const BolShipment = require('../../models/BolShipment');
const BolOrder = require('../../models/BolOrder');
const oneDriveService = require('../onedriveService');

// Report folder
const REPORTS_FOLDER = 'Bol_Invoice_Uploads';

const REQUEST_DELAY_MS = 300;
const DEFAULT_BATCH_SIZE = 100;

// Singleton instance
let instance = null;

class BolInvoiceUploader {
  constructor() {
    this.odoo = null;
    this.accessToken = null;
    this.tokenExpiry = null;
    this.isRunning = false;
  }

  /**
   * Initialize Odoo client
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
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    // Get new token
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get Bol.com token: ${response.status}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

    return this.accessToken;
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Upload invoice to Bol.com
   */
  async uploadInvoice(shipmentId, pdfBuffer) {
    const token = await this.getAccessToken();

    const boundary = '----BolInvoiceUpload' + Date.now();

    const bodyParts = [];
    bodyParts.push(`--${boundary}`);
    bodyParts.push('Content-Disposition: form-data; name="invoice"; filename="invoice.pdf"');
    bodyParts.push('Content-Type: application/pdf');
    bodyParts.push('');

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
      throw new Error(`${errorMsg} (status: ${response.status})`);
    }

    const result = await response.json();
    return {
      success: true,
      processStatusId: result.processStatusId
    };
  }

  /**
   * Get invoice PDF from Odoo
   */
  async getInvoicePdfFromOdoo(invoiceId) {
    await this.init();

    const odooUrl = process.env.ODOO_URL;

    // First check for existing PDF attachment
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
      return Buffer.from(attachments[0].datas, 'base64');
    }

    // No attachment - use portal download with access token
    let invoice = await this.odoo.searchRead('account.move',
      [['id', '=', invoiceId]],
      ['id', 'access_token']
    );

    if (!invoice.length) {
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    let accessToken = invoice[0].access_token;

    if (!accessToken) {
      const crypto = require('crypto');
      accessToken = crypto.randomBytes(20).toString('hex');
      await this.odoo.execute('account.move', 'write', [[invoiceId], { access_token: accessToken }]);
    }

    const pdfUrl = `${odooUrl}/my/invoices/${invoiceId}?access_token=${accessToken}&report_type=pdf&download=true`;

    const pdfResponse = await fetch(pdfUrl, { redirect: 'follow' });

    if (!pdfResponse.ok) {
      throw new Error(`Failed to download PDF: ${pdfResponse.status}`);
    }

    const contentType = pdfResponse.headers.get('content-type');
    if (!contentType || !contentType.includes('pdf')) {
      throw new Error('PDF download failed - invalid content type');
    }

    return Buffer.from(await pdfResponse.arrayBuffer());
  }

  /**
   * Get shipment ID for a Bol order
   */
  async getShipmentId(bolOrderId) {
    // Check BolShipment collection
    const shipment = await BolShipment.findOne({ orderId: bolOrderId }).lean();
    if (shipment && shipment.shipmentId) {
      return shipment.shipmentId;
    }

    // Check BolOrder collection
    const order = await BolOrder.findOne({ orderId: bolOrderId }).lean();
    if (order && order.shipmentId) {
      return order.shipmentId;
    }

    return null;
  }

  /**
   * Find Bol orders with posted invoices that haven't been uploaded
   */
  async findOrdersNeedingUpload(limit = DEFAULT_BATCH_SIZE) {
    await this.init();

    // Find Bol orders (FBB/FBR/BOL prefix) with posted invoices
    // that don't have x_bol_invoice_uploaded = true
    const orders = await this.odoo.searchRead('sale.order',
      [
        '|', '|',
        ['name', '=like', 'FBB%'],
        ['name', '=like', 'FBR%'],
        ['name', '=like', 'BOL%'],
        ['invoice_ids', '!=', false],
        ['invoice_status', '=', 'invoiced']
      ],
      ['id', 'name', 'invoice_ids', 'client_order_ref'],
      { limit: limit * 2, order: 'id desc' }
    );

    const ordersNeedingUpload = [];

    for (const order of orders) {
      if (!order.invoice_ids || order.invoice_ids.length === 0) continue;

      // Get the invoice details
      const invoices = await this.odoo.searchRead('account.move',
        [
          ['id', 'in', order.invoice_ids],
          ['state', '=', 'posted'],
          ['move_type', '=', 'out_invoice'],
          '|',
          ['x_bol_invoice_uploaded', '=', false],
          ['x_bol_invoice_uploaded', '=', null]
        ],
        ['id', 'name', 'x_bol_invoice_uploaded'],
        { limit: 1 }
      );

      if (invoices.length > 0) {
        // Extract Bol order ID from name
        const bolOrderId = order.client_order_ref || order.name.replace(/^(FBB|FBR|BOL)/, '');

        ordersNeedingUpload.push({
          saleOrderId: order.id,
          saleOrderName: order.name,
          invoiceId: invoices[0].id,
          invoiceName: invoices[0].name,
          bolOrderId: bolOrderId
        });

        if (ordersNeedingUpload.length >= limit) break;
      }
    }

    return ordersNeedingUpload;
  }

  /**
   * Mark invoice as uploaded in Odoo
   */
  async markAsUploaded(invoiceId) {
    await this.init();

    try {
      await this.odoo.execute('account.move', 'write', [[invoiceId], {
        x_bol_invoice_uploaded: true,
        x_bol_invoice_uploaded_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
      }]);
    } catch (error) {
      // Field might not exist yet - that's OK, we'll create it later
      console.log(`[BolInvoiceUploader] Could not mark invoice ${invoiceId} as uploaded:`, error.message);
    }
  }

  /**
   * Process a single order
   */
  async processOrder(orderInfo) {
    const result = {
      saleOrderName: orderInfo.saleOrderName,
      invoiceName: orderInfo.invoiceName,
      bolOrderId: orderInfo.bolOrderId,
      shipmentId: null,
      success: false,
      error: null
    };

    try {
      // Get shipment ID
      const shipmentId = await this.getShipmentId(orderInfo.bolOrderId);
      if (!shipmentId) {
        result.error = 'no_shipment';
        return result;
      }
      result.shipmentId = shipmentId;

      // Get invoice PDF
      const pdfBuffer = await this.getInvoicePdfFromOdoo(orderInfo.invoiceId);

      // Upload to Bol.com
      const uploadResult = await this.uploadInvoice(shipmentId, pdfBuffer);
      result.success = true;
      result.processStatusId = uploadResult.processStatusId;

      // Mark as uploaded in Odoo
      await this.markAsUploaded(orderInfo.invoiceId);

      console.log(`[BolInvoiceUploader] Uploaded ${orderInfo.invoiceName} for ${orderInfo.saleOrderName}`);

    } catch (error) {
      result.error = error.message;
      console.error(`[BolInvoiceUploader] Failed ${orderInfo.saleOrderName}:`, error.message);
    }

    return result;
  }

  /**
   * Run the upload process for all pending invoices
   */
  async run(options = {}) {
    if (this.isRunning) {
      return { success: false, error: 'Already running' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    const results = {
      total: 0,
      uploaded: 0,
      noShipment: 0,
      failed: 0,
      orders: []
    };

    try {
      await this.init();

      const limit = options.limit || DEFAULT_BATCH_SIZE;
      console.log(`[BolInvoiceUploader] Finding orders needing invoice upload (limit: ${limit})...`);

      const orders = await this.findOrdersNeedingUpload(limit);
      results.total = orders.length;

      console.log(`[BolInvoiceUploader] Found ${orders.length} orders to process`);

      for (const order of orders) {
        const result = await this.processOrder(order);
        results.orders.push(result);

        if (result.success) {
          results.uploaded++;
        } else if (result.error === 'no_shipment') {
          results.noShipment++;
        } else {
          results.failed++;
        }

        await this.sleep(REQUEST_DELAY_MS);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      results.duration = `${duration}s`;

      console.log(`[BolInvoiceUploader] Complete: ${results.uploaded} uploaded, ${results.noShipment} no shipment, ${results.failed} failed`);

      // Send Teams notification
      if (results.total > 0) {
        await this.sendTeamsNotification(results);
      }

      return { success: true, ...results };

    } catch (error) {
      console.error('[BolInvoiceUploader] Error:', error);
      return { success: false, error: error.message, ...results };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Generate Excel report for invoice upload results
   */
  async generateExcel(results) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Agent5 Bol Invoice Uploader';
    workbook.created = new Date();

    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

    const worksheet = workbook.addWorksheet('Invoice Uploads', {
      views: [{ state: 'frozen', ySplit: 3 }]
    });

    // Title
    worksheet.addRow(['Bol.com Invoice Upload Report', '', '', '', '', dateStr]);
    worksheet.mergeCells('A1:E1');
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('F1').font = { italic: true, size: 10 };

    // Summary
    worksheet.addRow([`Total: ${results.total} | Uploaded: ${results.uploaded} | No Shipment: ${results.noShipment} | Failed: ${results.failed}`]);
    worksheet.mergeCells('A2:F2');
    worksheet.getCell('A2').font = { italic: true };
    worksheet.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };

    // Headers
    worksheet.addRow(['Sale Order', 'Bol Order ID', 'Invoice', 'Shipment ID', 'Status', 'Error']);
    const headerRow = worksheet.getRow(3);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

    worksheet.columns = [
      { width: 18 }, { width: 15 }, { width: 20 }, { width: 40 }, { width: 14 }, { width: 40 }
    ];

    // Data rows
    for (const order of (results.orders || [])) {
      let status = 'Unknown';
      if (order.success) {
        status = '✅ Uploaded';
      } else if (order.error === 'no_shipment') {
        status = '⏳ No Shipment';
      } else {
        status = '❌ Failed';
      }

      const row = worksheet.addRow([
        order.saleOrderName || '-',
        order.bolOrderId || '-',
        order.invoiceName || '-',
        order.shipmentId || '-',
        status,
        order.error && order.error !== 'no_shipment' ? order.error : '-'
      ]);

      // Highlight failed rows
      if (!order.success && order.error !== 'no_shipment') {
        row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
        row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
      }
    }

    if (!results.orders || results.orders.length === 0) {
      worksheet.addRow(['No orders processed', '', '', '', '', '']);
    }

    return workbook.xlsx.writeBuffer();
  }

  /**
   * Send Teams notification with results
   */
  async sendTeamsNotification(results) {
    const webhookUrl = process.env.TEAMS_ACROPAQ_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) return;

    // Generate and upload Excel report
    let reportUrl = null;
    try {
      const excelBuffer = await this.generateExcel(results);
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const fileName = `Bol_Invoice_Upload_${timestamp}.xlsx`;

      const uploadResult = await oneDriveService.uploadReport(excelBuffer, fileName, REPORTS_FOLDER);
      reportUrl = uploadResult.url;
      console.log(`[BolInvoiceUploader] Excel report uploaded: ${reportUrl}`);
    } catch (uploadError) {
      console.error('[BolInvoiceUploader] Failed to upload Excel report:', uploadError.message);
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

      const hasIssues = results.failed > 0;

      const cardBody = [
        {
          type: 'TextBlock',
          text: `📄 Bol Invoice Upload - ${dateStr}`,
          weight: 'bolder',
          size: 'medium',
          color: hasIssues ? 'warning' : 'good'
        },
        {
          type: 'FactSet',
          facts: [
            { title: 'Total Orders', value: String(results.total) },
            { title: 'Uploaded', value: `✅ ${results.uploaded}` },
            { title: 'No Shipment', value: `⏳ ${results.noShipment}` },
            { title: 'Failed', value: results.failed > 0 ? `❌ ${results.failed}` : '0' }
          ]
        }
      ];

      if (results.failed > 0) {
        const failedItems = results.orders
          .filter(r => !r.success && r.error !== 'no_shipment')
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
              text: `• ${item.saleOrderName}: ${item.error}`,
              wrap: true,
              size: 'small'
            });
          }
        }
      }

      // Add action buttons
      const actions = [];
      if (reportUrl) {
        actions.push({
          type: 'Action.OpenUrl',
          title: '📊 Download Excel Report',
          url: reportUrl
        });
      }

      if (actions.length > 0) {
        cardBody.push({ type: 'ActionSet', actions });
      }

      const card = {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: cardBody
      };

      await teams.sendMessage(card);
      console.log('[BolInvoiceUploader] Teams notification sent');
    } catch (error) {
      console.error('[BolInvoiceUploader] Failed to send Teams notification:', error.message);
    }
  }
}

/**
 * Get singleton instance
 */
function getBolInvoiceUploader() {
  if (!instance) {
    instance = new BolInvoiceUploader();
  }
  return instance;
}

/**
 * Run the uploader (convenience function)
 */
async function runBolInvoiceUpload(options = {}) {
  const uploader = getBolInvoiceUploader();
  return uploader.run(options);
}

module.exports = {
  BolInvoiceUploader,
  getBolInvoiceUploader,
  runBolInvoiceUpload
};
