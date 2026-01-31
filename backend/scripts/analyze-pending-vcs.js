#!/usr/bin/env node
/**
 * Analyze pending VCS orders - statistics for invoicing
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const EU_COUNTRIES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];

async function main() {
  await connectDb();
  const db = getDb();
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get all pending VCS orders (not just Italian)
  const pendingOrders = await db.collection('amazon_vcs_orders').aggregate([
    { $match: { status: 'pending' } },
    { $sort: { _id: -1 } },
    { $group: { _id: '$orderId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]).toArray();

  console.log('TOTAL PENDING VCS ORDERS: ' + pendingOrders.length);
  console.log('');

  // Get order IDs to check which have Odoo sale orders
  const orderIds = pendingOrders.map(o => o.orderId);

  // Batch check Odoo orders (in chunks of 500)
  const odooOrderIds = new Set();
  for (let i = 0; i < orderIds.length; i += 500) {
    const batch = orderIds.slice(i, i + 500);
    const odooOrders = await odoo.searchRead('sale.order',
      [['client_order_ref', 'in', batch]],
      ['client_order_ref']
    );
    odooOrders.forEach(o => odooOrderIds.add(o.client_order_ref));
  }

  // Categorize orders
  let stats = {
    byShipFrom: {},
    byShipTo: {},
    byScenario: {},
    byFiscalPosition: {},
    withOdooOrder: 0,
    withoutOdooOrder: 0,
    totalValue: 0,
    isAmazonInvoiced: { true: 0, false: 0 }
  };

  for (const o of pendingOrders) {
    const hasOdoo = odooOrderIds.has(o.orderId);
    if (hasOdoo) stats.withOdooOrder++;
    else stats.withoutOdooOrder++;

    // Ship from/to country
    const from = o.shipFromCountry || 'Unknown';
    const to = o.shipToCountry || 'Unknown';
    stats.byShipFrom[from] = (stats.byShipFrom[from] || 0) + 1;
    stats.byShipTo[to] = (stats.byShipTo[to] || 0) + 1;

    // Amazon invoiced status
    if (o.isAmazonInvoiced) stats.isAmazonInvoiced.true++;
    else stats.isAmazonInvoiced.false++;

    // Determine scenario and expected fiscal position
    const isB2B = !!(o.buyerTaxRegistration && o.buyerTaxRegistration.trim());
    const isDomestic = o.shipFromCountry === o.shipToCountry;
    const isExport = !EU_COUNTRIES.includes(o.shipToCountry);
    const isItalianException = o.shipFromCountry === 'IT' && o.isAmazonInvoiced === false;

    let scenario, fpName;
    if (isExport) {
      scenario = `Export ${from}->${to}`;
      fpName = 'Export (0%)';
    } else if (isItalianException) {
      if (isB2B && !isDomestic) {
        scenario = 'IT B2B cross-border';
        fpName = 'Intra-Community (0%)';
      } else if (isB2B && isDomestic) {
        scenario = 'IT B2B domestic (problem)';
        fpName = 'IT*OSS (22%) - needs review';
      } else if (isDomestic) {
        scenario = 'IT B2C domestic';
        fpName = 'IT*OSS (22%)';
      } else {
        scenario = `IT B2C -> ${to}`;
        fpName = `${to}*OSS`;
      }
    } else if (from === 'NL' || from === 'BE') {
      // Normal flow - use VCS tax data
      if (isB2B && !isDomestic) {
        scenario = `${from} B2B cross-border`;
        fpName = 'Intra-Community (0%)';
      } else if (isDomestic) {
        scenario = `${from} domestic`;
        fpName = `${from}*VAT`;
      } else {
        scenario = `${from} B2C -> ${to}`;
        fpName = `${to}*OSS`;
      }
    } else {
      scenario = `${from} -> ${to}`;
      fpName = 'Other';
    }

    stats.byScenario[scenario] = (stats.byScenario[scenario] || 0) + 1;
    stats.byFiscalPosition[fpName] = (stats.byFiscalPosition[fpName] || 0) + 1;
    stats.totalValue += o.totalExclusive || 0;
  }

  console.log('BY SHIP FROM COUNTRY:');
  Object.entries(stats.byShipFrom).sort((a,b) => b[1] - a[1]).forEach(([k,v]) => {
    console.log(`  ${k}: ${v}`);
  });

  console.log('');
  console.log('BY SHIP TO COUNTRY (top 15):');
  Object.entries(stats.byShipTo).sort((a,b) => b[1] - a[1]).slice(0, 15).forEach(([k,v]) => {
    console.log(`  ${k}: ${v}`);
  });

  console.log('');
  console.log('BY SCENARIO:');
  Object.entries(stats.byScenario).sort((a,b) => b[1] - a[1]).forEach(([k,v]) => {
    console.log(`  ${k}: ${v}`);
  });

  console.log('');
  console.log('BY EXPECTED FISCAL POSITION:');
  Object.entries(stats.byFiscalPosition).sort((a,b) => b[1] - a[1]).forEach(([k,v]) => {
    console.log(`  ${k}: ${v}`);
  });

  console.log('');
  console.log('AMAZON INVOICED STATUS:');
  console.log(`  Amazon invoiced (isAmazonInvoiced=true): ${stats.isAmazonInvoiced.true}`);
  console.log(`  NOT Amazon invoiced (isAmazonInvoiced=false): ${stats.isAmazonInvoiced.false}`);

  console.log('');
  console.log('ODOO SALE ORDER STATUS:');
  console.log(`  With Odoo sale order (can invoice now): ${stats.withOdooOrder}`);
  console.log(`  Without Odoo sale order (need sync): ${stats.withoutOdooOrder}`);

  console.log('');
  console.log(`TOTAL VALUE (excl VAT): EUR ${stats.totalValue.toFixed(2)}`);

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
