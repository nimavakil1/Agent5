#!/usr/bin/env node
/**
 * Analyze Zero Tax Scenarios in VCS Data
 *
 * Different scenarios where VCS shows 0% tax:
 * 1. Export (outside EU) - No VAT
 * 2. Amazon-invoiced - Amazon already collected VAT
 * 3. B2B Intra-Community - Reverse charge (seller doesn't charge VAT, buyer self-accounts)
 * 4. Other edge cases
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

async function main() {
  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const db = mongo.db(process.env.MONGO_DB_NAME || 'agent5');

  try {
    // Find orders with 0% tax and analyze the different scenarios
    const zeroTaxOrders = await db.collection('amazon_vcs_orders').find({
      totalTax: 0,
      totalExclusive: { $gt: 0 }
    }).limit(1000).toArray();

    console.log('=== ANALYSIS OF 0% TAX ORDERS ===');
    console.log('Total samples:', zeroTaxOrders.length);

    // Categorize by scenario
    const scenarios = {
      export: [],
      amazonInvoiced_noBuyerVat: [],
      amazonInvoiced_withBuyerVat: [],
      sellerInvoiced_withBuyerVat: [],
      sellerInvoiced_noBuyerVat_crossBorder: [],
      sellerInvoiced_noBuyerVat_domestic: []
    };

    for (const order of zeroTaxOrders) {
      const shipTo = order.shipToCountry;
      const shipFrom = order.shipFromCountry;
      const isExport = order.exportOutsideEu || (shipTo && !EU_COUNTRIES.includes(shipTo));
      const hasBuyerVat = !!(order.buyerTaxRegistration && order.buyerTaxRegistration.trim());
      const isAmazonInvoiced = order.isAmazonInvoiced;
      const isCrossBorder = shipFrom !== shipTo;

      if (isExport) {
        scenarios.export.push(order);
      } else if (isAmazonInvoiced && hasBuyerVat) {
        scenarios.amazonInvoiced_withBuyerVat.push(order);
      } else if (isAmazonInvoiced && !hasBuyerVat) {
        scenarios.amazonInvoiced_noBuyerVat.push(order);
      } else if (!isAmazonInvoiced && hasBuyerVat) {
        scenarios.sellerInvoiced_withBuyerVat.push(order);
      } else if (!isAmazonInvoiced && isCrossBorder) {
        scenarios.sellerInvoiced_noBuyerVat_crossBorder.push(order);
      } else {
        scenarios.sellerInvoiced_noBuyerVat_domestic.push(order);
      }
    }

    console.log('\n=== BREAKDOWN ===');
    console.log('1. Export (outside EU):', scenarios.export.length);
    console.log('2. Amazon-invoiced B2C (no buyer VAT):', scenarios.amazonInvoiced_noBuyerVat.length);
    console.log('3. Amazon-invoiced B2B (WITH buyer VAT):', scenarios.amazonInvoiced_withBuyerVat.length);
    console.log('4. Seller-invoiced B2B (WITH buyer VAT = Intra-Community reverse charge):', scenarios.sellerInvoiced_withBuyerVat.length);
    console.log('5. Seller-invoiced, no buyer VAT, CROSS-BORDER:', scenarios.sellerInvoiced_noBuyerVat_crossBorder.length);
    console.log('6. Seller-invoiced, no buyer VAT, DOMESTIC:', scenarios.sellerInvoiced_noBuyerVat_domestic.length);

    // Sample each scenario
    if (scenarios.export.length > 0) {
      console.log('\n--- 1. Export Sample ---');
      const s = scenarios.export[0];
      console.log('orderId:', s.orderId, '| shipFrom:', s.shipFromCountry, '-> shipTo:', s.shipToCountry);
      console.log('exportOutsideEu:', s.exportOutsideEu, '| scheme:', s.taxReportingScheme);
      console.log('Expected: Export fiscal position + 0% export tax');
    }

    if (scenarios.amazonInvoiced_noBuyerVat.length > 0) {
      console.log('\n--- 2. Amazon-invoiced B2C Sample ---');
      const s = scenarios.amazonInvoiced_noBuyerVat[0];
      console.log('orderId:', s.orderId, '| shipFrom:', s.shipFromCountry, '-> shipTo:', s.shipToCountry);
      console.log('isAmazonInvoiced:', s.isAmazonInvoiced, '| scheme:', s.taxReportingScheme);
      console.log('Expected: OSS/domestic fiscal position + 0% tax (Amazon already collected VAT)');
    }

    if (scenarios.amazonInvoiced_withBuyerVat.length > 0) {
      console.log('\n--- 3. Amazon-invoiced B2B Sample ---');
      const s = scenarios.amazonInvoiced_withBuyerVat[0];
      console.log('orderId:', s.orderId, '| shipFrom:', s.shipFromCountry, '-> shipTo:', s.shipToCountry);
      console.log('isAmazonInvoiced:', s.isAmazonInvoiced, '| scheme:', s.taxReportingScheme);
      console.log('buyerTaxRegistration:', s.buyerTaxRegistration);
      console.log('Expected: Intra-community/B2B fiscal position + 0% (Amazon collected but B2B context)');
    }

    if (scenarios.sellerInvoiced_withBuyerVat.length > 0) {
      console.log('\n--- 4. Seller-invoiced B2B (Intra-Community Reverse Charge) ---');
      scenarios.sellerInvoiced_withBuyerVat.slice(0, 3).forEach(s => {
        console.log('\norderId:', s.orderId, '| shipFrom:', s.shipFromCountry, '-> shipTo:', s.shipToCountry);
        console.log('isAmazonInvoiced:', s.isAmazonInvoiced, '| scheme:', s.taxReportingScheme);
        console.log('buyerTaxRegistration:', s.buyerTaxRegistration);
      });
      console.log('\nExpected: Intra-Community B2B fiscal position + 0% ICO tax (reverse charge)');
    }

    if (scenarios.sellerInvoiced_noBuyerVat_crossBorder.length > 0) {
      console.log('\n--- 5. Seller-invoiced, no buyer VAT, CROSS-BORDER ---');
      scenarios.sellerInvoiced_noBuyerVat_crossBorder.slice(0, 3).forEach(s => {
        console.log('\norderId:', s.orderId, '| shipFrom:', s.shipFromCountry, '-> shipTo:', s.shipToCountry);
        console.log('isAmazonInvoiced:', s.isAmazonInvoiced, '| scheme:', s.taxReportingScheme);
      });
      console.log('\n⚠️  This is unusual - cross-border B2C without Amazon invoicing should have OSS VAT');
    }

    if (scenarios.sellerInvoiced_noBuyerVat_domestic.length > 0) {
      console.log('\n--- 6. Seller-invoiced, no buyer VAT, DOMESTIC ---');
      scenarios.sellerInvoiced_noBuyerVat_domestic.slice(0, 3).forEach(s => {
        console.log('\norderId:', s.orderId, '| shipFrom:', s.shipFromCountry, '-> shipTo:', s.shipToCountry);
        console.log('isAmazonInvoiced:', s.isAmazonInvoiced, '| scheme:', s.taxReportingScheme);
      });
      console.log('\n⚠️  This is unusual - domestic B2C without VAT is rare (unless special exemption)');
    }

    // Analyze routes for cross-border seller-invoiced with no VAT
    if (scenarios.sellerInvoiced_noBuyerVat_crossBorder.length > 0) {
      console.log('\n=== ROUTE ANALYSIS: Seller-invoiced cross-border without buyer VAT ===');
      const routes = {};
      for (const o of scenarios.sellerInvoiced_noBuyerVat_crossBorder) {
        const route = `${o.shipFromCountry}->${o.shipToCountry}`;
        routes[route] = (routes[route] || 0) + 1;
      }
      Object.entries(routes).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([route, count]) => {
        console.log(`  ${route}: ${count}`);
      });
    }

  } finally {
    await mongo.close();
  }
}

main().catch(console.error);
