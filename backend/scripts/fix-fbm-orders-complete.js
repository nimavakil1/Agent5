#!/usr/bin/env node
/**
 * Fix FBM orders COMPLETELY - customer, invoice address, shipping address, and delivery
 * Read customer data from Amazon TSV exports and update all related Odoo records
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const TSV_DIR = '/Users/nimavakil/Downloads';

async function fixFbmOrdersComplete() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fix FBM Orders COMPLETELY ===\n');

  // Step 1: Load all Amazon order data from TSV files
  const orderData = {};
  const tsvFiles = fs.readdirSync(TSV_DIR)
    .filter(f => f.match(/^\d+\.txt$/))
    .map(f => path.join(TSV_DIR, f));

  console.log(`Found ${tsvFiles.length} Amazon TSV files\n`);

  for (const file of tsvFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const headers = lines[0].split('\t');

    // Find column indices
    const cols = {
      orderId: headers.indexOf('order-id'),
      recipientName: headers.indexOf('recipient-name'),
      shipAddress1: headers.indexOf('ship-address-1'),
      shipAddress2: headers.indexOf('ship-address-2'),
      shipAddress3: headers.indexOf('ship-address-3'),
      shipCity: headers.indexOf('ship-city'),
      shipState: headers.indexOf('ship-state'),
      shipPostalCode: headers.indexOf('ship-postal-code'),
      shipCountry: headers.indexOf('ship-country'),
      shipPhone: headers.indexOf('ship-phone-number'),
      // Invoice/billing address
      billName: headers.indexOf('bill-name'),
      billAddress1: headers.indexOf('bill-address-1'),
      billAddress2: headers.indexOf('bill-address-2'),
      billAddress3: headers.indexOf('bill-address-3'),
      billCity: headers.indexOf('bill-city'),
      billState: headers.indexOf('bill-state'),
      billPostalCode: headers.indexOf('bill-postal-code'),
      billCountry: headers.indexOf('bill-country'),
    };

    for (let i = 1; i < lines.length; i++) {
      const fields = lines[i].split('\t');
      if (fields.length < 10) continue;

      const orderId = fields[cols.orderId];
      if (!orderId) continue;

      orderData[orderId] = {
        // Shipping address
        recipientName: fields[cols.recipientName] || '',
        shipStreet: fields[cols.shipAddress1] || '',
        shipStreet2: [fields[cols.shipAddress2], fields[cols.shipAddress3]].filter(Boolean).join(' ') || '',
        shipCity: fields[cols.shipCity] || '',
        shipState: fields[cols.shipState] || '',
        shipZip: fields[cols.shipPostalCode] || '',
        shipCountry: fields[cols.shipCountry] || '',
        shipPhone: fields[cols.shipPhone] || '',
        // Billing/invoice address
        billName: fields[cols.billName] || '',
        billStreet: fields[cols.billAddress1] || '',
        billStreet2: [fields[cols.billAddress2], fields[cols.billAddress3]].filter(Boolean).join(' ') || '',
        billCity: fields[cols.billCity] || '',
        billState: fields[cols.billState] || '',
        billZip: fields[cols.billPostalCode] || '',
        billCountry: fields[cols.billCountry] || '',
      };
    }
  }

  console.log(`Loaded ${Object.keys(orderData).length} orders from TSV\n`);

  // Get country map
  const countries = await odoo.searchRead('res.country', [], ['id', 'code']);
  const countryMap = {};
  countries.forEach(c => countryMap[c.code] = c.id);

  // Step 2: Get all FBM sale orders
  const saleOrders = await odoo.searchRead('sale.order',
    [['name', 'like', 'FBM%']],
    ['id', 'name', 'client_order_ref', 'partner_id', 'partner_invoice_id', 'partner_shipping_id', 'picking_ids'],
    500
  );

  console.log(`Found ${saleOrders.length} FBM sale orders\n`);

  let checked = 0;
  let fixedOrders = 0;
  let fixedDeliveries = 0;
  let newPartners = 0;
  let errors = 0;

  for (const so of saleOrders) {
    let amazonOrderId = so.client_order_ref;
    if (!amazonOrderId) continue;

    // Remove FBM prefix if present
    if (amazonOrderId.startsWith('FBM')) {
      amazonOrderId = amazonOrderId.substring(3);
    }

    if (!orderData[amazonOrderId]) continue;

    checked++;
    const tsv = orderData[amazonOrderId];

    // Check if shipping name matches
    const currentShippingName = so.partner_shipping_id ? so.partner_shipping_id[1] : '';
    const tsvShipName = tsv.recipientName.trim();

    // Normalize for comparison (ignore case, ignore comma duplicates)
    const normalizedCurrent = currentShippingName.toLowerCase().split(',')[0].trim();
    const normalizedTsv = tsvShipName.toLowerCase();

    const needsFix = normalizedCurrent !== normalizedTsv && tsvShipName !== '';

    if (!needsFix) continue;

    console.log(`\n${so.name} | ${amazonOrderId}`);
    console.log(`  Current shipping: "${currentShippingName}"`);
    console.log(`  TSV shipping: "${tsvShipName}"`);
    console.log(`  TSV billing: "${tsv.billName}"`);

    // Create or find shipping partner
    const shipCountryId = countryMap[tsv.shipCountry] || null;
    let shippingPartnerId = await findOrCreatePartner(odoo, {
      name: tsvShipName,
      street: tsv.shipStreet,
      street2: tsv.shipStreet2,
      city: tsv.shipCity,
      zip: tsv.shipZip,
      countryId: shipCountryId,
      phone: tsv.shipPhone,
    });

    if (!shippingPartnerId) {
      console.log('  [ERR] Failed to create shipping partner');
      errors++;
      continue;
    }

    // Create or find invoice partner (often same as shipping for B2C)
    let invoicePartnerId = shippingPartnerId;
    if (tsv.billName && tsv.billName !== tsvShipName) {
      const billCountryId = countryMap[tsv.billCountry] || shipCountryId;
      invoicePartnerId = await findOrCreatePartner(odoo, {
        name: tsv.billName,
        street: tsv.billStreet,
        street2: tsv.billStreet2,
        city: tsv.billCity,
        zip: tsv.billZip,
        countryId: billCountryId,
      });
    }

    // Update the sale order
    try {
      await odoo.write('sale.order', [so.id], {
        partner_id: shippingPartnerId,
        partner_invoice_id: invoicePartnerId,
        partner_shipping_id: shippingPartnerId,
      });
      console.log(`  [OK] Updated sale order`);
      fixedOrders++;

      // Update related deliveries
      if (so.picking_ids && so.picking_ids.length > 0) {
        for (const pickingId of so.picking_ids) {
          try {
            await odoo.write('stock.picking', [pickingId], {
              partner_id: shippingPartnerId
            });
            fixedDeliveries++;
          } catch (err) {
            // Ignore errors for individual pickings
          }
        }
        console.log(`  [OK] Updated ${so.picking_ids.length} deliveries`);
      }
    } catch (err) {
      console.log(`  [ERR] ${err.message}`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Checked: ${checked}`);
  console.log(`Fixed orders: ${fixedOrders}`);
  console.log(`Fixed deliveries: ${fixedDeliveries}`);
  console.log(`New partners created: ${newPartners}`);
  console.log(`Errors: ${errors}`);

  process.exit(0);

  async function findOrCreatePartner(odoo, data) {
    // Search for existing partner with same name and zip
    let partners = await odoo.searchRead('res.partner',
      [
        ['name', '=ilike', data.name],
        ['zip', '=', data.zip]
      ],
      ['id', 'name']
    );

    if (partners.length > 0) {
      return partners[0].id;
    }

    // Create new partner
    try {
      const partnerId = await odoo.create('res.partner', {
        name: data.name,
        street: data.street || false,
        street2: data.street2 || false,
        city: data.city || false,
        zip: data.zip || false,
        country_id: data.countryId || false,
        phone: data.phone || false,
        customer_rank: 1,
        company_type: 'person',
        is_company: false,
      });
      newPartners++;
      return partnerId;
    } catch (err) {
      console.log(`  [ERR] Creating partner: ${err.message}`);
      return null;
    }
  }
}

fixFbmOrdersComplete().catch(e => { console.error(e); process.exit(1); });
