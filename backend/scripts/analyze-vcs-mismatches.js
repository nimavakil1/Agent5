#!/usr/bin/env node
/**
 * Analyze VCS Invoice Mismatches
 *
 * Checks all January 2026 VCS invoices for discrepancies between
 * VCS expected totals and Odoo invoice totals.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB_NAME || 'agent5';

async function main() {
  const mongo = new MongoClient(MONGO_URI);
  const odoo = new OdooDirectClient();

  try {
    await mongo.connect();
    const db = mongo.db(DB_NAME);
    await odoo.authenticate();

    console.log('Analyzing January 2026 VCS invoices...\n');

    // Get all orders with invoices from January 2026
    const orders = await db.collection('vcs_orders').find({
      odooInvoiceId: { $exists: true, $ne: null },
      invoiceDate: { $gte: new Date('2026-01-01'), $lt: new Date('2026-02-01') }
    }).toArray();

    console.log(`Found ${orders.length} invoiced orders from January 2026\n`);

    const results = {
      correct: [],
      amazonInvoicedWithVat: [],  // isAmazonInvoiced=true but VAT was added
      odooHigher: [],              // Odoo total > VCS total
      odooLower: [],               // Odoo total < VCS total
      invoiceNotFound: [],
      errors: []
    };

    // Process in batches
    const batchSize = 50;
    for (let i = 0; i < orders.length; i += batchSize) {
      const batch = orders.slice(i, Math.min(i + batchSize, orders.length));

      for (const order of batch) {
        try {
          // Get invoice from Odoo
          const invoice = await odoo.searchRead('account.move',
            [['id', '=', order.odooInvoiceId]],
            ['id', 'name', 'amount_total', 'amount_untaxed', 'amount_tax', 'state']
          );

          if (!invoice || invoice.length === 0) {
            results.invoiceNotFound.push({
              orderId: order.orderId,
              odooInvoiceId: order.odooInvoiceId
            });
            continue;
          }

          const inv = invoice[0];
          const odooTotal = inv.amount_total || 0;
          const odooTax = inv.amount_tax || 0;

          // Calculate VCS expected total
          const vcsTotal = (order.totalInclusive || 0) +
            (order.totalShipping || 0) + (order.totalShippingTax || 0) +
            (order.totalGiftWrap || 0) + (order.totalGiftWrapTax || 0) -
            (order.totalShippingPromo || 0);

          const vcsTax = order.totalTax || 0;
          const diff = Math.abs(odooTotal - vcsTotal);

          if (diff <= 0.05) {
            results.correct.push({
              orderId: order.orderId,
              odooTotal,
              vcsTotal
            });
          } else if (order.isAmazonInvoiced && vcsTax === 0 && odooTax > 0.01) {
            // Amazon already invoiced but we added VAT
            results.amazonInvoicedWithVat.push({
              orderId: order.orderId,
              invoiceName: inv.name,
              odooInvoiceId: order.odooInvoiceId,
              odooTotal,
              odooTax,
              vcsTotal,
              vcsTax,
              diff,
              shipFrom: order.shipFromCountry,
              shipTo: order.shipToCountry,
              taxScheme: order.taxReportingScheme,
              isAmazonInvoiced: order.isAmazonInvoiced
            });
          } else if (odooTotal > vcsTotal) {
            results.odooHigher.push({
              orderId: order.orderId,
              invoiceName: inv.name,
              odooInvoiceId: order.odooInvoiceId,
              odooTotal,
              odooTax,
              vcsTotal,
              vcsTax,
              diff,
              shipFrom: order.shipFromCountry,
              shipTo: order.shipToCountry,
              taxScheme: order.taxReportingScheme,
              isAmazonInvoiced: order.isAmazonInvoiced
            });
          } else {
            results.odooLower.push({
              orderId: order.orderId,
              invoiceName: inv.name,
              odooInvoiceId: order.odooInvoiceId,
              odooTotal,
              odooTax,
              vcsTotal,
              vcsTax,
              diff,
              shipFrom: order.shipFromCountry,
              shipTo: order.shipToCountry,
              taxScheme: order.taxReportingScheme,
              isAmazonInvoiced: order.isAmazonInvoiced
            });
          }
        } catch (err) {
          results.errors.push({
            orderId: order.orderId,
            error: err.message
          });
        }
      }

      process.stdout.write(`\rProcessed ${Math.min(i + batchSize, orders.length)}/${orders.length} orders...`);
    }

    console.log('\n\n=== ANALYSIS RESULTS ===\n');
    console.log(`Total orders analyzed: ${orders.length}`);
    console.log(`Correct invoices: ${results.correct.length}`);
    console.log(`Amazon-invoiced with wrong VAT: ${results.amazonInvoicedWithVat.length}`);
    console.log(`Odoo total higher than VCS: ${results.odooHigher.length}`);
    console.log(`Odoo total lower than VCS: ${results.odooLower.length}`);
    console.log(`Invoice not found: ${results.invoiceNotFound.length}`);
    console.log(`Errors: ${results.errors.length}`);

    // Sample Amazon-invoiced issues
    if (results.amazonInvoicedWithVat.length > 0) {
      console.log('\n=== AMAZON-INVOICED WITH WRONG VAT (sample 5) ===');
      results.amazonInvoicedWithVat.slice(0, 5).forEach(r => {
        console.log(`\n${r.orderId} (${r.invoiceName}):`);
        console.log(`  Odoo: ${r.odooTotal.toFixed(2)} (tax: ${r.odooTax.toFixed(2)})`);
        console.log(`  VCS:  ${r.vcsTotal.toFixed(2)} (tax: ${r.vcsTax.toFixed(2)})`);
        console.log(`  Ship: ${r.shipFrom} -> ${r.shipTo}, scheme: ${r.taxScheme}`);
      });
    }

    // Sample Odoo Higher issues
    if (results.odooHigher.length > 0) {
      console.log('\n=== ODOO HIGHER THAN VCS (sample 5) ===');
      results.odooHigher.slice(0, 5).forEach(r => {
        console.log(`\n${r.orderId} (${r.invoiceName}):`);
        console.log(`  Odoo: ${r.odooTotal.toFixed(2)} (tax: ${r.odooTax.toFixed(2)})`);
        console.log(`  VCS:  ${r.vcsTotal.toFixed(2)} (tax: ${r.vcsTax.toFixed(2)})`);
        console.log(`  Diff: +${r.diff.toFixed(2)}`);
        console.log(`  Ship: ${r.shipFrom} -> ${r.shipTo}, scheme: ${r.taxScheme}, amazonInvoiced: ${r.isAmazonInvoiced}`);
      });
    }

    // Sample Odoo Lower issues
    if (results.odooLower.length > 0) {
      console.log('\n=== ODOO LOWER THAN VCS (sample 5) ===');
      results.odooLower.slice(0, 5).forEach(r => {
        console.log(`\n${r.orderId} (${r.invoiceName}):`);
        console.log(`  Odoo: ${r.odooTotal.toFixed(2)} (tax: ${r.odooTax.toFixed(2)})`);
        console.log(`  VCS:  ${r.vcsTotal.toFixed(2)} (tax: ${r.vcsTax.toFixed(2)})`);
        console.log(`  Diff: -${r.diff.toFixed(2)}`);
        console.log(`  Ship: ${r.shipFrom} -> ${r.shipTo}, scheme: ${r.taxScheme}, amazonInvoiced: ${r.isAmazonInvoiced}`);
      });
    }

    // Analyze patterns in Odoo Higher
    if (results.odooHigher.length > 0) {
      console.log('\n=== PATTERN ANALYSIS: ODOO HIGHER ===');
      const byScheme = {};
      const byRoute = {};
      results.odooHigher.forEach(r => {
        const scheme = r.taxScheme || 'unknown';
        const route = `${r.shipFrom}->${r.shipTo}`;
        byScheme[scheme] = (byScheme[scheme] || 0) + 1;
        byRoute[route] = (byRoute[route] || 0) + 1;
      });
      console.log('By tax scheme:', byScheme);
      console.log('Top routes:', Object.entries(byRoute).sort((a,b) => b[1] - a[1]).slice(0, 10));
    }

    // Analyze patterns in Odoo Lower
    if (results.odooLower.length > 0) {
      console.log('\n=== PATTERN ANALYSIS: ODOO LOWER ===');
      const byScheme = {};
      const byRoute = {};
      results.odooLower.forEach(r => {
        const scheme = r.taxScheme || 'unknown';
        const route = `${r.shipFrom}->${r.shipTo}`;
        byScheme[scheme] = (byScheme[scheme] || 0) + 1;
        byRoute[route] = (byRoute[route] || 0) + 1;
      });
      console.log('By tax scheme:', byScheme);
      console.log('Top routes:', Object.entries(byRoute).sort((a,b) => b[1] - a[1]).slice(0, 10));
    }

    // Save full results to file
    const fs = require('fs');
    const resultsFile = '/tmp/vcs-mismatch-analysis.json';
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log(`\nFull results saved to: ${resultsFile}`);

  } finally {
    await mongo.close();
  }
}

main().catch(console.error);
