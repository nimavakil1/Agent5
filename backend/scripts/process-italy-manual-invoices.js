#!/usr/bin/env node
/**
 * Process Manual Invoice Queue - Italy Warehouse Orders
 *
 * These orders shipped from Italian FBA warehouses but couldn't be invoiced
 * by Amazon due to missing Italian VAT registration in their system.
 *
 * This script:
 * 1. Uses VCS prices (already in the data)
 * 2. Applies correct OSS fiscal position based on destination country
 * 3. Handles B2B (with buyer VAT) vs B2C
 * 4. Creates invoices in Odoo
 *
 * Usage:
 *   node scripts/process-italy-manual-invoices.js --dry-run
 *   node scripts/process-italy-manual-invoices.js
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

// Fiscal Position mapping for B2B (Intra-EU reverse charge)
const B2B_FISCAL_POSITIONS = {
  'IT': 61,  // IT*VAT | Régime National
  'DE': 52,  // DE*VAT | Régime Intra-Communautaire
  'FR': 37,  // FR*VAT | Régime Intra-Communautaire
  'AT': 6,   // Use OSS for AT (no specific B2B found)
  'ES': 30,  // Use OSS for ES (no specific B2B found)
  'NL': 24,  // Use OSS for NL (no specific B2B found)
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

// Journal: VIT for Italian warehouse shipments
const JOURNAL_VIT = 40;

// SKU transformation (same as VcsOdooInvoicer)
function transformSku(amazonSku) {
  let sku = amazonSku;
  const returnMatch = sku.match(/^amzn\.gr\.(.+?)-[A-Za-z0-9]{8,}/);
  if (returnMatch) sku = returnMatch[1];
  sku = sku.replace(/-FBM$/, '').replace(/-stickerless$/, '').replace(/-stickerles$/, '');
  return sku;
}

async function main() {
  console.log('=== Process Italy Manual Invoice Queue ===');
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

  // Find manual_required orders with prices
  const query = {
    status: 'manual_required',
    'items.0': { $exists: true },
    $or: [
      { 'items.priceInclusive': { $gt: 0 } },
      { 'items.priceExclusive': { $gt: 0 } }
    ]
  };

  let orders = await vcsOrders.find(query).toArray();
  console.log(`Found ${orders.length} manual_required orders with prices\n`);

  if (LIMIT && orders.length > LIMIT) {
    orders = orders.slice(0, LIMIT);
    console.log(`Processing first ${LIMIT} orders\n`);
  }

  // Stats
  const stats = {
    processed: 0,
    invoiced: 0,
    skipped: 0,
    errors: 0,
    byCountry: {},
    b2b: 0,
    b2c: 0
  };

  // Product cache
  const productCache = new Map();

  async function getProductBySku(sku) {
    if (productCache.has(sku)) return productCache.get(sku);

    const products = await odoo.searchRead('product.product',
      [['default_code', '=', sku]],
      ['id', 'name', 'default_code']
    );

    const product = products.length > 0 ? products[0] : null;
    productCache.set(sku, product);
    return product;
  }

  // B2B partner cache
  const b2bPartnerCache = new Map();

  async function getOrCreateB2BPartner(buyerVat, countryCode) {
    const cacheKey = buyerVat;
    if (b2bPartnerCache.has(cacheKey)) return b2bPartnerCache.get(cacheKey);

    // Search by VAT
    let partners = await odoo.searchRead('res.partner',
      [['vat', '=', buyerVat]],
      ['id', 'name']
    );

    if (partners.length > 0) {
      b2bPartnerCache.set(cacheKey, partners[0].id);
      return partners[0].id;
    }

    // Create new B2B partner
    const countries = await odoo.searchRead('res.country',
      [['code', '=', countryCode]],
      ['id']
    );
    const countryId = countries.length > 0 ? countries[0].id : null;

    if (!DRY_RUN) {
      const partnerId = await odoo.create('res.partner', {
        name: `Amazon B2B | ${buyerVat}`,
        company_type: 'company',
        is_company: true,
        customer_rank: 1,
        vat: buyerVat,
        country_id: countryId,
        comment: `Amazon B2B customer. VAT: ${buyerVat}`
      });
      b2bPartnerCache.set(cacheKey, partnerId);
      console.log(`    Created B2B partner: ${buyerVat} (ID: ${partnerId})`);
      return partnerId;
    }

    return null;
  }

  for (const order of orders) {
    const { orderId, shipToCountry, buyerTaxRegistration, items, odooOrderId } = order;

    stats.byCountry[shipToCountry] = (stats.byCountry[shipToCountry] || 0) + 1;

    try {
      // Determine B2B vs B2C
      const isB2B = buyerTaxRegistration && buyerTaxRegistration.trim() !== '';
      if (isB2B) stats.b2b++; else stats.b2c++;

      // Get fiscal position
      const fiscalPositionId = isB2B
        ? (B2B_FISCAL_POSITIONS[shipToCountry] || OSS_FISCAL_POSITIONS[shipToCountry])
        : OSS_FISCAL_POSITIONS[shipToCountry];

      if (!fiscalPositionId) {
        console.log(`  SKIP ${orderId}: No fiscal position for ${shipToCountry}`);
        stats.skipped++;
        continue;
      }

      // Get partner
      let partnerId;
      if (isB2B) {
        partnerId = await getOrCreateB2BPartner(buyerTaxRegistration, shipToCountry);
      } else {
        partnerId = B2C_PARTNERS[shipToCountry];
      }

      if (!partnerId && !DRY_RUN) {
        console.log(`  SKIP ${orderId}: No partner for ${shipToCountry}`);
        stats.skipped++;
        continue;
      }

      // Check if Odoo order exists
      if (!odooOrderId) {
        console.log(`  SKIP ${orderId}: No Odoo order linked`);
        stats.skipped++;
        continue;
      }

      // Get Odoo sale order
      const saleOrders = await odoo.searchRead('sale.order',
        [['id', '=', odooOrderId]],
        ['id', 'name', 'state', 'order_line', 'invoice_ids', 'fiscal_position_id']
      );

      if (saleOrders.length === 0) {
        console.log(`  SKIP ${orderId}: Odoo order ${odooOrderId} not found`);
        stats.skipped++;
        continue;
      }

      const saleOrder = saleOrders[0];

      // Check if already invoiced
      if (saleOrder.invoice_ids && saleOrder.invoice_ids.length > 0) {
        // Check invoice states
        const invoices = await odoo.searchRead('account.move',
          [['id', 'in', saleOrder.invoice_ids]],
          ['id', 'state']
        );
        const hasPostedInvoice = invoices.some(inv => inv.state === 'posted');
        if (hasPostedInvoice) {
          console.log(`  SKIP ${orderId}: Already has posted invoice`);
          stats.skipped++;

          // Update MongoDB status
          if (!DRY_RUN) {
            await vcsOrders.updateOne(
              { _id: order._id },
              { $set: { status: 'invoiced', processedAt: new Date() } }
            );
          }
          continue;
        }
      }

      // Get order lines
      const orderLines = await odoo.searchRead('sale.order.line',
        [['id', 'in', saleOrder.order_line]],
        ['id', 'product_id', 'product_uom_qty', 'price_unit']
      );

      // Build SKU to VCS item map
      const vcsItemsBySku = new Map();
      for (const item of items) {
        if (item.sku) {
          vcsItemsBySku.set(item.sku, item);
          vcsItemsBySku.set(transformSku(item.sku), item);
        }
      }

      // Update order line prices from VCS
      let linesUpdated = 0;
      for (const line of orderLines) {
        if (!line.product_id) continue;

        // Get product SKU
        const products = await odoo.searchRead('product.product',
          [['id', '=', line.product_id[0]]],
          ['default_code']
        );
        if (products.length === 0) continue;

        const sku = products[0].default_code;
        if (!sku) continue;

        // Find VCS item
        const vcsItem = vcsItemsBySku.get(sku) || vcsItemsBySku.get(transformSku(sku));
        if (!vcsItem) continue;

        // Calculate unit price (VCS price is for the line total)
        const qty = line.product_uom_qty || 1;
        const unitPrice = (vcsItem.priceInclusive || vcsItem.priceExclusive) / qty;

        if (unitPrice > 0 && Math.abs(line.price_unit - unitPrice) > 0.01) {
          if (!DRY_RUN) {
            await odoo.write('sale.order.line', [line.id], {
              price_unit: unitPrice
            });
          }
          linesUpdated++;
        }
      }

      // Update sale order with fiscal position and partner
      if (!DRY_RUN) {
        await odoo.write('sale.order', [saleOrder.id], {
          fiscal_position_id: fiscalPositionId,
          partner_id: partnerId,
          partner_invoice_id: partnerId,
          partner_shipping_id: partnerId
        });
      }

      // Build invoice lines from sale order lines
      const invoiceLines = [];
      for (const line of orderLines) {
        if (!line.product_id) continue;

        // Get product SKU
        const products = await odoo.searchRead('product.product',
          [['id', '=', line.product_id[0]]],
          ['default_code']
        );
        if (products.length === 0) continue;

        const sku = products[0].default_code;
        if (!sku) continue;

        // Find VCS item for this SKU
        const vcsItem = vcsItemsBySku.get(sku) || vcsItemsBySku.get(transformSku(sku));

        // Use VCS price if available, otherwise use order line price
        const qty = line.product_uom_qty || 1;
        let unitPrice = line.price_unit;
        if (vcsItem && (vcsItem.priceInclusive > 0 || vcsItem.priceExclusive > 0)) {
          unitPrice = (vcsItem.priceInclusive || vcsItem.priceExclusive) / qty;
        }

        invoiceLines.push([0, 0, {
          product_id: line.product_id[0],
          name: line.name || line.product_id[1],
          quantity: qty,
          price_unit: unitPrice,
          tax_ids: line.tax_id ? [[6, 0, line.tax_id]] : false,
          sale_line_ids: [[4, line.id]], // Link to sale order line
        }]);
      }

      // Create invoice directly
      let invoiceId = null;
      if (!DRY_RUN && invoiceLines.length > 0) {
        // Get invoice date from VCS order
        const invoiceDate = order.shipmentDate || order.orderDate || new Date();
        const formattedDate = new Date(invoiceDate).toISOString().split('T')[0];

        invoiceId = await odoo.create('account.move', {
          move_type: 'out_invoice',
          partner_id: partnerId,
          journal_id: JOURNAL_VIT,
          invoice_date: formattedDate,
          fiscal_position_id: fiscalPositionId,
          ref: orderId,
          x_vcs_invoice_number: `VCS-IT-${orderId}`,
          invoice_origin: saleOrder.name,
          invoice_line_ids: invoiceLines,
        });

        if (invoiceId) {
          // Post the invoice
          try {
            await odoo.execute('account.move', 'action_post', [[invoiceId]]);
          } catch (postErr) {
            console.log(`    Warning: Could not post invoice ${invoiceId}: ${postErr.message}`);
          }
        }
      }

      // Update MongoDB
      if (!DRY_RUN) {
        await vcsOrders.updateOne(
          { _id: order._id },
          {
            $set: {
              status: 'invoiced',
              sellerTaxRegistration: SELLER_VAT_IT,
              processedAt: new Date(),
              odooInvoiceId: invoiceId
            }
          }
        );
      }

      stats.invoiced++;
      stats.processed++;

      const b2bLabel = isB2B ? `B2B:${buyerTaxRegistration}` : 'B2C';
      if (stats.invoiced <= 10 || stats.invoiced % 20 === 0) {
        console.log(`  ✓ ${orderId} → ${shipToCountry} (${b2bLabel}) | ${linesUpdated} lines updated`);
      }

    } catch (err) {
      console.error(`  ✗ ${orderId}: ${err.message}`);
      stats.errors++;
    }

    // Progress
    if (stats.processed % 50 === 0 && stats.processed > 0) {
      console.log(`  Progress: ${stats.processed}/${orders.length} | Invoiced: ${stats.invoiced} | Errors: ${stats.errors}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total orders: ${orders.length}`);
  console.log(`Processed: ${stats.processed}`);
  console.log(`Invoiced: ${stats.invoiced}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`\nBy destination country:`, stats.byCountry);
  console.log(`B2B orders: ${stats.b2b}`);
  console.log(`B2C orders: ${stats.b2c}`);

  if (DRY_RUN) {
    console.log('\nThis was a DRY RUN. Run without --dry-run to apply changes.');
  }

  await mongoClient.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
