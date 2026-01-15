require('dotenv').config();
const { getSellerFinanceClient } = require('../src/services/amazon/seller/SellerFinanceClient');

const TARGET_ORDER_IDS = [
  '204-7196349-7992340',
  '205-8350856-4897102',
  '026-6860926-8294745',
  '026-8504421-0205103',
  '026-3262942-5229108',
  '203-3069498-5172339',
  '206-0218522-0445105',
  '204-5237231-4253101',
  '204-6740016-3306755',
  '206-4460570-6791536'
];

async function getDeemedResellerPrices() {
  console.log('Fetching settlement data for', TARGET_ORDER_IDS.length, 'deemed reseller orders\n');
  console.log('Target orders shipped: August 2024 (02-Aug to 05-Aug)\n');

  const financeClient = getSellerFinanceClient();

  // First, test connection
  console.log('Testing Finance API connection...');
  const testResult = await financeClient.testConnection();
  console.log('Connection:', testResult.success ? 'OK' : 'FAILED');
  if (!testResult.success) {
    console.error('Error:', testResult.message);
    return;
  }

  // Get settlement reports from around August 2024
  console.log('\n========================================');
  console.log('FETCHING SETTLEMENT REPORTS');
  console.log('========================================\n');

  // August 2024 settlements
  const startDate = new Date('2024-07-15');

  const reports = await financeClient.getSettlementReports({
    pageSize: 50,
    createdAfter: startDate
  });

  console.log('Settlement reports found:', reports.length);

  if (reports.length === 0) {
    console.log('No settlement reports found. Trying financial events instead...');

    // Try financial events as alternative
    console.log('\n========================================');
    console.log('FETCHING FINANCIAL EVENTS');
    console.log('========================================\n');

    const events = await financeClient.getFinancialEvents({
      postedAfter: new Date('2024-08-01'),
      maxResults: 100
    });

    console.log('Financial events:', JSON.stringify(events, null, 2).substring(0, 2000));
    return;
  }

  // Show available reports
  console.log('\nAvailable settlement reports:');
  for (const report of reports.slice(0, 20)) {
    console.log('  Report ID:', report.reportId);
    console.log('    Created:', report.createdTime);
    console.log('    Data Start:', report.dataStartTime);
    console.log('    Data End:', report.dataEndTime);
    console.log('');
  }

  // Find reports that cover August 2024
  const augustReports = reports.filter(r => {
    const start = new Date(r.dataStartTime);
    const end = new Date(r.dataEndTime);
    const targetStart = new Date('2024-08-01');
    const targetEnd = new Date('2024-08-10');
    return (start <= targetEnd && end >= targetStart);
  });

  console.log('\nReports covering August 2024:', augustReports.length);

  if (augustReports.length === 0) {
    console.log('No reports found for August 2024 period.');
    console.log('Available date ranges:');
    for (const r of reports.slice(0, 10)) {
      console.log('  ', r.dataStartTime, 'to', r.dataEndTime);
    }
    return;
  }

  // Download and search for our orders
  console.log('\n========================================');
  console.log('SEARCHING FOR TARGET ORDERS');
  console.log('========================================\n');

  const foundOrders = new Map();

  for (const report of augustReports) {
    console.log('Downloading report:', report.reportId);
    console.log('  Period:', report.dataStartTime, 'to', report.dataEndTime);

    try {
      const settlementData = await financeClient.downloadSettlementReport(report.reportId);
      console.log('  Transactions:', settlementData.transactionCount);

      // Search for our target orders
      for (const tx of settlementData.transactions) {
        const orderId = tx.orderId || tx.merchantOrderId;
        if (TARGET_ORDER_IDS.includes(orderId)) {
          if (!foundOrders.has(orderId)) {
            foundOrders.set(orderId, []);
          }
          foundOrders.get(orderId).push({
            settlementId: settlementData.settlementId,
            transactionType: tx.transactionType,
            amountType: tx.amountType,
            amountDescription: tx.amountDescription,
            amount: tx.amount,
            currency: settlementData.currency,
            marketplace: tx.marketplaceName,
            postedDate: tx.postedDate
          });
        }
      }
    } catch (error) {
      console.log('  Error:', error.message);
    }
  }

  // Show results
  console.log('\n========================================');
  console.log('RESULTS');
  console.log('========================================\n');

  console.log('Orders found:', foundOrders.size, '/', TARGET_ORDER_IDS.length);

  for (const [orderId, transactions] of foundOrders) {
    console.log('\nOrder:', orderId);
    let total = 0;
    for (const tx of transactions) {
      console.log('  Type:', tx.transactionType, '|', tx.amountType);
      console.log('  Amount:', tx.amount, tx.currency);
      console.log('  Description:', tx.amountDescription);
      total += tx.amount;
    }
    console.log('  TOTAL:', total.toFixed(2));
  }

  // List orders not found
  const notFound = TARGET_ORDER_IDS.filter(id => !foundOrders.has(id));
  if (notFound.length > 0) {
    console.log('\nOrders NOT FOUND in settlements:');
    for (const id of notFound) {
      console.log('  ', id);
    }
  }
}

getDeemedResellerPrices().then(() => process.exit(0)).catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
