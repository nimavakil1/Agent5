#!/usr/bin/env node
/**
 * Create invoices for ALL pending Italian B2C exception orders
 * Skips B2B orders (they need manual handling)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { connectDb, getDb } = require('../src/db');

// EU countries
const EU_COUNTRIES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];

// Country names for fiscal position lookup
const COUNTRY_NAMES = {
  'AT': 'Austria', 'BE': 'Belgium', 'BG': 'Bulgaria', 'HR': 'Croatia',
  'CY': 'Cyprus', 'CZ': 'Czech Republic', 'DK': 'Denmark', 'EE': 'Estonia',
  'FI': 'Finland', 'FR': 'France', 'DE': 'Germany', 'GR': 'Greece',
  'HU': 'Hungary', 'IE': 'Ireland', 'IT': 'Italy', 'LV': 'Latvia',
  'LT': 'Lithuania', 'LU': 'Luxembourg', 'MT': 'Malta', 'NL': 'Netherlands',
  'PL': 'Poland', 'PT': 'Portugal', 'RO': 'Romania', 'SK': 'Slovakia',
  'SI': 'Slovenia', 'ES': 'Spain', 'SE': 'Sweden'
};

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const batchSize = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] || '50');
  const startFrom = parseInt(args.find(a => a.startsWith('--start='))?.split('=')[1] || '0');

  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Start from: ${startFrom}`);
  console.log('');

  await connectDb();
  const db = getDb();
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo and MongoDB\n');

  // Load fiscal positions
  const fiscalPositions = await odoo.searchRead('account.fiscal.position', [], ['id', 'name']);
  const fpMap = {};
  for (const fp of fiscalPositions) {
    fpMap[fp.name] = fp.id;
  }
  console.log(`Loaded ${Object.keys(fpMap).length} fiscal positions\n`);

  // Find all pending Italian B2C exception orders
  const allOrders = await db.collection('amazon_vcs_orders').aggregate([
    {
      $match: {
        shipFromCountry: 'IT',
        isAmazonInvoiced: false,
        status: 'pending',
        $or: [
          { vatInvoiceNumber: 'N/A' },
          { vatInvoiceNumber: { $exists: false } },
          { vatInvoiceNumber: null }
        ]
      }
    },
    { $sort: { _id: -1 } },
    { $group: { _id: '$orderId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]).toArray();

  // Filter to B2C only (skip B2B)
  const b2cOrders = allOrders.filter(o => {
    const isB2B = !!(o.buyerTaxRegistration && o.buyerTaxRegistration.trim());
    return !isB2B;
  });

  console.log(`Found ${b2cOrders.length} B2C orders to process\n`);

  // Apply start offset
  const ordersToProcess = b2cOrders.slice(startFrom, startFrom + batchSize);
  console.log(`Processing orders ${startFrom} to ${startFrom + ordersToProcess.length - 1}\n`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < ordersToProcess.length; i++) {
    const order = ordersToProcess[i];
    const globalIdx = startFrom + i;
    const isDomestic = order.shipToCountry === 'IT';
    const isExport = !EU_COUNTRIES.includes(order.shipToCountry);

    // Determine fiscal position
    let targetFpName, scenario;
    if (isExport) {
      scenario = `Export IT->${order.shipToCountry}`;
      targetFpName = 'EX*VAT | Régime Export';
    } else if (isDomestic) {
      scenario = `B2C domestic IT->IT`;
      targetFpName = 'IT*OSS | B2C Italy';
    } else {
      scenario = `B2C cross-border IT->${order.shipToCountry}`;
      const countryName = COUNTRY_NAMES[order.shipToCountry] || order.shipToCountry;
      targetFpName = `${order.shipToCountry}*OSS | B2C ${countryName}`;
    }

    const targetFpId = fpMap[targetFpName];

    console.log(`[${globalIdx}/${b2cOrders.length}] ${order.orderId}`);
    console.log(`  ${scenario} | FP: ${targetFpName} (${targetFpId || 'NOT FOUND'})`);

    if (!targetFpId) {
      console.log(`  SKIP: Fiscal position not found\n`);
      skipped++;
      continue;
    }

    // Find Odoo sale order
    const saleOrders = await odoo.searchRead('sale.order',
      [['client_order_ref', '=', order.orderId]],
      ['id', 'name', 'state', 'invoice_ids', 'fiscal_position_id', 'partner_id', 'partner_invoice_id', 'currency_id']
    );

    if (saleOrders.length === 0) {
      console.log(`  SKIP: No Odoo sale order found\n`);
      skipped++;
      continue;
    }

    const so = saleOrders[0];

    if (dryRun) {
      console.log(`  [DRY RUN] Would create invoice\n`);
      continue;
    }

    try {
      // Update sale order fiscal position
      if (!so.fiscal_position_id || so.fiscal_position_id[0] !== targetFpId) {
        await odoo.write('sale.order', [so.id], { fiscal_position_id: targetFpId });
      }

      // Get sale order lines
      const soLines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', so.id]],
        ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'tax_id', 'discount']
      );

      if (soLines.length === 0) {
        console.log(`  SKIP: No order lines\n`);
        skipped++;
        continue;
      }

      // Build invoice lines with tax mapping
      const invoiceLines = [];
      for (const line of soLines) {
        let taxIds = line.tax_id || [];

        // Map tax through fiscal position
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

      // Create invoice
      const invoiceId = await odoo.create('account.move', {
        move_type: 'out_invoice',
        partner_id: so.partner_invoice_id ? so.partner_invoice_id[0] : so.partner_id[0],
        currency_id: so.currency_id ? so.currency_id[0] : false,
        fiscal_position_id: targetFpId,
        invoice_origin: so.name,
        invoice_line_ids: invoiceLines
      });

      // Get invoice name
      const newInvoice = await odoo.searchRead('account.move',
        [['id', '=', invoiceId]],
        ['name', 'amount_total']
      );

      console.log(`  Created: ${newInvoice[0].name} (€${newInvoice[0].amount_total})`);

      // Post the invoice
      await odoo.execute('account.move', 'action_post', [[invoiceId]]);

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
      console.log('');
    } catch (err) {
      console.log(`  ERROR: ${err.message}\n`);
      failed++;
    }
  }

  console.log('\n=== BATCH SUMMARY ===');
  console.log(`Created: ${created}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total in batch: ${ordersToProcess.length}`);

  if (startFrom + batchSize < b2cOrders.length) {
    console.log(`\nNext batch: --start=${startFrom + batchSize}`);
  } else {
    console.log('\nAll orders processed!');
  }

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
