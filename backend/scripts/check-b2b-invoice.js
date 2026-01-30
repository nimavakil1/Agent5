#!/usr/bin/env node
/**
 * Check fiscal position on Amazon B2B invoices
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

  try {
    // Get a sample Amazon-invoiced B2B order that was invoiced
    const order = await db.collection('amazon_vcs_orders').findOne({
      totalTax: 0,
      isAmazonInvoiced: true,
      buyerTaxRegistration: { $exists: true, $ne: '' },
      odooInvoiceId: { $exists: true }
    });

    if (!order) {
      console.log('No invoiced Amazon B2B order found');
      return;
    }

    console.log('=== Amazon-invoiced B2B Order ===');
    console.log('orderId:', order.orderId);
    console.log('shipFrom:', order.shipFromCountry, '-> shipTo:', order.shipToCountry);
    console.log('buyerTaxRegistration:', order.buyerTaxRegistration);
    console.log('isAmazonInvoiced:', order.isAmazonInvoiced);

    // Check the Odoo invoice
    const invoice = await odoo.searchRead('account.move',
      [['id', '=', order.odooInvoiceId]],
      ['id', 'name', 'fiscal_position_id', 'amount_total', 'amount_tax']
    );

    if (invoice.length > 0) {
      console.log('\n=== Odoo Invoice ===');
      console.log('Invoice:', invoice[0].name);
      console.log('Fiscal Position:', invoice[0].fiscal_position_id ? invoice[0].fiscal_position_id[1] : 'None');
      console.log('Total:', invoice[0].amount_total);
      console.log('Tax:', invoice[0].amount_tax);

      // Get invoice lines to see what tax was applied
      const lines = await odoo.searchRead('account.move.line',
        [['move_id', '=', invoice[0].id], ['product_id', '!=', false]],
        ['id', 'name', 'tax_ids', 'price_total']
      );

      if (lines.length > 0) {
        console.log('\nInvoice lines:');
        for (const line of lines) {
          // Get tax details
          let taxNames = 'None';
          if (line.tax_ids && line.tax_ids.length > 0) {
            const taxes = await odoo.searchRead('account.tax', [['id', 'in', line.tax_ids]], ['name']);
            taxNames = taxes.map(t => t.name).join(', ');
          }
          console.log('  - Tax:', taxNames, '| Total:', line.price_total);
        }
      }
    }

    // Also check what fiscal positions exist for Intra-Community
    console.log('\n=== Available Intra-Community Fiscal Positions ===');
    const fps = await odoo.searchRead('account.fiscal.position',
      [['name', 'ilike', 'intra']],
      ['id', 'name']
    );
    fps.forEach(fp => console.log(`  ${fp.id}: ${fp.name}`));

    // Check for B2B fiscal positions
    console.log('\n=== Available B2B Fiscal Positions ===');
    const b2bFps = await odoo.searchRead('account.fiscal.position',
      [['name', 'ilike', 'b2b']],
      ['id', 'name']
    );
    b2bFps.forEach(fp => console.log(`  ${fp.id}: ${fp.name}`));

  } finally {
    await mongo.close();
  }
}

main().catch(console.error);
