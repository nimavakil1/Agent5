#!/usr/bin/env node
/**
 * Download Vendor Report from Amazon
 */

require('dotenv').config();
const { VendorClient } = require('../src/services/amazon/vendor/VendorClient');

const REPORT_ID = process.argv[2] || '50201020447';
const MARKETPLACE = process.argv[3] || 'DE';

async function checkAndDownloadReport() {
  console.log(`Checking report ${REPORT_ID} for ${MARKETPLACE}...`);

  const client = new VendorClient(MARKETPLACE);
  const spClient = await client.getClient();

  try {
    // 1. Get report status
    const report = await spClient.callAPI({
      operation: 'reports.getReport',
      path: { reportId: REPORT_ID }
    });

    console.log('\nReport Status:');
    console.log(`  Type: ${report.reportType}`);
    console.log(`  Status: ${report.processingStatus}`);
    console.log(`  Created: ${report.createdTime}`);

    if (report.processingStatus === 'DONE') {
      console.log(`  Document ID: ${report.reportDocumentId}`);

      // 2. Get document URL
      const doc = await spClient.callAPI({
        operation: 'reports.getReportDocument',
        path: { reportDocumentId: report.reportDocumentId }
      });

      console.log('\nDocument URL:');
      console.log(`  ${doc.url}`);

      // 3. Download the content
      if (doc.url) {
        const https = require('https');
        const zlib = require('zlib');

        console.log('\nDownloading report content...');

        const data = await new Promise((resolve, reject) => {
          https.get(doc.url, (response) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
          });
        });

        // Decompress if needed
        let content;
        if (doc.compressionAlgorithm === 'GZIP') {
          content = zlib.gunzipSync(data).toString('utf8');
        } else {
          content = data.toString('utf8');
        }

        console.log('\n=== REPORT CONTENT (first 2000 chars) ===');
        console.log(content.substring(0, 2000));
        console.log('\n=== END ===');
        console.log(`\nTotal length: ${content.length} characters`);
      }
    } else if (report.processingStatus === 'IN_PROGRESS' || report.processingStatus === 'IN_QUEUE') {
      console.log('\nReport is still processing. Try again in a few minutes.');
    } else if (report.processingStatus === 'FATAL' || report.processingStatus === 'CANCELLED') {
      console.log('\nReport failed or was cancelled.');
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkAndDownloadReport();
