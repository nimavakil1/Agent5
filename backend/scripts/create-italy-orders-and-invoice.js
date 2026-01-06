#!/usr/bin/env node
/**
 * Create Sale Orders and Invoices for Italy Warehouse Orders
 *
 * These orders exist in VCS data but were never imported via SP-API.
 * This script:
 * 1. Creates a sale order in Odoo
 * 2. Confirms the sale order
 * 3. Creates and posts the invoice
 *
 * Usage:
 *   node scripts/create-italy-orders-and-invoice.js --dry-run
 *   node scripts/create-italy-orders-and-invoice.js
 */

const { MongoClient } = require('mongodb');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent5';
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]) || 0;

// Italian VAT number for seller
const SELLER_VAT_IT = 'IT04104600046';

// Fiscal Position mapping for B2C (OSS)
const OSS_FISCAL_POSITIONS = {
  'IT': 19,  // IT*OSS | B2C Italy (domestic 22%)
  'DE': 15,  // DE*OSS | B2C Germany (19%)
  'FR': 14,  // FR*OSS | B2C France (20%)
  'AT': 6,   // AT*OSS | B2C Austria (20%)
  'ES': 30,  // ES*OSS | B2C Spain (21%)
  'NL': 24,  // NL*OSS | B2C Netherlands (21%)
  'BE': 3,   // BE*OSS | B2C Belgium (21%)
  'PL': 28,  // PL*OSS | B2C Poland (23%)
};

// B2C Partner IDs per country
const B2C_PARTNERS = {
  'IT': 136627,  // Amazon | AMZ_B2C_IT
  'DE': 234720,  // Amazon | AMZ_B2C_DE
  'FR': 234719,  // Amazon | AMZ_B2C_FR
  'AT': 233535,  // Amazon | AMZ_B2C_AT
  'ES': 233667,  // Amazon | AMZ_B2C_ES
  'NL': 3148,    // Amazon | AMZ_B2C_NL
  'BE': 234762,  // Amazon | AMZ_B2C_BE
  'PL': 233590,  // Amazon | AMZ_B2C_PL
};

// Italian warehouse ID
const WAREHOUSE_IT = 2;  // FBA Italy warehouse

// Journal: VIT for Italian warehouse shipments
const JOURNAL_VIT = 40;

// Amazon Seller team
const TEAM_AMAZON_SELLER = 11;

// SKU transformation (same as VcsOdooInvoicer)
function transformSku(amazonSku) {
  let sku = amazonSku;
  // Handle return SKUs: amzn.gr.[base-sku]-[random-string]
  const returnMatch = sku.match(/^amzn\.gr\.(.+?)-[A-Za-z0-9]{8,}/);
  if (returnMatch) sku = returnMatch[1];
  // Remove suffixes
  sku = sku.replace(/-FBM$/, '').replace(/-stickerless$/, '').replace(/-stickerles$/, '');
  return sku;
}

