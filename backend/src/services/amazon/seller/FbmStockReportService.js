/**
 * FbmStockReportService - Simplified Excel reports and Teams notifications for FBM stock sync
 *
 * Features:
 * - Generate simple Excel report showing what was sent to Amazon
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
 * FbmStockReportService - Simple reporting for FBM stock sync
 */
class FbmStockReportService {
  constructor() {
    this.webhookUrl = process.env.TEAMS_FBM_REPORT_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL;
  }

  /**
   * Generate simplified Excel report showing what was sent to Amazon
   * @param {Object} syncResults - Results from SellerFbmStockExport.syncStock()
   * @returns {Buffer} Excel file buffer
   */
  async generateExcel(syncResults) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Agent5 FBM Stock Sync';
    workbook.created = new Date();

    // Marketplace columns
    const MARKETPLACES = ['DE', 'FR', 'NL', 'BE', 'ES', 'IT', 'UK'];

    const worksheet = workbook.addWorksheet('FBM Stock Sent', {
      views: [{ state: 'frozen', ySplit: 3 }]
    });

    // Summary section
    const now = new Date();
    const dateStr = now.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

    const sentItems = syncResults.sentItems || [];
    const summary = syncResults.summary || {};

    worksheet.addRow(['Amazon FBM Stock Update Report', '', '', '', '', '', '', '', '', '', dateStr]);
    worksheet.mergeCells('A1:J1');
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('K1').font = { italic: true, size: 10 };

