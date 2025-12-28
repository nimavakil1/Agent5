/**
 * Test script for Amazon SP-API Finance App
 * Tests fetching Settlement Reports and VCS Reports
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const SellingPartner = require('amazon-sp-api');

// Finance App credentials
const financeConfig = {
  region: 'eu',
  refresh_token: process.env.AMAZON_FINANCE_SELLER_REFRESH_TOKEN,
  credentials: {
    SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_FINANCE_LWA_CLIENT_ID,
    SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_FINANCE_LWA_CLIENT_SECRET
  },
  options: {
    auto_request_tokens: true,
    auto_request_throttled: true,
    version_fallback: true
  }
};

async function testFinanceAPI() {
  console.log('=== Testing Amazon SP-API Finance App ===\n');

  // Check credentials
  console.log('Finance App credentials:');
  console.log('  Client ID:', process.env.AMAZON_FINANCE_LWA_CLIENT_ID ? '✓ Set' : '✗ Missing');
  console.log('  Client Secret:', process.env.AMAZON_FINANCE_LWA_CLIENT_SECRET ? '✓ Set' : '✗ Missing');
  console.log('  Seller Refresh Token:', process.env.AMAZON_FINANCE_SELLER_REFRESH_TOKEN ? '✓ Set' : '✗ Missing');
  console.log('');

  try {
    const sp = new SellingPartner(financeConfig);
    console.log('✓ SP-API client initialized\n');

    // Test 1: List available settlement reports
    console.log('--- Test 1: Get Settlement Reports ---');
    try {
      const settlementReports = await sp.callAPI({
        operation: 'reports.getReports',
        query: {
          reportTypes: ['GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'],
          pageSize: 5
        }
      });

      console.log(`Found ${settlementReports.reports?.length || 0} settlement reports:`);
      if (settlementReports.reports?.length > 0) {
        for (const report of settlementReports.reports.slice(0, 3)) {
          console.log(`  - ID: ${report.reportId}`);
          console.log(`    Created: ${report.createdTime}`);
          console.log(`    Status: ${report.processingStatus}`);
          console.log(`    Start: ${report.dataStartTime} - End: ${report.dataEndTime}`);
          console.log('');
        }
      }
    } catch (err) {
      console.log('✗ Settlement report error:', err.message);
    }

    // Test 2: Get VCS Tax Transaction Reports
    console.log('\n--- Test 2: Get VCS Tax Transaction Reports ---');
    try {
      const vcsReports = await sp.callAPI({
        operation: 'reports.getReports',
        query: {
          reportTypes: ['GET_VAT_TRANSACTION_DATA'],
          pageSize: 5
        }
      });

      console.log(`Found ${vcsReports.reports?.length || 0} VCS reports:`);
      if (vcsReports.reports?.length > 0) {
        for (const report of vcsReports.reports.slice(0, 3)) {
          console.log(`  - ID: ${report.reportId}`);
          console.log(`    Created: ${report.createdTime}`);
          console.log(`    Status: ${report.processingStatus}`);
          console.log('');
        }
      }
    } catch (err) {
      console.log('✗ VCS report error:', err.message);
    }

    // Test 3: Request a new settlement report
    console.log('\n--- Test 3: Request New Settlement Report ---');
    try {
      // Get last 30 days
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);

      const createReport = await sp.callAPI({
        operation: 'reports.createReport',
        body: {
          reportType: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
          dataStartTime: startDate.toISOString(),
          dataEndTime: endDate.toISOString(),
          marketplaceIds: ['A1PA6795UKMFR9'] // Germany
        }
      });

      console.log('✓ Report creation requested');
      console.log('  Report ID:', createReport.reportId);
    } catch (err) {
      console.log('Note:', err.message);
      // Settlement reports are auto-generated, we can't create them on demand
      // This is expected to fail - let's try listing existing ones instead
    }

    // Test 4: Download the most recent settlement report
    console.log('\n--- Test 4: Download Recent Settlement Report ---');
    try {
      const settlementReports = await sp.callAPI({
        operation: 'reports.getReports',
        query: {
          reportTypes: ['GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'],
          processingStatuses: ['DONE'],
          pageSize: 1
        }
      });

      if (settlementReports.reports?.length > 0) {
        const report = settlementReports.reports[0];
        console.log(`Downloading report ${report.reportId}...`);

        // Get the report document
        const reportDoc = await sp.callAPI({
          operation: 'reports.getReportDocument',
          path: {
            reportDocumentId: report.reportDocumentId
          }
        });

        console.log('  Document ID:', reportDoc.reportDocumentId);
        console.log('  Compression:', reportDoc.compressionAlgorithm || 'None');

        // Download the actual content
        const content = await sp.download(reportDoc, { json: false });
        const lines = content.split('\n');
        console.log(`  Lines in report: ${lines.length}`);
        console.log(`  Headers: ${lines[0].substring(0, 100)}...`);
        if (lines.length > 1) {
          console.log(`  First data row: ${lines[1].substring(0, 100)}...`);
        }
      }
    } catch (err) {
      console.log('✗ Download error:', err.message);
    }

    // Test 5: Try Finances API directly with proper dates
    console.log('\n--- Test 5: Finances API - List Financial Event Groups ---');
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 90);

      const financialEvents = await sp.callAPI({
        operation: 'finances.listFinancialEventGroups',
        query: {
          FinancialEventGroupStartedAfter: startDate.toISOString(),
          MaxResultsPerPage: 5
        }
      });

      console.log(`Found ${financialEvents.FinancialEventGroupList?.length || 0} financial event groups:`);
      if (financialEvents.FinancialEventGroupList?.length > 0) {
        for (const group of financialEvents.FinancialEventGroupList.slice(0, 3)) {
          console.log(`  - Group ID: ${group.FinancialEventGroupId}`);
          console.log(`    Start: ${group.FinancialEventGroupStart}`);
          console.log(`    End: ${group.FinancialEventGroupEnd || 'Open'}`);
          console.log(`    Status: ${group.ProcessingStatus}`);
          console.log(`    Original Total: ${group.OriginalTotal?.CurrencyAmount} ${group.OriginalTotal?.CurrencyCode}`);
          console.log('');
        }
      }
    } catch (err) {
      console.log('✗ Finances API error:', err.message);
    }

    // Test 5: Get financial events for a specific group
    console.log('\n--- Test 5: List Financial Events ---');
    try {
      // List recent financial events
      const postedAfter = new Date();
      postedAfter.setDate(postedAfter.getDate() - 7);

      const events = await sp.callAPI({
        operation: 'finances.listFinancialEvents',
        query: {
          PostedAfter: postedAfter.toISOString(),
          MaxResultsPerPage: 10
        }
      });

      const payload = events.FinancialEvents || {};
      console.log('Financial event types found:');
      for (const [key, value] of Object.entries(payload)) {
        if (Array.isArray(value) && value.length > 0) {
          console.log(`  - ${key}: ${value.length} events`);
        }
      }
    } catch (err) {
      console.log('✗ Financial events error:', err.message);
    }

    console.log('\n=== Test Complete ===');

  } catch (error) {
    console.error('Fatal error:', error.message);
    if (error.message.includes('access denied') || error.message.includes('Unauthorized')) {
      console.log('\nThis may indicate:');
      console.log('1. The Finance App is not fully authorized yet');
      console.log('2. The refresh token needs to be regenerated');
      console.log('3. The role/permissions are not correctly configured');
    }
  }
}

testFinanceAPI();
