#!/usr/bin/env node
/**
 * Find Italian exception orders without invoices
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const db = mongo.db(process.env.MONGO_DB_NAME || 'agent5');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const italianOrders = await db.collection('amazon_vcs_orders').find({
    shipFromCountry: 'IT',
    isAmazonInvoiced: false,
    status: 'pending'
  }).limit(50).toArray();

  console.log('Found ' + italianOrders.length + ' pending Italian orders\n');

  let noInvoiceOrders = [];
  for (const order of italianOrders) {
    const odooOrders = await odoo.searchRead('sale.order',
      [['x_amazon_order_id', '=', order.orderId]],
      ['id', 'name', 'invoice_ids']
    );

    const hasInvoice = odooOrders.length > 0 && odooOrders[0].invoice_ids && odooOrders[0].invoice_ids.length > 0;

    if (!hasInvoice) {
      const isB2B = !!(order.buyerTaxRegistration && order.buyerTaxRegistration.trim());
      const isDomestic = order.shipToCountry === 'IT';
      let scenario = '';
      if (isDomestic && isB2B) scenario = 'B2B domestic IT->IT';
      else if (isDomestic) scenario = 'B2C domestic IT->IT';
      else if (isB2B) scenario = 'B2B cross-border IT->' + order.shipToCountry;
      else scenario = 'B2C cross-border IT->' + order.shipToCountry;

      noInvoiceOrders.push({
        orderId: order.orderId,
        mongoId: order._id.toString(),
        scenario: scenario,
        totalExcl: order.totalExclusive,
        hasOdooOrder: odooOrders.length > 0
      });
    }
  }

  console.log('Orders without invoices: ' + noInvoiceOrders.length + '\n');
  noInvoiceOrders.forEach(o => {
    console.log(o.scenario);
    console.log('  orderId: ' + o.orderId);
    console.log('  mongoId: ' + o.mongoId);
    console.log('  totalExcl: ' + o.totalExcl);
    console.log('  hasOdooOrder: ' + o.hasOdooOrder);
    console.log('');
  });

  await mongo.close();
}
main().catch(console.error);
