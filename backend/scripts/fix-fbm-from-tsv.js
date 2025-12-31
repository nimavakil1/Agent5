#!/usr/bin/env node
/**
 * Fix FBM deliveries by reading customer data from Amazon TSV export
 * and updating Odoo deliveries with correct customer addresses
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// TSV files to process
const TSV_DIR = '/Users/nimavakil/Downloads';

async function fixFbmDeliveries() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('=== Fix FBM Deliveries from TSV ===\n');

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
    };

    for (let i = 1; i < lines.length; i++) {
      const fields = lines[i].split('\t');
      if (fields.length < 10) continue;

      const orderId = fields[cols.orderId];
      if (!orderId) continue;

      orderData[orderId] = {
        recipientName: fields[cols.recipientName] || '',
        street: fields[cols.shipAddress1] || '',
        street2: [fields[cols.shipAddress2], fields[cols.shipAddress3]].filter(Boolean).join(' ') || '',
        city: fields[cols.shipCity] || '',
        state: fields[cols.shipState] || '',
        zip: fields[cols.shipPostalCode] || '',
        countryCode: fields[cols.shipCountry] || '',
        phone: fields[cols.shipPhone] || '',
      };
    }
  }

  console.log(`Loaded ${Object.keys(orderData).length} orders from TSV\n`);

  // Step 2: Get all active FBM deliveries from Odoo
  const pickings = await odoo.searchRead('stock.picking',
    [
      ['name', 'like', 'CW/OUT/%'],
      ['state', 'in', ['assigned', 'confirmed', 'waiting']]
    ],
    ['id', 'name', 'origin', 'partner_id'],
    500
  );

  console.log(`Found ${pickings.length} active CW/OUT deliveries\n`);

  // Get country map
  const countries = await odoo.searchRead('res.country', [], ['id', 'code']);
  const countryMap = {};
  countries.forEach(c => countryMap[c.code] = c.id);

  let checked = 0;
  let fixed = 0;
  let created = 0;
  let errors = 0;

  for (const picking of pickings) {
    if (!picking.origin) continue;

    // Get the sale order to find the Amazon order ID
    const saleOrders = await odoo.searchRead('sale.order',
      [['name', '=', picking.origin]],
      ['id', 'name', 'client_order_ref', 'partner_shipping_id']
    );

    if (saleOrders.length === 0) continue;

    const so = saleOrders[0];
    let amazonOrderId = so.client_order_ref;

    // Remove FBM prefix if present
    if (amazonOrderId && amazonOrderId.startsWith('FBM')) {
      amazonOrderId = amazonOrderId.substring(3);
    }

    if (!amazonOrderId || !orderData[amazonOrderId]) continue;

    checked++;
    const tsv = orderData[amazonOrderId];
    const currentPartnerName = picking.partner_id ? picking.partner_id[1] : '';
    const currentPartnerId = picking.partner_id ? picking.partner_id[0] : null;

    // Check if names match (case-insensitive, trimmed)
    const tsvNameClean = tsv.recipientName.trim().toLowerCase();
    const currentNameClean = currentPartnerName.trim().toLowerCase();

    if (tsvNameClean === currentNameClean) {
      // Names match, skip
      continue;
    }

    console.log(`\n${picking.name} | ${so.name} | ${amazonOrderId}`);
    console.log(`  Odoo has: "${currentPartnerName}"`);
    console.log(`  TSV has:  "${tsv.recipientName}"`);

    // Find or create the correct partner
    const countryId = countryMap[tsv.countryCode] || null;

    // Search for existing partner with same name and zip
    let partners = await odoo.searchRead('res.partner',
      [
        ['name', '=ilike', tsv.recipientName],
        ['zip', '=', tsv.zip]
      ],
      ['id', 'name']
    );

    let correctPartnerId;

    if (partners.length > 0) {
      correctPartnerId = partners[0].id;
      console.log(`  Found existing partner: ${partners[0].name} (ID: ${correctPartnerId})`);
    } else {
      // Create new partner
      try {
        correctPartnerId = await odoo.create('res.partner', {
          name: tsv.recipientName,
          street: tsv.street,
          street2: tsv.street2 || false,
          city: tsv.city,
          zip: tsv.zip,
          country_id: countryId,
          phone: tsv.phone || false,
          customer_rank: 1,
          company_type: 'person',
          is_company: false,
        });
        console.log(`  Created new partner ID: ${correctPartnerId}`);
        created++;
      } catch (err) {
        console.log(`  [ERR] Failed to create partner: ${err.message}`);
        errors++;
        continue;
      }
    }

    // Update the delivery
    try {
      await odoo.write('stock.picking', [picking.id], {
        partner_id: correctPartnerId
      });
      console.log(`  [OK] Updated delivery partner`);
      fixed++;

      // Also update the sale order's shipping partner
      await odoo.write('sale.order', [so.id], {
        partner_shipping_id: correctPartnerId
      });
      console.log(`  [OK] Updated sale order shipping partner`);
    } catch (err) {
      console.log(`  [ERR] ${err.message}`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Checked: ${checked}`);
  console.log(`Fixed: ${fixed}`);
  console.log(`New partners created: ${created}`);
  console.log(`Errors: ${errors}`);

  process.exit(0);
}

fixFbmDeliveries().catch(e => { console.error(e); process.exit(1); });
