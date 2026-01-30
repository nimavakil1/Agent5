#!/usr/bin/env node
/**
 * Analyze VCS Data Structure
 *
 * Understand the different fields and values in VCS orders
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

async function main() {
  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const db = mongo.db(process.env.MONGO_DB_NAME || 'agent5');

  try {
    console.log('=== VCS DATA STRUCTURE ANALYSIS ===\n');

    // 1. Get unique taxReportingScheme values
    const schemes = await db.collection('amazon_vcs_orders').distinct('taxReportingScheme');
    console.log('1. Unique taxReportingScheme values:', schemes);

    // 2. Count by isAmazonInvoiced
    const amazonInvoicedTrue = await db.collection('amazon_vcs_orders').countDocuments({ isAmazonInvoiced: true });
    const amazonInvoicedFalse = await db.collection('amazon_vcs_orders').countDocuments({ isAmazonInvoiced: false });
    console.log('\n2. isAmazonInvoiced: true=' + amazonInvoicedTrue + ', false=' + amazonInvoicedFalse);

    // 3. Count by exportOutsideEu
    const exportTrue = await db.collection('amazon_vcs_orders').countDocuments({ exportOutsideEu: true });
    const exportFalse = await db.collection('amazon_vcs_orders').countDocuments({ exportOutsideEu: false });
    console.log('\n3. exportOutsideEu: true=' + exportTrue + ', false=' + exportFalse);

    // 4. Sample each taxReportingScheme with details
    console.log('\n=== SAMPLES BY TAX REPORTING SCHEME ===');
    for (const scheme of schemes) {
      const sample = await db.collection('amazon_vcs_orders').findOne({ taxReportingScheme: scheme });
      if (sample) {
        const schemeLabel = scheme || '(empty)';
        console.log('\n--- Scheme: "' + schemeLabel + '" ---');
        console.log('orderId:', sample.orderId);
        console.log('shipFrom:', sample.shipFromCountry, '-> shipTo:', sample.shipToCountry);
        console.log('isAmazonInvoiced:', sample.isAmazonInvoiced);
        console.log('exportOutsideEu:', sample.exportOutsideEu);
        console.log('buyerTaxRegistration:', sample.buyerTaxRegistration || '(empty)');
        console.log('totalTax:', sample.totalTax, '/ totalExclusive:', sample.totalExclusive);
        console.log('vatInvoiceNumber:', sample.vatInvoiceNumber || '(empty)');
      }
    }

    // 5. Cross-tabulation: taxReportingScheme x isAmazonInvoiced x hasBuyerVat
    console.log('\n=== CROSS-TABULATION ===');
    const pipeline = [
      {
        $group: {
          _id: {
            scheme: { $ifNull: ['$taxReportingScheme', '(empty)'] },
            isAmazonInvoiced: '$isAmazonInvoiced',
            hasBuyerVat: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$buyerTaxRegistration', ''] } }, 0] }, true, false] },
            hasTax: { $cond: [{ $gt: ['$totalTax', 0] }, true, false] }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ];

    const results = await db.collection('amazon_vcs_orders').aggregate(pipeline).toArray();
    console.log('scheme | isAmazonInvoiced | hasBuyerVat | hasTax | count');
    console.log('-------|------------------|-------------|--------|------');
    for (const r of results.slice(0, 20)) {
      console.log(
        (r._id.scheme || '').padEnd(20) + ' | ' +
        String(r._id.isAmazonInvoiced).padEnd(16) + ' | ' +
        String(r._id.hasBuyerVat).padEnd(11) + ' | ' +
        String(r._id.hasTax).padEnd(6) + ' | ' +
        r.count
      );
    }

    // 6. Analyze 0% tax scenarios in detail
    console.log('\n=== 0% TAX SCENARIOS BREAKDOWN ===');
    const zeroTaxPipeline = [
      { $match: { totalTax: 0, totalExclusive: { $gt: 0 } } },
      {
        $group: {
          _id: {
            scheme: { $ifNull: ['$taxReportingScheme', '(empty)'] },
            isAmazonInvoiced: '$isAmazonInvoiced',
            hasBuyerVat: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$buyerTaxRegistration', ''] } }, 0] }, true, false] },
            exportOutsideEu: '$exportOutsideEu'
          },
          count: { $sum: 1 },
          sampleOrderId: { $first: '$orderId' },
          sampleRoute: { $first: { $concat: ['$shipFromCountry', '->', '$shipToCountry'] } }
        }
      },
      { $sort: { count: -1 } }
    ];

    const zeroTaxResults = await db.collection('amazon_vcs_orders').aggregate(zeroTaxPipeline).toArray();
    console.log('scheme | amzInvoiced | buyerVat | export | count | sample route');
    console.log('-------|-------------|----------|--------|-------|-------------');
    for (const r of zeroTaxResults) {
      console.log(
        (r._id.scheme || '').padEnd(15) + ' | ' +
        String(r._id.isAmazonInvoiced).padEnd(11) + ' | ' +
        String(r._id.hasBuyerVat).padEnd(8) + ' | ' +
        String(r._id.exportOutsideEu).padEnd(6) + ' | ' +
        String(r.count).padEnd(5) + ' | ' +
        r.sampleRoute
      );
    }

  } finally {
    await mongo.close();
  }
}

main().catch(console.error);
