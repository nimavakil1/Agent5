/**
 * FbmStockReportService - Excel reports and Teams notifications for FBM stock sync
 *
 * Features:
 * - Generate Excel report with stock update details
 * - Upload to OneDrive for sharing
 * - Send Teams notification with summary and download link
 *
 * @module FbmStockReportService
 */

const ExcelJS = require('exceljs');
const https = require('https');
const url = require('url');
const oneDriveService = require('../../onedriveService');

// Report folder in OneDrive
const REPORTS_FOLDER = process.env.FBM_STOCK_REPORTS_FOLDER || 'FBM_Stock_Reports';

/**
 * FbmStockReportService - Generates reports and sends notifications for FBM stock sync
 */
class FbmStockReportService {
  constructor() {
    // Regular updates webhook (stock changes, daily reports)
    this.webhookUrl = process.env.TEAMS_FBM_REPORT_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL;
    // Escalation webhook (errors, manual intervention needed)
    this.escalationWebhookUrl = process.env.TEAMS_FBM_ESCALATION_WEBHOOK_URL || this.webhookUrl;
  }

  /**
   * Generate Excel report from sync results
   * @param {Object} syncResults - Results from SellerFbmStockExport.syncStock()
   * @returns {Buffer} Excel file buffer
   */
  async generateExcel(syncResults) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Agent5 FBM Stock Sync';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('FBM Stock Updates', {
      views: [{ state: 'frozen', ySplit: 3 }] // Freeze first 3 rows (summary + header)
    });

    // Add summary section at top
    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

    worksheet.addRow(['Amazon FBM Stock Update Report', '', '', '', '', '', '', '', dateStr]);
    worksheet.mergeCells('A1:H1');
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('I1').font = { italic: true, size: 10 };

    // Summary row
    const summary = syncResults.summary || {};
    const summaryText = `Total: ${summary.totalSkus || 0} SKUs | Updated: ${summary.updated || 0} | Increases: ${summary.increases || 0} | Decreases: ${summary.decreases || 0} | Unchanged: ${summary.unchanged || 0} | Zero Stock: ${summary.zeroStock || 0}`;
    worksheet.addRow([summaryText]);
    worksheet.mergeCells('A2:I2');
    worksheet.getCell('A2').font = { italic: true };
    worksheet.getCell('A2').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF2CC' }
    };

    // Header row
    worksheet.addRow([
      'ASIN',
      'Amazon SKU',
      'Odoo SKU',
      'Amazon QTY (Before)',
      'CW QTY',
      'CW Free QTY',
      'Safety Stock',
      'New Amazon QTY',
      'Delta',
      'Status'
    ]);

    // Style header row
    const headerRow = worksheet.getRow(3);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Set column widths
    worksheet.columns = [
      { width: 15 },  // ASIN
      { width: 25 },  // Amazon SKU
      { width: 20 },  // Odoo SKU
      { width: 18 },  // Amazon QTY Before
      { width: 12 },  // CW QTY (physical)
      { width: 14 },  // CW Free QTY
      { width: 13 },  // Safety Stock
      { width: 16 },  // New Amazon QTY
      { width: 10 },  // Delta
      { width: 12 }   // Status
    ];

    // Add data rows - ONLY include items with changes (delta != 0)
    const detailedResults = syncResults.detailedResults || [];
    const changedItems = detailedResults.filter(item => (item.delta || 0) !== 0);

    for (const item of changedItems) {
      const row = worksheet.addRow([
        item.asin || '',
        item.amazonSku || '',
        item.odooSku || '',
        item.amazonQtyBefore ?? 0,
        item.cwQty ?? item.cwFreeQty ?? 0,  // Physical stock
        item.cwFreeQty ?? 0,
        item.safetyStock ?? 10,
        item.newAmazonQty ?? 0,
        item.delta ?? 0,
        item.status || 'pending'
      ]);

      // Conditional formatting for delta (column 9)
      const deltaCell = row.getCell(9);
      const delta = item.delta || 0;

      if (delta > 0) {
        deltaCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFC6EFCE' } // Light green
        };
        deltaCell.font = { color: { argb: 'FF006100' } }; // Dark green
      } else if (delta < 0) {
        deltaCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' } // Light red
        };
        deltaCell.font = { color: { argb: 'FF9C0006' } }; // Dark red
      }

      // Status cell formatting (column 10)
      const statusCell = row.getCell(10);
      if (item.status === 'success') {
        statusCell.font = { color: { argb: 'FF006100' } };
      } else if (item.status === 'failed') {
        statusCell.font = { color: { argb: 'FF9C0006' } };
      }
    }

    // Auto-filter
    worksheet.autoFilter = {
      from: { row: 3, column: 1 },
      to: { row: 3 + changedItems.length, column: 10 }
    };

    // Add borders to all data cells
    const lastRow = 3 + changedItems.length;
    for (let row = 3; row <= lastRow; row++) {
      for (let col = 1; col <= 10; col++) {
        const cell = worksheet.getCell(row, col);
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
        };
      }
    }

    // Generate buffer
    return workbook.xlsx.writeBuffer();
  }

  /**
   * Upload Excel report to OneDrive
   * @param {Buffer} buffer - Excel file buffer
   * @param {string} filename - Filename for the report
   * @returns {Object} { success, url, fileId, error }
   */
  async uploadToOneDrive(buffer, filename) {
    try {
      if (!oneDriveService.graphClient) {
        console.log('[FbmStockReportService] OneDrive not configured, skipping upload');
        return { success: false, error: 'OneDrive not configured' };
      }

      // Create folder structure: /FBM_Stock_Reports/YYYY/MM/
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const folderPath = `/${REPORTS_FOLDER}/${year}/${month}`;

      await oneDriveService.ensureFolderExists(folderPath);

      const remotePath = `${folderPath}/${filename}`;

      // Get SharePoint drive path (uses site document library, not /me/drive)
      const drivePath = await oneDriveService.getDrivePath();

      // Upload file
      const uploadedFile = await oneDriveService.graphClient
        .api(`${drivePath}/root:${remotePath}:/content`)
        .put(buffer);

      // Create sharing link
      const sharingLink = await oneDriveService.graphClient
        .api(`${drivePath}/items/${uploadedFile.id}/createLink`)
        .post({
          type: 'view',
          scope: 'organization'
        });

      console.log(`[FbmStockReportService] Report uploaded to SharePoint: ${filename}`);

      return {
        success: true,
        url: sharingLink.link.webUrl,
        fileId: uploadedFile.id
      };
    } catch (error) {
      console.error('[FbmStockReportService] SharePoint upload failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send Teams notification with stock update summary
   * @param {Object} syncResults - Results from SellerFbmStockExport.syncStock()
   * @param {string} reportUrl - URL to the Excel report (optional)
   * @returns {Object} { success, error }
   */
  async sendToTeams(syncResults, reportUrl = null) {
    if (!this.webhookUrl) {
      console.log('[FbmStockReportService] Teams webhook not configured, skipping notification');
      return { success: false, error: 'Teams webhook not configured' };
    }

    const summary = syncResults.summary || {};
    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    // Determine card color based on success/failure
    const hasErrors = syncResults.itemsFailed > 0 || syncResults.error;
    const cardStyle = hasErrors ? 'attention' : 'good';

    // Build card body
    const cardBody = [
      {
        type: 'TextBlock',
        text: `📦 Amazon FBM Stock Update Report - ${dateStr}`,
        weight: 'bolder',
        size: 'medium',
        color: hasErrors ? 'warning' : 'default'
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Total SKUs', value: String(summary.totalSkus || 0) },
          { title: 'Updated', value: String(summary.updated || syncResults.itemsUpdated || 0) },
          { title: 'Increases', value: `↑ ${summary.increases || 0}` },
          { title: 'Decreases', value: `↓ ${summary.decreases || 0}` },
          { title: 'Unchanged', value: String(summary.unchanged || 0) },
          { title: 'Zero Stock', value: String(summary.zeroStock || 0) }
        ]
      }
    ];

    // Add error info if present
    if (syncResults.itemsFailed > 0) {
      cardBody.push({
        type: 'TextBlock',
        text: `⚠️ ${syncResults.itemsFailed} items failed to update`,
        color: 'warning',
        wrap: true
      });
    }

    if (syncResults.error) {
      cardBody.push({
        type: 'TextBlock',
        text: `❌ Error: ${syncResults.error}`,
        color: 'attention',
        wrap: true
      });
    }

    // Add unresolved SKUs info - show the specific SKUs
    if (syncResults.unresolved > 0 && syncResults.unresolvedSkus && syncResults.unresolvedSkus.length > 0) {
      const unresolvedSkus = syncResults.unresolvedSkus;
      const maxToShow = 10;
      const skusToShow = unresolvedSkus.slice(0, maxToShow);
      const hasMore = unresolvedSkus.length > maxToShow;

      cardBody.push({
        type: 'TextBlock',
        text: `⚠️ ${unresolvedSkus.length} SKU(s) could not be resolved to Odoo:`,
        color: 'warning',
        wrap: true,
        separator: true
      });

      // Show the actual SKUs (amazonSku)
      const skuList = skusToShow.map(s => s.amazonSku || s.sku || s).join(', ');
      cardBody.push({
        type: 'TextBlock',
        text: skuList + (hasMore ? ` ... and ${unresolvedSkus.length - maxToShow} more` : ''),
        fontType: 'monospace',
        wrap: true
      });
    } else if (syncResults.unresolved > 0) {
      // Fallback if unresolvedSkus array is not available
      cardBody.push({
        type: 'TextBlock',
        text: `⚠️ ${syncResults.unresolved} SKUs could not be resolved to Odoo`,
        color: 'warning',
        wrap: true,
        separator: true
      });
    }

    // Build actions
    const actions = [];

    if (reportUrl) {
      actions.push({
        type: 'Action.OpenUrl',
        title: '📥 Download Report',
        url: reportUrl
      });
    }

    // Build the card
    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: cardBody,
      actions: actions.length > 0 ? actions : undefined
    };

    return this._postToWebhook(card);
  }

  /**
   * Send error escalation to Teams with TSV file for manual upload
   * @param {Object} errorInfo - Error details
   * @param {string} tsvUrl - URL to the TSV file for manual upload
   * @returns {Object} { success, error }
   */
  async sendErrorEscalation(errorInfo, tsvUrl = null) {
    if (!this.escalationWebhookUrl) {
      console.log('[FbmStockReportService] Teams escalation webhook not configured, skipping');
      return { success: false, error: 'Teams webhook not configured' };
    }

    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const cardBody = [
      {
        type: 'TextBlock',
        text: '🚨 FBM Stock Sync FAILED - Manual Action Required',
        weight: 'bolder',
        size: 'medium',
        color: 'attention'
      },
      {
        type: 'TextBlock',
        text: `Time: ${dateStr}`,
        isSubtle: true,
        size: 'small'
      },
      {
        type: 'TextBlock',
        text: `**Error:** ${errorInfo.error || 'Unknown error'}`,
        wrap: true,
        separator: true
      }
    ];

    if (errorInfo.affectedSkus) {
      cardBody.push({
        type: 'TextBlock',
        text: `**Affected SKUs:** ${errorInfo.affectedSkus}`,
        wrap: true
      });
    }

    if (tsvUrl) {
      cardBody.push({
        type: 'Container',
        separator: true,
        items: [
          {
            type: 'TextBlock',
            text: '**Manual Upload Instructions:**',
            weight: 'bolder'
          },
          {
            type: 'TextBlock',
            text: '1. Download the TSV file using the button below\n2. Go to Amazon Seller Central > Inventory > Add Products via Upload\n3. Upload the TSV file\n4. Review and confirm the upload',
            wrap: true
          }
        ]
      });
    }

    const actions = [];
    if (tsvUrl) {
      actions.push({
        type: 'Action.OpenUrl',
        title: '📥 Download TSV File',
        url: tsvUrl
      });
    }

    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: cardBody,
      actions: actions.length > 0 ? actions : undefined
    };

    return this._postToWebhook(card, this.escalationWebhookUrl);
  }

  /**
   * Post adaptive card to Teams webhook
   * @param {Object} card - Adaptive card content
   * @param {string} webhookUrl - Optional webhook URL (defaults to this.webhookUrl)
   */
  async _postToWebhook(card, webhookUrl = null) {
    const targetUrl = webhookUrl || this.webhookUrl;
    return new Promise((resolve) => {
      try {
        const message = {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: card
            }
          ]
        };

        const parsedUrl = url.parse(targetUrl);
        const postData = JSON.stringify(message);

        const options = {
          hostname: parsedUrl.hostname,
          port: 443,
          path: parsedUrl.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        const req = https.request(options, (res) => {
          let responseData = '';

          res.on('data', (chunk) => {
            responseData += chunk;
          });

          res.on('end', () => {
            if (res.statusCode === 200 || res.statusCode === 202) {
              console.log('[FbmStockReportService] Teams notification sent successfully');
              resolve({ success: true });
            } else {
              console.error(`[FbmStockReportService] Teams webhook failed: ${res.statusCode} - ${responseData}`);
              resolve({ success: false, error: `HTTP ${res.statusCode}` });
            }
          });
        });

        req.on('error', (error) => {
          console.error('[FbmStockReportService] Teams webhook error:', error.message);
          resolve({ success: false, error: error.message });
        });

        req.write(postData);
        req.end();

      } catch (error) {
        console.error('[FbmStockReportService] Error sending to Teams:', error.message);
        resolve({ success: false, error: error.message });
      }
    });
  }

  /**
   * Save report file to server for download
   * @param {Buffer} buffer - File buffer
   * @param {string} filename - Filename
   * @returns {Object} { success, url, path }
   */
  async saveToServer(buffer, filename) {
    const fs = require('fs');
    const path = require('path');

    try {
      // Create reports directory if it doesn't exist
      const reportsDir = path.join(__dirname, '..', '..', '..', 'tmp', 'fbm-reports');
      if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
      }

      // Clean up old reports (older than 7 days)
      const files = fs.readdirSync(reportsDir);
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const file of files) {
        const filePath = path.join(reportsDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < weekAgo) {
          fs.unlinkSync(filePath);
        }
      }

      // Save new file
      const filePath = path.join(reportsDir, filename);
      fs.writeFileSync(filePath, buffer);

      // Generate download URL (relative to server)
      const baseUrl = process.env.BASE_URL || 'https://ai.acropaq.com';
      const downloadUrl = `${baseUrl}/api/seller/fbm-report/${encodeURIComponent(filename)}`;

      console.log(`[FbmStockReportService] Report saved to server: ${filename}`);

      return {
        success: true,
        url: downloadUrl,
        path: filePath
      };
    } catch (error) {
      console.error('[FbmStockReportService] Failed to save to server:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Full report flow: Generate Excel, upload to OneDrive, send Teams notification
   * ALWAYS sends Teams notification (even when no changes, to confirm system ran)
   * Only generates Excel report if there ARE changes
   * @param {Object} syncResults - Results from SellerFbmStockExport.syncStock()
   * @returns {Object} { reported, excelUrl, teamsNotified, error }
   */
  async generateAndSendReport(syncResults) {
    const result = {
      reported: false,
      excelUrl: null,
      teamsNotified: false,
      error: null
    };

    try {
      const summary = syncResults.summary || {};
      const hasChanges = (summary.increases > 0) || (summary.decreases > 0);

      let reportUrl = null;

      // Only generate Excel if there are changes
      if (hasChanges) {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `FBM_Stock_Update_${timestamp}.xlsx`;

        const excelBuffer = await this.generateExcel(syncResults);

        // Upload to OneDrive (primary storage)
        const uploadResult = await this.uploadToOneDrive(excelBuffer, filename);
        if (uploadResult.success) {
          reportUrl = uploadResult.url;
          result.excelUrl = reportUrl;
        } else {
          console.warn('[FbmStockReportService] OneDrive upload failed, report not saved:', uploadResult.error);
        }
      }

      // ALWAYS send Teams notification (even if no changes, to confirm system ran)
      const teamsResult = await this.sendToTeams(syncResults, reportUrl);
      result.teamsNotified = teamsResult.success;

      result.reported = true;
      const changeText = hasChanges ? `${summary.increases + summary.decreases} changes` : 'no changes';
      console.log(`[FbmStockReportService] Report: ${changeText}, OneDrive=${result.excelUrl ? 'Yes' : 'No'}, Teams=${result.teamsNotified}`);

      return result;

    } catch (error) {
      console.error('[FbmStockReportService] Report generation failed:', error.message);
      result.error = error.message;
      return result;
    }
  }
}

// Singleton instance
let reportServiceInstance = null;

/**
 * Get the singleton FbmStockReportService instance
 */
function getFbmStockReportService() {
  if (!reportServiceInstance) {
    reportServiceInstance = new FbmStockReportService();
  }
  return reportServiceInstance;
}

module.exports = {
  FbmStockReportService,
  getFbmStockReportService
};