async function main() {
  console.log('=== Create Italy Orders and Invoices ===');
  console.log('Mode:', DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE');
  console.log('Seller VAT:', SELLER_VAT_IT);
  if (LIMIT) console.log('Limit:', LIMIT);
  console.log('');

  const mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  const vcsOrders = db.collection('amazon_vcs_orders');

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to MongoDB and Odoo\n');

  // Find manual_required orders without Odoo link and with prices
  const query = {
    status: 'manual_required',
    $or: [
      { odooOrderId: { $exists: false } },
      { odooOrderId: null }
    ],
    'items.0': { $exists: true },
    $or: [
      { 'items.priceInclusive': { $gt: 0 } },
      { 'items.priceExclusive': { $gt: 0 } }
    ]
  };

  let orders = await vcsOrders.find({
    status: 'manual_required',
    $and: [
      { $or: [{ odooOrderId: { $exists: false } }, { odooOrderId: null }] },
      { 'items.0': { $exists: true } },
      { $or: [{ 'items.priceInclusive': { $gt: 0 } }, { 'items.priceExclusive': { $gt: 0 } }] }
    ]
  }).toArray();

  console.log(`Found ${orders.length} orders without Odoo link\n`);

  if (LIMIT && orders.length > LIMIT) {
    orders = orders.slice(0, LIMIT);
    console.log(`Processing first ${LIMIT} orders\n`);
  }

  // Stats
  const stats = {
    processed: 0,
    created: 0,
    skipped: 0,
    errors: 0,
    byCountry: {}
  };

  // Product cache
  const productCache = new Map();

  async function getProductBySku(sku) {
    const cacheKey = sku;
    if (productCache.has(cacheKey)) return productCache.get(cacheKey);

    // Try original SKU
    let products = await odoo.searchRead('product.product',
      [['default_code', '=', sku]],
      ['id', 'name', 'default_code', 'list_price']
    );

    if (products.length === 0) {
      // Try transformed SKU
      const transformed = transformSku(sku);
      if (transformed !== sku) {
        products = await odoo.searchRead('product.product',
          [['default_code', '=', transformed]],
          ['id', 'name', 'default_code', 'list_price']
        );
      }
    }

    const product = products.length > 0 ? products[0] : null;
    productCache.set(cacheKey, product);
    return product;
  }

  for (const order of orders) {
    const { orderId, shipToCountry, buyerTaxRegistration, items, orderDate, shipmentDate } = order;

    stats.byCountry[shipToCountry] = (stats.byCountry[shipToCountry] || 0) + 1;

    try {
      // Check if order already exists in Odoo (by client_order_ref)
      const existingOrders = await odoo.searchRead('sale.order',
        [['client_order_ref', '=', orderId]],
        ['id', 'name']
      );

      if (existingOrders.length > 0) {
        console.log(`  SKIP ${orderId}: Order already exists as ${existingOrders[0].name}`);

        // Update VCS with Odoo link
        if (!DRY_RUN) {
          await vcsOrders.updateOne(
            { _id: order._id },
            { $set: { odooOrderId: existingOrders[0].id } }
          );
        }
        stats.skipped++;
        continue;
      }

      // Get fiscal position and partner
      const isB2B = buyerTaxRegistration && buyerTaxRegistration.trim() !== '';
      const fiscalPositionId = OSS_FISCAL_POSITIONS[shipToCountry];
      const partnerId = B2C_PARTNERS[shipToCountry];

      if (!fiscalPositionId || !partnerId) {
        console.log(`  SKIP ${orderId}: No fiscal position or partner for ${shipToCountry}`);
        stats.skipped++;
        continue;
      }

      // Build order lines
      const orderLines = [];
      let hasAllProducts = true;

      for (const item of items) {
        const product = await getProductBySku(item.sku);
        if (!product) {
          console.log(`  SKIP ${orderId}: Product not found for SKU ${item.sku}`);
          hasAllProducts = false;
          break;
        }

        // Calculate unit price from VCS (price is total for qty)
        const qty = item.quantity || 1;
        const unitPrice = (item.priceInclusive || item.priceExclusive || 0) / qty;

        orderLines.push([0, 0, {
          product_id: product.id,
          product_uom_qty: qty,
          price_unit: unitPrice,
        }]);
      }

      if (!hasAllProducts) {
        stats.skipped++;
        continue;
      }

      if (orderLines.length === 0) {
        console.log(`  SKIP ${orderId}: No order lines`);
        stats.skipped++;
        continue;
      }

      // Determine order date
      const dateOrder = shipmentDate || orderDate || new Date();
      const formattedDate = new Date(dateOrder).toISOString().replace('T', ' ').substring(0, 19);

      let saleOrderId = null;
      let saleOrderName = null;
      let invoiceId = null;

      if (!DRY_RUN) {
        // Create sale order
        saleOrderId = await odoo.create('sale.order', {
          partner_id: partnerId,
          partner_invoice_id: partnerId,
          partner_shipping_id: partnerId,
          date_order: formattedDate,
          client_order_ref: orderId,
          warehouse_id: WAREHOUSE_IT,
          fiscal_position_id: fiscalPositionId,
          team_id: TEAM_AMAZON_SELLER,
          order_line: orderLines,
        });

        // Get order name
        const createdOrder = await odoo.searchRead('sale.order',
          [['id', '=', saleOrderId]],
          ['name']
        );
        saleOrderName = createdOrder[0]?.name;

        // Confirm the order
        await odoo.execute('sale.order', 'action_confirm', [[saleOrderId]]);

        // Create invoice
        const invoiceLines = [];

        // Get order lines with product info
        const soLines = await odoo.searchRead('sale.order.line',
          [['order_id', '=', saleOrderId]],
          ['id', 'product_id', 'product_uom_qty', 'price_unit', 'name']
        );

        for (const line of soLines) {
          if (!line.product_id) continue;

          invoiceLines.push([0, 0, {
            product_id: line.product_id[0],
            name: line.name || line.product_id[1],
            quantity: line.product_uom_qty,
            price_unit: line.price_unit,
            sale_line_ids: [[4, line.id]],
          }]);
        }

        if (invoiceLines.length > 0) {
          const invoiceDate = new Date(dateOrder).toISOString().split('T')[0];

          invoiceId = await odoo.create('account.move', {
            move_type: 'out_invoice',
            partner_id: partnerId,
            journal_id: JOURNAL_VIT,
            invoice_date: invoiceDate,
            fiscal_position_id: fiscalPositionId,
            ref: orderId,
            x_vcs_invoice_number: `VCS-IT-${orderId}`,
            invoice_origin: saleOrderName,
            invoice_line_ids: invoiceLines,
          });

          // Post the invoice
          if (invoiceId) {
            try {
              await odoo.execute('account.move', 'action_post', [[invoiceId]]);
            } catch (postErr) {
              console.log(`    Warning: Could not post invoice: ${postErr.message}`);
            }
          }
        }

        // Update MongoDB
        await vcsOrders.updateOne(
          { _id: order._id },
          {
            $set: {
              status: 'invoiced',
              sellerTaxRegistration: SELLER_VAT_IT,
              processedAt: new Date(),
              odooOrderId: saleOrderId,
              odooOrderName: saleOrderName,
              odooInvoiceId: invoiceId
            }
          }
        );
      }

      stats.created++;
      stats.processed++;

      if (stats.created <= 10 || stats.created % 10 === 0) {
        console.log(`  ✓ ${orderId} → ${saleOrderName || '(dry-run)'} | ${shipToCountry} | ${orderLines.length} items`);
      }

    } catch (err) {
      console.error(`  ✗ ${orderId}: ${err.message}`);
      stats.errors++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total orders: ${orders.length}`);
  console.log(`Created & invoiced: ${stats.created}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`\nBy destination country:`, stats.byCountry);

  if (DRY_RUN) {
    console.log('\nThis was a DRY RUN. Run without --dry-run to apply changes.');
  }

  await mongoClient.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
