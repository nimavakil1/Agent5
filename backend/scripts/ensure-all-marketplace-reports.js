#!/usr/bin/env node
/**
 * Ensure listings reports exist for ALL EU marketplaces
 * This script:
 * 1. Checks which marketplaces have recent reports
 * 2. Requests new reports for missing ones
 * 3. Waits for all reports to complete
 *
 * Run this BEFORE compare-fbm-stock.js to ensure complete data
 */
require('dotenv').config();
const { getSellerClient } = require('../src/services/amazon/seller/SellerClient');

const LISTINGS_REPORT_TYPE = 'GET_MERCHANT_LISTINGS_DATA';

const EU_MARKETPLACES = {
  'A1PA6795UKMFR9': 'DE',
  'A1RKKUPIHCS9HS': 'ES',
  'A13V1IB3VIYZZH': 'FR',  // Note: Account-specific FR ID
  'A1F83G8C2ARO7P': 'UK',
  'APJ6JRA9NG5V4': 'IT',
  'A1805IZSGTT6HS': 'NL',
  'A2NODRKZP88ZB9': 'SE',
  'A1C3SOZRARQ6R3': 'PL',
  'AMEN7PMS3EDWL': 'BE'
};

const MAX_REPORT_AGE_HOURS = 24;
const POLL_INTERVAL_MS = 10000; // 10 seconds
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('Initializing...');
  const sellerClient = getSellerClient();
  await sellerClient.init();
  const spClient = await sellerClient.getClient();

  // Step 1: Get all existing reports
  console.log('\nStep 1: Checking existing reports...');
  const reportsResponse = await spClient.callAPI({
    operation: 'reports.getReports',
    query: {
      reportTypes: [LISTINGS_REPORT_TYPE],
      processingStatuses: ['DONE', 'IN_PROGRESS', 'IN_QUEUE'],
      pageSize: 100
    }
  });

  const maxAge = MAX_REPORT_AGE_HOURS * 60 * 60 * 1000;
  const now = Date.now();

  // Find recent reports per marketplace
  const recentReports = {};
  const pendingReports = {};

  for (const report of (reportsResponse.reports || [])) {
    const mpId = report.marketplaceIds?.[0];
    if (!mpId || !EU_MARKETPLACES[mpId]) continue;

    const reportAge = now - new Date(report.createdTime).getTime();
    if (reportAge > maxAge) continue;

    const mpName = EU_MARKETPLACES[mpId];

    if (report.processingStatus === 'DONE') {
      if (!recentReports[mpId] || new Date(report.createdTime) > new Date(recentReports[mpId].createdTime)) {
        recentReports[mpId] = report;
      }
    } else if (report.processingStatus === 'IN_PROGRESS' || report.processingStatus === 'IN_QUEUE') {
      pendingReports[mpId] = report;
    }
  }

  console.log('\nMarketplace report status:');
  for (const [mpId, mpName] of Object.entries(EU_MARKETPLACES)) {
    if (recentReports[mpId]) {
      const age = Math.round((now - new Date(recentReports[mpId].createdTime).getTime()) / 3600000);
      console.log(`  ${mpName}: ✓ DONE (${age}h old)`);
    } else if (pendingReports[mpId]) {
      console.log(`  ${mpName}: ⏳ ${pendingReports[mpId].processingStatus}`);
    } else {
      console.log(`  ${mpName}: ✗ No recent report`);
    }
  }

  // Step 2: Request reports for missing marketplaces
  const missingMarketplaces = Object.keys(EU_MARKETPLACES).filter(
    mpId => !recentReports[mpId] && !pendingReports[mpId]
  );

  if (missingMarketplaces.length > 0) {
    console.log(`\nStep 2: Requesting reports for ${missingMarketplaces.length} marketplaces...`);

    for (const mpId of missingMarketplaces) {
      const mpName = EU_MARKETPLACES[mpId];
      try {
        const response = await spClient.callAPI({
          operation: 'reports.createReport',
          body: {
            reportType: LISTINGS_REPORT_TYPE,
            marketplaceIds: [mpId]
          }
        });
        console.log(`  ${mpName}: Requested (${response.reportId})`);
        pendingReports[mpId] = { reportId: response.reportId, processingStatus: 'IN_QUEUE' };

        // Small delay to avoid rate limiting
        await sleep(500);
      } catch (error) {
        console.error(`  ${mpName}: Failed to request - ${error.message}`);
      }
    }
  } else {
    console.log('\nStep 2: All marketplaces have recent or pending reports ✓');
  }

  // Step 3: Wait for pending reports to complete
  const allPendingIds = Object.entries(pendingReports).map(([mpId, report]) => ({
    mpId,
    mpName: EU_MARKETPLACES[mpId],
    reportId: report.reportId
  }));

  if (allPendingIds.length > 0) {
    console.log(`\nStep 3: Waiting for ${allPendingIds.length} pending reports...`);

    const startWait = Date.now();
    let allDone = false;

    while (!allDone && (Date.now() - startWait) < MAX_WAIT_MS) {
      await sleep(POLL_INTERVAL_MS);

      allDone = true;
      for (const { mpId, mpName, reportId } of allPendingIds) {
        if (recentReports[mpId]) continue; // Already done

        try {
          const statusResponse = await spClient.callAPI({
            operation: 'reports.getReport',
            path: { reportId }
          });

          const status = statusResponse.processingStatus;

          if (status === 'DONE') {
            console.log(`  ${mpName}: ✓ DONE`);
            recentReports[mpId] = statusResponse;
          } else if (status === 'CANCELLED' || status === 'FATAL') {
            console.log(`  ${mpName}: ✗ ${status}`);
          } else {
            allDone = false;
          }
        } catch (error) {
          console.error(`  ${mpName}: Error checking status - ${error.message}`);
          allDone = false;
        }
      }

      if (!allDone) {
        const elapsed = Math.round((Date.now() - startWait) / 1000);
        const remaining = allPendingIds.filter(p => !recentReports[p.mpId]).length;
        process.stdout.write(`\r  Waiting... ${elapsed}s elapsed, ${remaining} remaining   `);
      }
    }
    console.log('');
  }

  // Step 4: Final status
  console.log('\n=== Final Report Status ===');
  let allReady = true;
  for (const [mpId, mpName] of Object.entries(EU_MARKETPLACES)) {
    if (recentReports[mpId]) {
      const age = Math.round((now - new Date(recentReports[mpId].createdTime).getTime()) / 3600000);
      console.log(`  ${mpName}: ✓ Ready (${age}h old)`);
    } else {
      console.log(`  ${mpName}: ✗ NOT READY`);
      allReady = false;
    }
  }

  if (allReady) {
    console.log('\n✓ All marketplaces ready! You can now run compare-fbm-stock.js');
    process.exit(0);
  } else {
    console.log('\n✗ Some marketplaces not ready. Reports may still be processing.');
    console.log('  Try running this script again in a few minutes.');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
