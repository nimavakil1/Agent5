#!/usr/bin/env node
/**
 * Fix Odoo FBA Order Prices from VCS Data
 *
 * Amazon SP-API doesn't return item prices for FBA orders, so Odoo orders
 * are created with 0 prices. This script updates Odoo order lines with
 * correct prices from VCS data stored in MongoDB.
 *
 * Usage:
 *   MONGODB_URI="mongodb://localhost:27017/agent5" \
 *   ODOO_URL="https://acropaq.odoo.com" \
 *   ODOO_DB="ninicocolala-v16-fvl-fvl-7662670" \
 *   ODOO_USERNAME="info@acropaq.com" \
 *   ODOO_PASSWORD="xxx" \
 *   node scripts/fix-odoo-fba-prices-from-vcs.js
 *
 *   Add --dry-run to preview changes without updating
 */

const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';
const DRY_RUN = process.argv.includes('--dry-run');

// SKU transformation patterns - same as VcsOdooInvoicer.js
const SKU_TRANSFORMATIONS = [
  { pattern: /-FBM$/, replacement: '' },
  { pattern: /-stickerless$/, replacement: '' },
  { pattern: /-stickerles$/, replacement: '' },
];

// Return SKU pattern: amzn.gr.[base-sku]-[random-string]
const RETURN_SKU_PATTERN = /^amzn\.gr\.(.+?)-[A-Za-z0-9]{8,}/;

/**
 * Transform Amazon SKU to Odoo SKU format
 * Handles return SKU patterns and various suffixes
 */
function transformSku(amazonSku) {
  let sku = amazonSku;

  // First, check for return SKU pattern: amzn.gr.[base-sku]-[random-string]
  const returnMatch = sku.match(RETURN_SKU_PATTERN);
  if (returnMatch) {
    sku = returnMatch[1];
  }

  // Then apply regular transformations (-FBM, -stickerless, etc.)
  for (const transform of SKU_TRANSFORMATIONS) {
    sku = sku.replace(transform.pattern, transform.replacement);
  }
  return sku;
}

async function main() {
  console.log('=== Fix Odoo FBA Order Prices from VCS Data ===');
  console.log('Mode:', DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE UPDATE');
  console.log('');

  // Connect to MongoDB
  const mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  const vcsOrders = db.collection('amazon_vcs_orders');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to MongoDB and Odoo\n');

  // Step 1: Find all FBA orders with 0 amount in Odoo
  console.log('Step 1: Finding FBA orders with 0 amount in Odoo...');

  let allZeroOrders = [];
  let offset = 0;
  const batchSize = 500;

  while (true) {
    const batch = await odoo.searchRead('sale.order',
      [
        ['name', 'like', 'FBA%'],
        ['amount_total', '=', 0],
        ['state', 'in', ['sale', 'done']]
      ],
      ['id', 'name', 'client_order_ref', 'order_line'],
      { limit: batchSize, offset }
    );

    if (batch.length === 0) break;
    allZeroOrders = allZeroOrders.concat(batch);
    offset += batch.length;
    if (batch.length < batchSize) break;
  }

  console.log(`Found ${allZeroOrders.length} FBA orders with 0 amount\n`);

  // Step 2: Match with VCS data and update
  let updated = 0;
  let skipped = 0;
  let noVcsData = 0;
  let errors = 0;

  for (const order of allZeroOrders) {
    const amazonOrderId = order.client_order_ref;
    if (!amazonOrderId) {
      skipped++;
      continue;
    }

    // Find VCS order in MongoDB
    const vcsOrder = await vcsOrders.findOne({
      orderId: amazonOrderId,
      transactionType: 'SHIPMENT'
    });

    if (!vcsOrder || !vcsOrder.items || vcsOrder.items.length === 0) {
      noVcsData++;
      continue;
    }

    try {
      // Get order lines from Odoo
      if (!order.order_line || order.order_line.length === 0) {
        skipped++;
        continue;
      }

      const odooLines = await odoo.searchRead('sale.order.line',
        [['id', 'in', order.order_line]],
        ['id', 'product_id', 'product_uom_qty', 'price_unit']
      );

      // Map VCS items by SKU (including transformed variants)
      const vcsItemsBySku = new Map();
      for (const vcsItem of vcsOrder.items) {
        if (vcsItem.sku) {
          // Add original SKU
          vcsItemsBySku.set(vcsItem.sku, vcsItem);
          // Also add transformed SKU for matching
          const transformed = transformSku(vcsItem.sku);
          if (transformed !== vcsItem.sku) {
            vcsItemsBySku.set(transformed, vcsItem);
          }
        }
      }

      // Update each Odoo line with VCS price
      let linesUpdated = 0;
      for (const line of odooLines) {
        if (line.price_unit > 0) continue; // Already has price

        // Get product default_code (SKU)
        let sku = null;
        if (line.product_id) {
          const products = await odoo.searchRead('product.product',
            [['id', '=', line.product_id[0]]],
            ['default_code']
          );
          if (products.length > 0) {
            sku = products[0].default_code;
          }
        }

        if (!sku) continue;

        const vcsItem = vcsItemsBySku.get(sku);
        if (!vcsItem || !vcsItem.priceInclusive) continue;

        // Calculate unit price (VCS price is inclusive, for the line total)
        const qty = line.product_uom_qty || 1;
        const unitPrice = vcsItem.priceInclusive / qty;

        if (!DRY_RUN) {
          await odoo.write('sale.order.line', [line.id], {
            price_unit: unitPrice
          });
        }
        linesUpdated++;
      }

      if (linesUpdated > 0) {
        updated++;
        if (updated <= 10) {
          console.log(`  Updated: ${order.name} (${linesUpdated} lines)`);
        }
      }
    } catch (err) {
      console.error(`  Error updating ${order.name}:`, err.message);
      errors++;
    }

    // Progress indicator
    if ((updated + noVcsData + skipped + errors) % 100 === 0) {
      console.log(`  Progress: ${updated} updated, ${noVcsData} no VCS, ${skipped} skipped, ${errors} errors`);
    }
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`Total FBA orders with 0 amount: ${allZeroOrders.length}`);
  console.log(`Updated with VCS prices: ${updated}`);
  console.log(`Skipped (no ref/lines): ${skipped}`);
  console.log(`No VCS data available: ${noVcsData}`);
  console.log(`Errors: ${errors}`);

  if (DRY_RUN) {
    console.log('');
    console.log('This was a DRY RUN. Run without --dry-run to apply changes.');
  }

  await mongoClient.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
