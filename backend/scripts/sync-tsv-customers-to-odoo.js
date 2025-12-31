#!/usr/bin/env node
/**
 * Sync real customer data from TSV file to both MongoDB and Odoo
 *
 * This script:
 * 1. Parses a TSV file with FBM order data
 * 2. For each order, updates MongoDB with the real customer name and address
 * 3. Updates the Odoo partner (customer) record with the real name and address
 *
 * Usage:
 *   node scripts/sync-tsv-customers-to-odoo.js <tsv-file>
 *   node scripts/sync-tsv-customers-to-odoo.js <tsv-file> --dry-run
 */

require('dotenv').config();
const fs = require('fs');
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// TSV column mapping (based on Amazon seller fulfilled shipments report)
const COLUMN_MAP = {
  'order-id': 'orderId',
  'recipient-name': 'recipientName',
  'ship-address-1': 'addressLine1',
  'ship-address-2': 'addressLine2',
  'ship-address-3': 'addressLine3',
  'ship-city': 'city',
  'ship-state': 'state',
  'ship-postal-code': 'postalCode',
  'ship-country': 'countryCode',
  'ship-phone-number': 'phone',
  'buyer-name': 'buyerName'
};

function parseTsvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  if (lines.length < 2) {
    throw new Error('TSV file must have at least a header and one data row');
  }

  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const orders = new Map(); // Use Map to dedupe by order ID

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t');
    const row = {};

    headers.forEach((header, idx) => {
      const mappedKey = COLUMN_MAP[header];
      if (mappedKey) {
        row[mappedKey] = values[idx]?.trim() || null;
      }
    });

    if (row.orderId) {
      // Keep the first occurrence (or merge if needed)
      if (!orders.has(row.orderId)) {
        orders.set(row.orderId, row);
      }
    }
  }

  return Array.from(orders.values());
}

async function getCountryId(odoo, countryCode) {
  if (!countryCode) return null;

  const countries = await odoo.searchRead('res.country',
    [['code', '=', countryCode.toUpperCase()]],
    ['id']
  );

  return countries.length > 0 ? countries[0].id : null;
}

async function syncCustomers(tsvPath, isDryRun) {
  console.log('=== Sync TSV Customer Data to MongoDB and Odoo ===');
  console.log(isDryRun ? '(DRY RUN - no changes will be made)\n' : '\n');

  // Parse TSV file
  console.log(`Reading TSV file: ${tsvPath}`);
  const tsvOrders = parseTsvFile(tsvPath);
  console.log(`Found ${tsvOrders.length} unique orders in TSV\n`);

  // Connect to MongoDB
  await connectDb();
  const db = getDb();
  const collection = db.collection('seller_orders');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let notFound = 0;

  for (const tsvOrder of tsvOrders) {
    const orderId = tsvOrder.orderId;
    const customerName = tsvOrder.recipientName || tsvOrder.buyerName;

    if (!customerName) {
      console.log(`[SKIP] ${orderId} - No customer name in TSV`);
      skipped++;
      continue;
    }

    try {
      // Find order in MongoDB
      const mongoOrder = await collection.findOne({ amazonOrderId: orderId });

      if (!mongoOrder) {
        console.log(`[NOT FOUND] ${orderId} - Not in MongoDB`);
        notFound++;
        continue;
      }

      // Check if order has Odoo link
      const odooPartnerId = mongoOrder.odoo?.partnerId;
      const odooShippingPartnerId = mongoOrder.odoo?.shippingPartnerId;

      if (!odooPartnerId) {
        console.log(`[SKIP] ${orderId} - No Odoo partner linked`);
        skipped++;
        continue;
      }

      // Get country ID for Odoo
      const countryId = await getCountryId(odoo, tsvOrder.countryCode);

      // Build address string
      const addressParts = [
        tsvOrder.addressLine1,
        tsvOrder.addressLine2,
        tsvOrder.addressLine3
      ].filter(Boolean);
      const street = addressParts[0] || false;
      const street2 = addressParts.slice(1).join(', ') || false;

      if (isDryRun) {
        console.log(`[DRY] ${orderId}`);
        console.log(`       Name: "${customerName}"`);
        console.log(`       Addr: ${street}, ${tsvOrder.city} ${tsvOrder.postalCode}`);
        console.log(`       Odoo Partner ID: ${odooPartnerId}, Shipping: ${odooShippingPartnerId}`);
        updated++;
      } else {
        // Update MongoDB
        await collection.updateOne(
          { amazonOrderId: orderId },
          {
            $set: {
              buyerName: customerName,
              'shippingAddress.name': customerName,
              'shippingAddress.addressLine1': tsvOrder.addressLine1,
              'shippingAddress.addressLine2': tsvOrder.addressLine2,
              'shippingAddress.city': tsvOrder.city,
              'shippingAddress.stateOrRegion': tsvOrder.state,
              'shippingAddress.postalCode': tsvOrder.postalCode,
              'shippingAddress.countryCode': tsvOrder.countryCode,
              'shippingAddress.phone': tsvOrder.phone,
              updatedAt: new Date()
            }
          }
        );

        // Update Odoo main partner
        const partnerUpdate = {
          name: customerName,
          street: street,
          street2: street2,
          city: tsvOrder.city || false,
          zip: tsvOrder.postalCode || false,
          country_id: countryId
        };

        if (tsvOrder.phone) {
          partnerUpdate.phone = tsvOrder.phone;
        }

        await odoo.write('res.partner', [odooPartnerId], partnerUpdate);

        // Update Odoo shipping partner if different
        if (odooShippingPartnerId && odooShippingPartnerId !== odooPartnerId) {
          await odoo.write('res.partner', [odooShippingPartnerId], partnerUpdate);
        }

        console.log(`[OK] ${orderId} -> "${customerName}" (${tsvOrder.city}, ${tsvOrder.countryCode})`);
        updated++;
      }

    } catch (error) {
      console.log(`[ERR] ${orderId} - ${error.message}`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Updated:   ${updated}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Not Found: ${notFound}`);
  console.log(`Errors:    ${errors}`);
  console.log(`Total:     ${tsvOrders.length}`);

  if (isDryRun) {
    console.log('\n(This was a dry run - run without --dry-run to apply changes)');
  }

  process.exit(0);
}

// Main
const args = process.argv.slice(2);
const tsvPath = args.find(a => !a.startsWith('--'));
const isDryRun = args.includes('--dry-run');

if (!tsvPath) {
  console.error('Usage: node scripts/sync-tsv-customers-to-odoo.js <tsv-file> [--dry-run]');
  process.exit(1);
}

if (!fs.existsSync(tsvPath)) {
  console.error(`File not found: ${tsvPath}`);
  process.exit(1);
}

syncCustomers(tsvPath, isDryRun).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
