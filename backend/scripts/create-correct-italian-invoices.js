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
      targetFpName = 'IT*OSS | B2C Italie'; // Best effort
    } else if (isDomestic) {
      scenario = `B2C domestic IT->IT`;
      targetFpName = 'IT*OSS | B2C Italie';
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
      // Update sale order fiscal position
      if (targetFpId && (!so.fiscal_position_id || so.fiscal_position_id[0] !== targetFpId)) {
        console.log(`  Updating SO fiscal position...`);
        await odoo.write('sale.order', [so.id], { fiscal_position_id: targetFpId });
      }

      // Create invoice using Odoo's standard method
      console.log(`  Creating invoice...`);

      // Use the sale order's create invoice action
      const wizardId = await odoo.create('sale.advance.payment.inv', {
        advance_payment_method: 'delivered'
      });

      // Execute the wizard in context of this sale order
      const result = await odoo.execute('sale.advance.payment.inv', 'create_invoices', [[wizardId]], {
        active_ids: [so.id],
        active_model: 'sale.order'
      });

      // Get the newly created invoice
      const updatedSo = await odoo.searchRead('sale.order',
        [['id', '=', so.id]],
        ['invoice_ids']
      );

      const newInvoiceIds = updatedSo[0].invoice_ids.filter(id => !so.invoice_ids?.includes(id));

      if (newInvoiceIds.length > 0) {
        const newInvoice = await odoo.searchRead('account.move',
          [['id', 'in', newInvoiceIds]],
          ['id', 'name', 'state', 'fiscal_position_id']
        );

        if (newInvoice.length > 0) {
          console.log(`  Created invoice: ${newInvoice[0].name}`);

          // Update invoice fiscal position if needed
          if (targetFpId) {
            await odoo.write('account.move', [newInvoice[0].id], { fiscal_position_id: targetFpId });
          }

          // Post the invoice
          if (newInvoice[0].state === 'draft') {
            console.log(`  Posting invoice...`);
            await odoo.execute('account.move', 'action_post', [[newInvoice[0].id]]);
          }

          // Update MongoDB
          await db.collection('amazon_vcs_orders').updateOne(
            { _id: order._id },
            {
              $set: {
                odooInvoiceId: newInvoice[0].id,
                odooInvoiceName: newInvoice[0].name,
                invoicedAt: new Date(),
                status: 'invoiced'
              }
            }
          );

          created++;
        }
      } else {
        console.log(`  No new invoice created (wizard may have failed)`);
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
  const names = {
    'AT': 'Autriche', 'BE': 'Belgique', 'BG': 'Bulgarie', 'HR': 'Croatie',
    'CY': 'Chypre', 'CZ': 'Tchéquie', 'DK': 'Danemark', 'EE': 'Estonie',
    'FI': 'Finlande', 'FR': 'France', 'DE': 'Allemagne', 'GR': 'Grèce',
    'HU': 'Hongrie', 'IE': 'Irlande', 'IT': 'Italie', 'LV': 'Lettonie',
    'LT': 'Lituanie', 'LU': 'Luxembourg', 'MT': 'Malte', 'NL': 'Pays-Bas',
    'PL': 'Pologne', 'PT': 'Portugal', 'RO': 'Roumanie', 'SK': 'Slovaquie',
    'SI': 'Slovénie', 'ES': 'Espagne', 'SE': 'Suède'
  };
  return names[code] || code;
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