    // Summary row
    const summaryText = `Total: ${summary.totalSkus || sentItems.length} SKUs | With Stock: ${summary.withStock || 0} | Zero Stock: ${summary.zeroStock || 0}`;
    worksheet.addRow([summaryText]);
    worksheet.mergeCells('A2:K2');
    worksheet.getCell('A2').font = { italic: true };
    worksheet.getCell('A2').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF2CC' }
    };

    // Header row - simplified: no before/delta columns
    worksheet.addRow([
      'ASIN',
      'Amazon SKU',
      'Odoo SKU',
      'CW Free QTY',
      'Safety Stock',
      'Sent to Amazon',
      'Status',
      ...MARKETPLACES
    ]);

    // Style header row
    const headerRow = worksheet.getRow(3);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };

    // Column widths
    worksheet.columns = [
      { width: 15 },  // ASIN
      { width: 25 },  // Amazon SKU
      { width: 20 },  // Odoo SKU
      { width: 14 },  // CW Free QTY
      { width: 13 },  // Safety Stock
      { width: 16 },  // Sent to Amazon
      { width: 12 },  // Status
      { width: 5 },   // DE
      { width: 5 },   // FR
      { width: 5 },   // NL
      { width: 5 },   // BE
      { width: 5 },   // ES
      { width: 5 },   // IT
      { width: 5 }    // UK
    ];

    const totalColumns = 7 + MARKETPLACES.length;

    // Add data rows
    for (const item of sentItems) {
      const itemMarketplaces = item.marketplaces || MARKETPLACES;
      const marketplaceMarks = MARKETPLACES.map(mp =>
        itemMarketplaces.includes(mp) ? 'x' : ''
      );

      const row = worksheet.addRow([
        item.asin || '',
        item.amazonSku || '',
        item.odooSku || '',
        item.cwFreeQty ?? 0,
        item.safetyStock ?? 10,
        item.sentQty ?? 0,
        item.status || 'sent',
        ...marketplaceMarks
      ]);

      // Color code "Sent to Amazon" column based on value
      const sentCell = row.getCell(6);
      const sentQty = item.sentQty || 0;

      if (sentQty === 0) {
        sentCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' } // Light red for zero stock
        };
        sentCell.font = { color: { argb: 'FF9C0006' } };
      } else if (sentQty > 0) {
        sentCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFC6EFCE' } // Light green for available stock
        };
        sentCell.font = { color: { argb: 'FF006100' } };
      }

      // Status formatting
      const statusCell = row.getCell(7);
      if (item.status === 'success') {
        statusCell.font = { color: { argb: 'FF006100' } };
      } else if (item.status === 'failed') {
        statusCell.font = { color: { argb: 'FF9C0006' } };
      }

      // Center marketplace columns
      for (let col = 8; col <= totalColumns; col++) {
        row.getCell(col).alignment = { horizontal: 'center' };
      }
    }

    // Auto-filter
    worksheet.autoFilter = {
      from: { row: 3, column: 1 },
      to: { row: 3 + sentItems.length, column: totalColumns }
    };

    // Borders
    const lastRow = 3 + sentItems.length;
    for (let row = 3; row <= lastRow; row++) {
      for (let col = 1; col <= totalColumns; col++) {
        const cell = worksheet.getCell(row, col);
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
        };
      }
    }

    return workbook.xlsx.writeBuffer();
  }

  /**
   * Upload Excel report to OneDrive/SharePoint
   */
  async uploadToOneDrive(buffer, filename) {
    try {
      if (!oneDriveService.graphClient) {
        console.log('[FbmStockReportService] OneDrive not configured, skipping upload');
        return { success: false, error: 'OneDrive not configured' };
      }

      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const folderPath = `/${REPORTS_FOLDER}/${year}/${month}`;

      await oneDriveService.ensureFolderExists(folderPath);

      const remotePath = `${folderPath}/${filename}`;
      const drivePath = await oneDriveService.getDrivePath();

      const uploadedFile = await oneDriveService.graphClient
        .api(`${drivePath}/root:${remotePath}:/content`)
        .put(buffer);

      const sharingLink = await oneDriveService.graphClient
        .api(`${drivePath}/items/${uploadedFile.id}/createLink`)
        .post({ type: 'view', scope: 'organization' });

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
   * Send Teams notification with simplified summary
   */
  async sendToTeams(syncResults, reportUrl = null) {
    if (!this.webhookUrl) {
      console.log('[FbmStockReportService] Teams webhook not configured');
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

    const hasErrors = syncResults.itemsFailed > 0 || syncResults.error;

    const cardBody = [
      {
        type: 'TextBlock',
        text: `📦 Amazon FBM Stock Sync - ${dateStr}`,
        weight: 'bolder',
        size: 'medium',
        color: hasErrors ? 'warning' : 'default'
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Total SKUs', value: String(summary.totalSkus || 0) },
          { title: 'With Stock', value: String(summary.withStock || 0) },
          { title: 'Zero Stock', value: String(summary.zeroStock || 0) },
          { title: 'Below Safety Stock', value: `⚠️ ${summary.belowSafetyStock || 0}` },
          { title: 'Sent', value: String(syncResults.itemsUpdated || 0) },
          { title: 'Failed', value: String(syncResults.itemsFailed || 0) }
        ]
      }
    ];

    // Warning if many products below safety stock
    if ((summary.belowSafetyStock || 0) > 0) {
      cardBody.push({
        type: 'TextBlock',
        text: `ℹ️ ${summary.belowSafetyStock} products have stock but below safety stock (listed as 0)`,
        color: 'warning',
        wrap: true,
        size: 'small'
      });
    }

    if (syncResults.itemsFailed > 0) {
      cardBody.push({
        type: 'TextBlock',
        text: `⚠️ ${syncResults.itemsFailed} items failed to send`,
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

    // Unresolved SKUs
    if (syncResults.unresolved > 0 && syncResults.unresolvedSkus?.length > 0) {
      const skusToShow = syncResults.unresolvedSkus.slice(0, 10);
      const hasMore = syncResults.unresolvedSkus.length > 10;

      cardBody.push({
        type: 'TextBlock',
        text: `⚠️ ${syncResults.unresolved} SKU(s) could not be resolved:`,
        color: 'warning',
        wrap: true,
        separator: true
      });

      const skuList = skusToShow.map(s => s.sellerSku || s.amazonSku || s).join(', ');
      cardBody.push({
        type: 'TextBlock',
        text: skuList + (hasMore ? ` ... +${syncResults.unresolvedSkus.length - 10} more` : ''),
        fontType: 'monospace',
        wrap: true
      });
    }

    const actions = [];
    if (reportUrl) {
      actions.push({
        type: 'Action.OpenUrl',
        title: '📥 Download Report',
        url: reportUrl
      });
    }

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
   * Post adaptive card to Teams webhook
   */
  async _postToWebhook(card) {
    return new Promise((resolve) => {
      try {
        const message = {
          type: 'message',
          attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: card
          }]
        };

        const parsedUrl = url.parse(this.webhookUrl);
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
          res.on('data', (chunk) => { responseData += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200 || res.statusCode === 202) {
              console.log('[FbmStockReportService] Teams notification sent');
              resolve({ success: true });
            } else {
              console.error(`[FbmStockReportService] Teams failed: ${res.statusCode}`);
              resolve({ success: false, error: `HTTP ${res.statusCode}` });
            }
          });
        });

        req.on('error', (error) => {
          console.error('[FbmStockReportService] Teams error:', error.message);
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
   * Full report flow: Generate Excel, upload, send Teams notification
   * Always generates and sends report (no conditional on changes)
   */
  async generateAndSendReport(syncResults) {
    const result = {
      reported: false,
      excelUrl: null,
      teamsNotified: false,
      error: null
    };

    try {
      const sentItems = syncResults.sentItems || [];

      // Always generate Excel if we have items
      let reportUrl = null;

      if (sentItems.length > 0) {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `FBM_Stock_Sent_${timestamp}.xlsx`;

        const excelBuffer = await this.generateExcel(syncResults);

        const uploadResult = await this.uploadToOneDrive(excelBuffer, filename);
        if (uploadResult.success) {
          reportUrl = uploadResult.url;
          result.excelUrl = reportUrl;
        }
      }

      // Always send Teams notification
      const teamsResult = await this.sendToTeams(syncResults, reportUrl);
      result.teamsNotified = teamsResult.success;

      result.reported = true;
      const summary = syncResults.summary || {};
      console.log(`[FbmStockReportService] Report: ${summary.totalSkus || 0} SKUs, OneDrive=${result.excelUrl ? 'Yes' : 'No'}, Teams=${result.teamsNotified}`);

      return result;

    } catch (error) {
      console.error('[FbmStockReportService] Report generation failed:', error.message);
      result.error = error.message;
      return result;
    }
  }
}

// Singleton
let reportServiceInstance = null;

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
