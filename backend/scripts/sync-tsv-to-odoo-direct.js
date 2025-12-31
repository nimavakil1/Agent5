#!/usr/bin/env node
/**
 * Sync TSV customer data directly to Odoo (no MongoDB required)
 *
 * This script:
 * 1. Parses a TSV file with FBM order data
 * 2. Finds matching orders in Odoo by client_order_ref (Amazon order ID)
 * 3. Updates the partner (customer) records with clean addresses
 *
 * Usage:
 *   node scripts/sync-tsv-to-odoo-direct.js <tsv-file>
 *   node scripts/sync-tsv-to-odoo-direct.js <tsv-file> --dry-run
 */

require('dotenv').config();
const fs = require('fs');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { getAddressCleaner } = require('../src/services/amazon/seller/AddressCleaner');

// TSV column mapping
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
  const orders = new Map();

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
      if (!orders.has(row.orderId)) {
        orders.set(row.orderId, row);
      }
    }
  }

  return Array.from(orders.values());
}

async function getCountryId(odoo, countryCode, countryCache) {
  if (!countryCode) return null;
  const code = countryCode.toUpperCase();

  if (countryCache.has(code)) {
    return countryCache.get(code);
  }

  const countries = await odoo.searchRead('res.country',
    [['code', '=', code]],
    ['id']
  );

  const countryId = countries.length > 0 ? countries[0].id : null;
  countryCache.set(code, countryId);
  return countryId;
}

async function syncToOdoo(tsvPath, isDryRun) {
  console.log('=== Sync TSV Customer Data to Odoo ===');
  console.log(isDryRun ? '(DRY RUN - no changes will be made)\n' : '\n');

  // Parse TSV file
  console.log(`Reading TSV file: ${tsvPath}`);
  const tsvOrders = parseTsvFile(tsvPath);
  console.log(`Found ${tsvOrders.length} unique orders in TSV\n`);

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Initialize AddressCleaner
  const addressCleaner = getAddressCleaner({ useAI: true });
  await addressCleaner.init();
  console.log('AI AddressCleaner initialized\n');

  const countryCache = new Map();

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let notFound = 0;

  for (const tsvOrder of tsvOrders) {
    const orderId = tsvOrder.orderId;

    if (!tsvOrder.recipientName && !tsvOrder.buyerName) {
      skipped++;
      continue;
    }

    try {
      // Find order in Odoo by client_order_ref
      const saleOrders = await odoo.searchRead('sale.order',
        [['client_order_ref', '=', orderId]],
        ['id', 'name', 'partner_id', 'partner_shipping_id', 'partner_invoice_id', 'picking_ids']
      );

      if (saleOrders.length === 0) {
        console.log(`[NOT FOUND] ${orderId}`);
        notFound++;
        continue;
      }

      const saleOrder = saleOrders[0];
      const partnerId = saleOrder.partner_id?.[0];
      const shippingPartnerId = saleOrder.partner_shipping_id?.[0];
      const invoicePartnerId = saleOrder.partner_invoice_id?.[0];

      if (!partnerId) {
        console.log(`[SKIP] ${orderId} - No partner on order`);
        skipped++;
        continue;
      }

      // Clean the address using AI
      const cleanedAddress = await addressCleaner.cleanAddress({
        recipientName: tsvOrder.recipientName,
        buyerName: tsvOrder.buyerName,
        addressLine1: tsvOrder.addressLine1,
        addressLine2: tsvOrder.addressLine2,
        addressLine3: tsvOrder.addressLine3,
        city: tsvOrder.city,
        state: tsvOrder.state,
        postalCode: tsvOrder.postalCode,
        countryCode: tsvOrder.countryCode,
      });

      // Get country ID
      const countryId = await getCountryId(odoo, cleanedAddress.country || tsvOrder.countryCode, countryCache);

      // Build display name
      const displayName = cleanedAddress.company
        ? (cleanedAddress.name ? `${cleanedAddress.company}, ${cleanedAddress.name}` : cleanedAddress.company)
        : (cleanedAddress.name || tsvOrder.recipientName || tsvOrder.buyerName);

      if (isDryRun) {
        console.log(`[DRY] ${orderId} -> ${saleOrder.name}`);
        console.log(`       "${displayName}" | ${cleanedAddress.street}, ${cleanedAddress.city} ${cleanedAddress.zip}`);
        updated++;
        continue;
      }

      // Build partner update
      const partnerUpdate = {
        name: displayName,
        street: cleanedAddress.street || false,
        street2: cleanedAddress.street2 || false,
        city: cleanedAddress.city || false,
        zip: cleanedAddress.zip || false,
        country_id: countryId || false
      };

      if (tsvOrder.phone) {
        partnerUpdate.phone = tsvOrder.phone;
      }

      // Collect all unique partner IDs to update
      const partnerIdsToUpdate = [...new Set([partnerId, shippingPartnerId, invoicePartnerId].filter(Boolean))];

      for (const pid of partnerIdsToUpdate) {
        await odoo.write('res.partner', [pid], partnerUpdate);
      }

      // Also update delivery (stock.picking) partner_id
      if (saleOrder.picking_ids && saleOrder.picking_ids.length > 0) {
        const pickings = await odoo.searchRead('stock.picking',
          [['id', 'in', saleOrder.picking_ids]],
          ['id', 'name', 'partner_id', 'state']
        );

        for (const picking of pickings) {
          // Update picking partner to shipping partner
          if (shippingPartnerId && picking.partner_id?.[0] !== shippingPartnerId) {
            await odoo.write('stock.picking', [picking.id], {
              partner_id: shippingPartnerId
            });
          }
        }
      }

      console.log(`[OK] ${orderId} -> ${saleOrder.name} | "${displayName}" | ${cleanedAddress.street}, ${cleanedAddress.city}`);
      updated++;

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
  console.log(`Cache:     ${addressCleaner.getCacheStats().size} addresses cached`);

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
  console.error('Usage: node scripts/sync-tsv-to-odoo-direct.js <tsv-file> [--dry-run]');
  process.exit(1);
}

if (!fs.existsSync(tsvPath)) {
  console.error(`File not found: ${tsvPath}`);
  process.exit(1);
}

syncToOdoo(tsvPath, isDryRun).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
