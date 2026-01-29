/**
 * BolStockReportService - Excel reports and Teams notifications for Bol.com stock sync
 *
 * Features:
 * - Generate Excel report with stock update details
 * - Upload to OneDrive for sharing
 * - Send Teams notification with summary and download link
 * - Send error escalation with TSV for manual upload
 *
 * @module BolStockReportService
 */

const ExcelJS = require('exceljs');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs').promises;
const oneDriveService = require('../onedriveService');

// Report folder in OneDrive
const REPORTS_FOLDER = process.env.BOL_STOCK_REPORTS_FOLDER || 'BOL_Stock_Reports';

/**
 * BolStockReportService - Generates reports and sends notifications for Bol.com stock sync
 */
class BolStockReportService {
  constructor() {
    // Regular updates webhook (stock changes, daily reports) - same as FBM
    this.webhookUrl = process.env.TEAMS_FBM_REPORT_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL;
    // Escalation webhook (errors, manual intervention needed) - same as FBM
    this.escalationWebhookUrl = process.env.TEAMS_FBM_ESCALATION_WEBHOOK_URL || this.webhookUrl;
  }

  /**
   * Generate Excel report from sync results
   * @param {Object} syncResults - Results from BolStockSync.syncFromOfferExport()
   * @returns {Buffer} Excel file buffer
   */
  async generateExcel(syncResults) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Agent5 Bol.com Stock Sync';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Bol.com Stock Updates', {
      views: [{ state: 'frozen', ySplit: 3 }] // Freeze first 3 rows (summary + header)
    });

    // Add summary section at top
    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

    worksheet.addRow(['Bol.com FBR Stock Update Report', '', '', '', '', '', '', dateStr]);
    worksheet.mergeCells('A1:G1');
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('H1').font = { italic: true, size: 10 };

    // Summary row
    const summary = syncResults.summary || {};
    const summaryText = `Total: ${summary.totalOffers || 0} Offers | Updated: ${summary.updated || 0} | Increases: ${summary.increases || 0} | Decreases: ${summary.decreases || 0} | Unchanged: ${summary.unchanged || 0} | Zero Stock: ${summary.zeroStock || 0} | Below Safety: ${summary.belowSafetyStock || 0}`;
    worksheet.addRow([summaryText]);
    worksheet.mergeCells('A2:H2');
    worksheet.getCell('A2').font = { italic: true };
    worksheet.getCell('A2').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF2CC' }
    };

    // Header row
    worksheet.addRow([
      'EAN',
      'Reference',
      'Bol QTY (Before)',
      'CW Free QTY',
      'Safety Stock',
      'New Bol QTY',
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
      { width: 18 },  // EAN
      { width: 20 },  // Reference
      { width: 16 },  // Bol QTY Before
      { width: 14 },  // CW Free QTY
      { width: 13 },  // Safety Stock
      { width: 14 },  // New Bol QTY
      { width: 10 },  // Delta
      { width: 12 }   // Status
    ];

    // Add data rows - ONLY include items with changes (delta != 0)
    const detailedResults = syncResults.detailedResults || [];
    const changedItems = detailedResults.filter(item => (item.delta || 0) !== 0);

    for (const item of changedItems) {
      const row = worksheet.addRow([
        item.ean || '',
        item.reference || '',
        item.bolQtyBefore ?? 0,
        item.cwFreeQty ?? 0,
        item.safetyStock ?? 10,
        item.newBolQty ?? 0,
        item.delta ?? 0,
        item.status || 'pending'
      ]);

      // Conditional formatting for delta (column 7)
      const deltaCell = row.getCell(7);
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

      // Status cell formatting (column 8)
      const statusCell = row.getCell(8);
      if (item.status === 'success') {
        statusCell.font = { color: { argb: 'FF006100' } };
      } else if (item.status === 'failed') {
        statusCell.font = { color: { argb: 'FF9C0006' } };
      }
    }

    // Auto-filter
    worksheet.autoFilter = {
      from: { row: 3, column: 1 },
      to: { row: 3 + changedItems.length, column: 8 }
    };

    // Add borders to all data cells
    const lastRow = 3 + changedItems.length;
    for (let row = 3; row <= lastRow; row++) {
      for (let col = 1; col <= 8; col++) {
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
   * Save Excel report locally as fallback when OneDrive fails
   * @param {Buffer} buffer - Excel file buffer
   * @param {string} filename - Filename for the report
   * @returns {Object} { success, url, error }
   */
  async saveLocally(buffer, filename) {
    try {
      const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'bol-reports');
      await fs.mkdir(uploadsDir, { recursive: true });

      const filePath = path.join(uploadsDir, filename);
      await fs.writeFile(filePath, buffer);

      const baseUrl = process.env.APP_BASE_URL || 'https://ai.acropaq.com';
      const url = `${baseUrl}/uploads/bol-reports/${filename}`;

      console.log(`[BolStockReportService] Report saved locally: ${filePath}`);
      return { success: true, url };
    } catch (error) {
      console.error('[BolStockReportService] Local save failed:', error.message);
      return { success: false, error: error.message };
    }
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
        console.log('[BolStockReportService] OneDrive not configured, skipping upload');
        return { success: false, error: 'OneDrive not configured' };
      }

      // Create folder structure: /BOL_Stock_Reports/YYYY/MM/
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const folderPath = `/${REPORTS_FOLDER}/${year}/${month}`;

      await oneDriveService.ensureFolderExists(folderPath);

      const remotePath = `${folderPath}/${filename}`;

      // Upload file
      const uploadedFile = await oneDriveService.graphClient
        .api(`/me/drive/root:${remotePath}:/content`)
        .put(buffer);

      // Create sharing link
      const sharingLink = await oneDriveService.graphClient
        .api(`/me/drive/items/${uploadedFile.id}/createLink`)
        .post({
          type: 'view',
          scope: 'organization'
        });

      console.log(`[BolStockReportService] Report uploaded to OneDrive: ${filename}`);

      return {
        success: true,
        url: sharingLink.link.webUrl,
        fileId: uploadedFile.id
      };
    } catch (error) {
      console.error('[BolStockReportService] OneDrive upload failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send Teams notification with stock update summary
   * @param {Object} syncResults - Results from BolStockSync.syncFromOfferExport()
   * @param {string} reportUrl - URL to the Excel report (optional)
   * @returns {Object} { success, error }
   */
  async sendToTeams(syncResults, reportUrl = null) {
    if (!this.webhookUrl) {
      console.log('[BolStockReportService] Teams webhook not configured, skipping notification');
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
    const hasErrors = syncResults.failed > 0 || syncResults.error;
    const cardStyle = hasErrors ? 'attention' : 'good';

    // Build card body
    const cardBody = [
      {
        type: 'TextBlock',
        text: `📦 Bol.com FBR Stock Update Report - ${dateStr}`,
        weight: 'bolder',
        size: 'medium',
        color: hasErrors ? 'warning' : 'default'
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Total Offers', value: String(summary.totalOffers || 0) },
          { title: 'Updated', value: String(summary.updated || syncResults.updated || 0) },
          { title: 'Increases', value: `↑ ${summary.increases || 0}` },
          { title: 'Decreases', value: `↓ ${summary.decreases || 0}` },
          { title: 'Unchanged', value: String(summary.unchanged || 0) },
          { title: 'Zero Stock', value: String(summary.zeroStock || 0) },
          { title: 'Below Safety Stock', value: `⚠️ ${summary.belowSafetyStock || 0}` }
        ]
      }
    ];

    // Warning if products below safety stock
    if ((summary.belowSafetyStock || 0) > 0) {
      cardBody.push({
        type: 'TextBlock',
        text: `ℹ️ ${summary.belowSafetyStock} products have stock but below safety stock (listed as 0)`,
        color: 'warning',
        wrap: true,
        size: 'small'
      });
    }

    // Add error info if present
    if (syncResults.failed > 0) {
      cardBody.push({
        type: 'TextBlock',
        text: `⚠️ ${syncResults.failed} offers failed to update`,
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

    // Add not found EANs info - show the specific EANs
    if (syncResults.skippedNotInOdoo > 0 && syncResults.notFoundEans && syncResults.notFoundEans.length > 0) {
      const notFoundEans = syncResults.notFoundEans;
      const maxToShow = 10;
      const eansToShow = notFoundEans.slice(0, maxToShow);
      const hasMore = notFoundEans.length > maxToShow;

      cardBody.push({
        type: 'TextBlock',
        text: `⚠️ ${notFoundEans.length} EAN(s) not found in Odoo:`,
        color: 'warning',
        wrap: true,
        separator: true
      });

      // Show the actual EANs in a monospace code block
      cardBody.push({
        type: 'TextBlock',
        text: eansToShow.join(', ') + (hasMore ? ` ... and ${notFoundEans.length - maxToShow} more` : ''),
        fontType: 'monospace',
        wrap: true
      });
    } else if (syncResults.skippedNotInOdoo > 0) {
      // Fallback if notFoundEans array is not available
      cardBody.push({
        type: 'TextBlock',
        text: `⚠️ ${syncResults.skippedNotInOdoo} EANs not found in Odoo`,
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
   * Send error escalation to Teams with CSV file for manual upload
   * @param {Object} errorInfo - Error details
   * @param {string} csvUrl - URL to the CSV file for manual upload
   * @returns {Object} { success, error }
   */
  async sendErrorEscalation(errorInfo, csvUrl = null) {
    if (!this.escalationWebhookUrl) {
      console.log('[BolStockReportService] Teams escalation webhook not configured, skipping');
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
        text: '🚨 Bol.com Stock Sync FAILED - Manual Action Required',
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

    if (errorInfo.affectedOffers) {
      cardBody.push({
        type: 'TextBlock',
        text: `**Affected Offers:** ${errorInfo.affectedOffers}`,
        wrap: true
      });
    }

    if (csvUrl) {
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
            text: '1. Download the CSV file using the button below\n2. Go to Bol.com Seller Portal > Aanbod > Voorraad beheren\n3. Upload the CSV file\n4. Review and confirm the upload',
            wrap: true
          }
        ]
      });
    }

    const actions = [];
    if (csvUrl) {
      actions.push({
        type: 'Action.OpenUrl',
        title: '📥 Download CSV File',
        url: csvUrl
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
              console.log('[BolStockReportService] Teams notification sent successfully');
              resolve({ success: true });
            } else {
              console.error(`[BolStockReportService] Teams webhook failed: ${res.statusCode} - ${responseData}`);
              resolve({ success: false, error: `HTTP ${res.statusCode}` });
            }
          });
        });

        req.on('error', (error) => {
          console.error('[BolStockReportService] Teams webhook error:', error.message);
          resolve({ success: false, error: error.message });
        });

        req.write(postData);
        req.end();

      } catch (error) {
        console.error('[BolStockReportService] Error sending to Teams:', error.message);
        resolve({ success: false, error: error.message });
      }
    });
  }

  /**
   * Full report flow: Generate Excel, upload to OneDrive, send Teams notification
   * ALWAYS sends Teams notification (even when no changes, to confirm system ran)
   * Only generates Excel report if there ARE changes
   * @param {Object} syncResults - Results from BolStockSync.syncFromOfferExport()
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
        const filename = `BOL_Stock_Update_${timestamp}.xlsx`;

        const excelBuffer = await this.generateExcel(syncResults);

        // Try OneDrive first (primary storage)
        const uploadResult = await this.uploadToOneDrive(excelBuffer, filename);
        if (uploadResult.success) {
          reportUrl = uploadResult.url;
          result.excelUrl = reportUrl;
        } else {
          // Fallback to local storage
          console.warn('[BolStockReportService] OneDrive upload failed, trying local fallback:', uploadResult.error);
          const localResult = await this.saveLocally(excelBuffer, filename);
          if (localResult.success) {
            reportUrl = localResult.url;
            result.excelUrl = reportUrl;
          } else {
            console.error('[BolStockReportService] Both OneDrive and local save failed');
          }
        }
      }

      // ALWAYS send Teams notification (even if no changes, to confirm system ran)
      const teamsResult = await this.sendToTeams(syncResults, reportUrl);
      result.teamsNotified = teamsResult.success;

      result.reported = true;
      const changeText = hasChanges ? `${summary.increases + summary.decreases} changes` : 'no changes';
      console.log(`[BolStockReportService] Report: ${changeText}, OneDrive=${result.excelUrl ? 'Yes' : 'No'}, Teams=${result.teamsNotified}`);

      return result;

    } catch (error) {
      console.error('[BolStockReportService] Report generation failed:', error.message);
      result.error = error.message;
      return result;
    }
  }
}

// Singleton instance
let reportServiceInstance = null;

/**
 * Get the singleton BolStockReportService instance
 */
function getBolStockReportService() {
  if (!reportServiceInstance) {
    reportServiceInstance = new BolStockReportService();
  }
  return reportServiceInstance;
}

module.exports = {
  BolStockReportService,
  getBolStockReportService
};
