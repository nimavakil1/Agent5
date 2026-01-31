#!/usr/bin/env node
/**
 * Create correct invoices for Italian exception orders
 * This bypasses VcsOdooInvoicer's "invoice exists" check
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { connectDb, getDb } = require('../src/db');

// EU countries for OSS/Intra-Community determination
const EU_COUNTRIES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];

// Standard VAT rates by country
const STANDARD_VAT_RATES = {
  'AT': 20, 'BE': 21, 'BG': 20, 'HR': 25, 'CY': 19, 'CZ': 21, 'DK': 25,
  'EE': 22, 'FI': 25.5, 'FR': 20, 'DE': 19, 'GR': 24, 'HU': 27, 'IE': 23,
  'IT': 22, 'LV': 21, 'LT': 21, 'LU': 17, 'MT': 18, 'NL': 21, 'PL': 23,
  'PT': 23, 'RO': 19, 'SK': 20, 'SI': 22, 'ES': 21, 'SE': 25
};

// The 25 orders we need to reinvoice (minus the one with 0 total)
const ORDER_IDS = [
  '303-0945049-8349959', '303-0744813-3521912', '302-1410869-6997100',
  '404-9404658-1934752', '408-4809305-5307507', '406-4527187-4218726',
  '408-5397132-6389917', '402-8333424-4113961', '407-9916439-4410725',
  '403-5857069-2592341', '408-7021541-9285163', '404-3747892-0180349',
  '402-6589307-2220339', '406-0479229-1475516', '407-8624660-3678767',
  '403-8665214-5233164', '406-6352119-3804349', '171-2898151-9135520',
  '402-1280032-6749143', '406-7925338-3719526', '403-4305852-0355510',
  '028-3719435-4837918', '402-6477616-1253901', '403-4074426-3695500'
  // Excluded: '403-1022052-1700340' - has 0 total, requires manual
];

async function main() {
  const dryRun = !process.argv.includes('--execute');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}\n`);

  await connectDb();
  const db = getDb();
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected\n');

  // Load fiscal positions
  const fiscalPositions = await odoo.searchRead('account.fiscal.position', [], ['id', 'name']);
  const fpMap = {};
  for (const fp of fiscalPositions) {
    fpMap[fp.name] = fp.id;
  }
  console.log('Loaded fiscal positions:', Object.keys(fpMap).length);

  // Get orders from MongoDB
  const orders = await db.collection('amazon_vcs_orders').aggregate([
    { $match: { orderId: { $in: ORDER_IDS } } },
    { $sort: { _id: -1 } },
    { $group: { _id: '$orderId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]).toArray();

  console.log(`Found ${orders.length} orders\n`);

  let created = 0;
  let failed = 0;

  for (const order of orders) {
    const isB2B = !!(order.buyerTaxRegistration && order.buyerTaxRegistration.trim());
    const isDomestic = order.shipToCountry === 'IT';
    const isExport = !EU_COUNTRIES.includes(order.shipToCountry);

    // Determine correct fiscal position
    let targetFpName = null;
    let scenario = '';

    if (isExport) {
      scenario = `Export IT->${order.shipToCountry}`;
      targetFpName = null; // No fiscal position for exports
    } else if (isB2B && !isDomestic) {
      scenario = `B2B cross-border IT->${order.shipToCountry}`;
      targetFpName = 'BE*VAT | Régime Intra-Communautaire';
    } else if (isB2B && isDomestic) {
      scenario = `B2B domestic IT->IT`;
      targetFpName = 'IT*OSS | B2C Italy'; // Best effort
    } else if (isDomestic) {
      scenario = `B2C domestic IT->IT`;
      targetFpName = 'IT*OSS | B2C Italy';
    } else {
      scenario = `B2C cross-border IT->${order.shipToCountry}`;
      // Find OSS fiscal position for destination country
      const countryName = getCountryName(order.shipToCountry);
      targetFpName = `${order.shipToCountry}*OSS | B2C ${countryName}`;
    }

    const targetFpId = targetFpName ? fpMap[targetFpName] : null;

    console.log(`\nOrder: ${order.orderId}`);
    console.log(`  Scenario: ${scenario}`);
    console.log(`  Target FP: ${targetFpName || 'None'} (ID: ${targetFpId || 'N/A'})`);

    if (targetFpName && !targetFpId) {
      console.log(`  ERROR: Fiscal position not found!`);
      failed++;
      continue;
    }

    // Find Odoo sale order
    const saleOrders = await odoo.searchRead('sale.order',
      [['client_order_ref', '=', order.orderId]],
      ['id', 'name', 'state', 'invoice_ids', 'order_line', 'fiscal_position_id']
    );

    if (saleOrders.length === 0) {
      console.log(`  ERROR: Odoo sale order not found!`);
      failed++;
      continue;
    }

    const so = saleOrders[0];
    console.log(`  Odoo SO: ${so.name} (state: ${so.state})`);
    console.log(`  Current FP: ${so.fiscal_position_id ? so.fiscal_position_id[1] : 'None'}`);
    console.log(`  Existing invoices: ${so.invoice_ids?.length || 0}`);

    if (dryRun) {
      console.log(`  [DRY RUN] Would update SO fiscal position and create invoice`);
      continue;
    }

    try {
      // Update sale order fiscal position first
      if (targetFpId && (!so.fiscal_position_id || so.fiscal_position_id[0] !== targetFpId)) {
        console.log(`  Updating SO fiscal position...`);
        await odoo.write('sale.order', [so.id], { fiscal_position_id: targetFpId });
      }

      // Get sale order lines
      const soLines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', so.id]],
        ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'tax_id', 'discount']
      );

      if (soLines.length === 0) {
        console.log(`  ERROR: No sale order lines found!`);
        failed++;
        continue;
      }

      // Get partner and other SO data
      const soFull = await odoo.searchRead('sale.order',
        [['id', '=', so.id]],
        ['partner_id', 'partner_invoice_id', 'currency_id', 'pricelist_id', 'date_order']
      );
      const soData = soFull[0];

      // Build invoice lines
      const invoiceLines = [];
      for (const line of soLines) {
        // Get the correct tax based on fiscal position
        let taxIds = line.tax_id || [];

        // Map tax through fiscal position if set
        if (targetFpId && taxIds.length > 0) {
          const mappedTax = await odoo.searchRead('account.fiscal.position.tax',
            [['position_id', '=', targetFpId], ['tax_src_id', 'in', taxIds]],
            ['tax_dest_id']
          );
          if (mappedTax.length > 0 && mappedTax[0].tax_dest_id) {
            taxIds = [mappedTax[0].tax_dest_id[0]];
          }
        }

        invoiceLines.push([0, 0, {
          product_id: line.product_id ? line.product_id[0] : false,
          name: line.name,
          quantity: line.product_uom_qty,
          price_unit: line.price_unit,
          tax_ids: [[6, 0, taxIds]],
          discount: line.discount || 0,
          sale_line_ids: [[6, 0, [line.id]]]
        }]);
      }

      // Create the invoice directly
      console.log(`  Creating invoice...`);
      const invoiceId = await odoo.create('account.move', {
        move_type: 'out_invoice',
        partner_id: soData.partner_invoice_id ? soData.partner_invoice_id[0] : soData.partner_id[0],
        currency_id: soData.currency_id ? soData.currency_id[0] : false,
        fiscal_position_id: targetFpId || false,
        invoice_origin: so.name,
        invoice_line_ids: invoiceLines
      });

      // Get invoice details
      const newInvoice = await odoo.searchRead('account.move',
        [['id', '=', invoiceId]],
        ['id', 'name', 'state', 'fiscal_position_id', 'amount_total']
      );

      if (newInvoice.length > 0) {
        console.log(`  Created invoice: ${newInvoice[0].name} (total: ${newInvoice[0].amount_total})`);

        // Post the invoice
        if (newInvoice[0].state === 'draft') {
          console.log(`  Posting invoice...`);
          await odoo.execute('account.move', 'action_post', [[invoiceId]]);
        }

        // Update MongoDB
        await db.collection('amazon_vcs_orders').updateOne(
          { _id: order._id },
          {
            $set: {
              odooInvoiceId: invoiceId,
              odooInvoiceName: newInvoice[0].name,
              invoicedAt: new Date(),
              status: 'invoiced'
            }
          }
        );

        created++;
      } else {
        console.log(`  ERROR: Invoice created but not found!`);
        failed++;
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Created: ${created}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${orders.length}`);

  process.exit(0);
}

function getCountryName(code) {
  // Use English names to match Odoo fiscal position naming
  const names = {
    'AT': 'Austria', 'BE': 'Belgium', 'BG': 'Bulgaria', 'HR': 'Croatia',
    'CY': 'Cyprus', 'CZ': 'Czech Republic', 'DK': 'Denmark', 'EE': 'Estonia',
    'FI': 'Finland', 'FR': 'France', 'DE': 'Germany', 'GR': 'Greece',
    'HU': 'Hungary', 'IE': 'Ireland', 'IT': 'Italy', 'LV': 'Latvia',
    'LT': 'Lithuania', 'LU': 'Luxembourg', 'MT': 'Malta', 'NL': 'Netherlands',
    'PL': 'Poland', 'PT': 'Portugal', 'RO': 'Romania', 'SK': 'Slovakia',
    'SI': 'Slovenia', 'ES': 'Spain', 'SE': 'Sweden'
  };
  return names[code] || code;
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
