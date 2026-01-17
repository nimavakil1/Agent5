require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parse/sync');

// Order IDs from the invoices that were missing VCS data (from the check)
// These are the ones with refs like FBA171-xxx, FBA302-xxx, FBA306-xxx, FBA403-xxx, FBA406-xxx, FBA407-xxx, FBA408-xxx
const MISSING_ORDER_IDS = [
  '402-6819718-3689940',
  '405-7668060-9687549',
  '171-3993131-0629916',
  '306-4762737-4445945',
  '306-6807390-9520350',
  '302-1107761-2749130',
  '403-4722617-9551543',
  '171-2766156-7130700',
  '406-2774640-2364353',
  '408-4528102-6190720',
  '028-5133767-6877912',
  '407-7315844-7265912',
  '407-8845531-3980311',
  '306-1607327-1583524',
  // Add more from the report...
];

// Also search for ALL order IDs from the 113 invoices to build complete picture
const ALL_ORDER_IDS = [
  '402-6819718-3689940', '405-7668060-9687549', '407-7977232-3148356', '406-3788725-6686734',
  '305-2515977-4840365', '404-1453717-7463508', '403-2732315-9551524', '406-6687375-7578748',
  '306-9710118-5002757', '306-1863091-8078748', '028-4755315-6869104', '305-3697272-4854744',
  '306-8833006-1831517', '407-4398969-6367509', '405-9688425-7212369', '305-3882509-3560307',
  '408-2008832-1801166', '171-3993131-0629916', '306-4762737-4445945', '306-6807390-9520350',
  '302-1107761-2749130', '403-4722617-9551543', '171-2766156-7130700', '406-2774640-2364353',
  '408-4528102-6190720', '028-5133767-6877912', '407-7315844-7265912', '407-8845531-3980311',
  '306-1607327-1583524', '408-2603266-8275526'
];

async function lookupVcsFiles() {
  console.log('Loading VCS files...\n');

  // Load both VCS files
  const vcsFile1 = '/Users/nimavakil/Downloads/taxReport_c26b0feaf8d3ff691909ff5ae0bc274897c92e8b (1).csv';
  const vcsFile2 = '/Users/nimavakil/Downloads/taxReport_07c4ec70eff1c89a26c1d786aba98e822e0691c0 (1).csv';

  const vcsData = new Map();

  for (const file of [vcsFile1, vcsFile2]) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const records = csv.parse(content, { columns: true, skip_empty_lines: true });

      console.log('File:', file.split('/').pop());
      console.log('Records:', records.length);

      for (const row of records) {
        const orderId = row['Order ID'];
        if (orderId && row['Transaction Type'] === 'SHIPMENT') {
          vcsData.set(orderId, {
            marketplace: row['Marketplace ID'],
            shipFromCountry: row['Ship From Country'] || row['SHIP_FROM_COUNTRY'],
            shipToCountry: row['Ship To Country'] || row['SHIP_TO_COUNTRY'],
            taxScheme: row['Tax Reporting Scheme'] || row['Tax Collection Responsibility'],
            currency: row['Currency'],
            itemPrice: row['Item Price'] || row['TOTAL_ACTIVITY_VALUE_AMT_VAT_INCL'],
            vatRate: row['VAT Rate'] || row['Price Taxability'],
            shipDate: row['Shipment Date']
          });
        }
      }
    } catch (error) {
      console.log('Error loading file:', error.message);
    }
  }

  console.log('\nTotal unique orders in VCS files:', vcsData.size);

  // Now search for all order IDs
  console.log('\n========================================');
  console.log('SEARCHING FOR ORDER IDS');
  console.log('========================================\n');

  let found = 0;
  let notFound = 0;

  const results = [];

  for (const orderId of ALL_ORDER_IDS) {
    const vcs = vcsData.get(orderId);
    if (vcs) {
      found++;
      results.push({
        orderId,
        found: true,
        ...vcs
      });
      console.log('FOUND:', orderId);
      console.log('  Marketplace:', vcs.marketplace, '| From:', vcs.shipFromCountry, '-> To:', vcs.shipToCountry);
      console.log('  Tax Scheme:', vcs.taxScheme, '| Price:', vcs.itemPrice);
    } else {
      notFound++;
      results.push({
        orderId,
        found: false
      });
      console.log('NOT FOUND:', orderId);
    }
    console.log('');
  }

  console.log('========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log('Found:', found);
  console.log('Not found:', notFound);

  // Save results
  fs.writeFileSync('/tmp/vcs_lookup_results.json', JSON.stringify(results, null, 2));
  console.log('\nResults saved to /tmp/vcs_lookup_results.json');
}

lookupVcsFiles().catch(e => console.error(e));
