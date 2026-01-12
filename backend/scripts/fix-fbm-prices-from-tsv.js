/**
 * Fix FBM Order Prices from TSV
 *
 * Updates Odoo sale.order.line prices where price_unit is 0,
 * using price data from an Amazon TSV export.
 *
 * Usage: node scripts/fix-fbm-prices-from-tsv.js <tsv-file-path>
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Parse TSV content
function parseTsv(content) {
  const lines = content.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('TSV file is empty or has no data rows');
  }

  const headers = lines[0].split('\t');
  const headerIndex = {};
  headers.forEach((h, i) => headerIndex[h.trim()] = i);

  // Verify required columns exist
  const requiredColumns = ['order-id', 'sku', 'quantity-purchased', 'item-price'];
  for (const col of requiredColumns) {
    if (headerIndex[col] === undefined) {
      throw new Error(`Missing required column: ${col}`);
    }
  }

  console.log(`[Parser] Found columns: item-price=${headerIndex['item-price']}, item-promotion-discount=${headerIndex['item-promotion-discount']}, vat-exclusive-item-price=${headerIndex['vat-exclusive-item-price']}`);

  const orders = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 10) continue;

    const orderId = cols[headerIndex['order-id']]?.trim();
    const sku = cols[headerIndex['sku']]?.trim();
    const quantityStr = cols[headerIndex['quantity-purchased']]?.trim();
    const vatExclusivePriceStr = cols[headerIndex['vat-exclusive-item-price']]?.trim();
    const itemPriceStr = cols[headerIndex['item-price']]?.trim();
    const itemTaxStr = cols[headerIndex['item-tax']]?.trim();
    const promotionDiscountStr = cols[headerIndex['item-promotion-discount']]?.trim();
    const shipCountry = cols[headerIndex['ship-country']]?.trim();

    // Skip empty rows or promotion continuation rows (no SKU)
    if (!orderId || !sku) continue;

    const quantity = parseInt(quantityStr) || 1;
    const vatExclusivePrice = parseFloat(vatExclusivePriceStr) || 0;
    const itemPrice = parseFloat(itemPriceStr) || 0;
    const itemTax = parseFloat(itemTaxStr) || 0;
    const promotionDiscount = parseFloat(promotionDiscountStr) || 0; // Usually negative

    // Calculate gross price after discount (what customer actually pays)
    const grossAfterDiscount = itemPrice + promotionDiscount; // promotionDiscount is negative

    // Determine tax rate from country (standard VAT rates)
    const taxRates = {
      'DE': 0.19, 'AT': 0.20, 'FR': 0.20, 'IT': 0.22, 'ES': 0.21,
      'NL': 0.21, 'BE': 0.21, 'PL': 0.23, 'SE': 0.25, 'UK': 0.20
    };
    const taxRate = taxRates[shipCountry] || 0.19; // Default to 19%

    // Calculate net price after discount
    const netAfterDiscount = grossAfterDiscount / (1 + taxRate);

    // Calculate unit price (tax-exclusive, after discount)
    const unitPrice = quantity > 0 ? netAfterDiscount / quantity : netAfterDiscount;

    // Resolve SKU (strip -FBM suffix)
    let resolvedSku = sku;
    if (resolvedSku.toUpperCase().endsWith('-FBM')) {
      resolvedSku = resolvedSku.slice(0, -4);
    }
    if (resolvedSku.toUpperCase().endsWith('-FBMA')) {
      resolvedSku = resolvedSku.slice(0, -5);
    }

    if (!orders[orderId]) {
      orders[orderId] = {
        orderId,
        items: []
      };
    }

    orders[orderId].items.push({
      sku,
      resolvedSku,
      quantity,
      vatExclusivePrice,
      itemPrice,
      itemTax,
      promotionDiscount,
      grossAfterDiscount,
      netAfterDiscount,
      unitPrice,
      taxRate,
      shipCountry
    });
  }

  return orders;
}

async function main() {
  const tsvPath = process.argv[2];
  if (!tsvPath) {
    console.error('Usage: node scripts/fix-fbm-prices-from-tsv.js <tsv-file-path>');
    process.exit(1);
  }

  // Read TSV file
  console.log(`[Main] Reading TSV file: ${tsvPath}`);
  const tsvContent = fs.readFileSync(tsvPath, 'utf-8');

  // Parse TSV
  const orders = parseTsv(tsvContent);
  const orderIds = Object.keys(orders);
  console.log(`[Main] Parsed ${orderIds.length} orders from TSV`);

  // Initialize Odoo client
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('[Main] Connected to Odoo');

  const results = {
    checked: 0,
    updated: 0,
    skipped: 0,
    notFound: 0,
    errors: []
  };

  for (const orderId of orderIds) {
    const orderData = orders[orderId];
    results.checked++;

    try {
      // Find order in Odoo by client_order_ref
      const odooOrders = await odoo.searchRead('sale.order',
        [['client_order_ref', '=', orderId]],
        ['id', 'name', 'state']
      );

      if (odooOrders.length === 0) {
        console.log(`[Skip] Order ${orderId} not found in Odoo`);
        results.notFound++;
        continue;
      }

      const odooOrder = odooOrders[0];

      // Skip cancelled orders
      if (odooOrder.state === 'cancel') {
        console.log(`[Skip] Order ${orderId} is cancelled`);
        results.skipped++;
        continue;
      }

      // Get order lines
      const lines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', odooOrder.id]],
        ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit']
      );

      // Update each line - force update all prices from TSV data
      for (const line of lines) {

        // Find matching item in TSV data by checking product name or SKU
        const productName = line.product_id ? line.product_id[1] : '';

        // Extract SKU from product name [SKU] format
        const skuMatch = productName.match(/\[([^\]]+)\]/);
        const lineSku = skuMatch ? skuMatch[1] : null;

        // Find matching TSV item
        let matchingItem = null;
        for (const item of orderData.items) {
          if (lineSku && (item.resolvedSku === lineSku || item.sku === lineSku)) {
            matchingItem = item;
            break;
          }
        }

        if (!matchingItem) {
          // Try to match by quantity if only one item
          if (orderData.items.length === 1 && lines.length === 1) {
            matchingItem = orderData.items[0];
          }
        }

        if (!matchingItem) {
          console.log(`[Skip] No matching TSV item for line ${line.id} (SKU: ${lineSku}) in order ${orderId}`);
          continue;
        }

        if (matchingItem.unitPrice <= 0) {
          console.log(`[Skip] TSV unit price is 0 for ${lineSku} in order ${orderId}`);
          continue;
        }

        // Check if price needs updating (with tolerance for rounding)
        const currentPrice = line.price_unit;
        const newPrice = Math.round(matchingItem.unitPrice * 100) / 100; // Round to 2 decimals
        const priceDiff = Math.abs(currentPrice - newPrice);

        if (priceDiff < 0.01) {
          console.log(`[Skip] Price already correct for ${lineSku} in order ${orderId}: ${currentPrice}`);
          continue;
        }

        // Update the price
        const discountInfo = matchingItem.promotionDiscount !== 0
          ? ` (discount: ${matchingItem.promotionDiscount.toFixed(2)})`
          : '';
        console.log(`[Update] Order ${odooOrder.name}, Line ${line.id}: ${lineSku} -> price_unit = ${newPrice.toFixed(2)} (was ${currentPrice.toFixed(2)})${discountInfo}`);

        await odoo.write('sale.order.line', [line.id], {
          price_unit: newPrice
        });

        results.updated++;
      }

    } catch (error) {
      console.error(`[Error] Order ${orderId}: ${error.message}`);
      results.errors.push({ orderId, error: error.message });
    }
  }

  console.log('\n========== RESULTS ==========');
  console.log(`Orders checked: ${results.checked}`);
  console.log(`Lines updated: ${results.updated}`);
  console.log(`Orders not found: ${results.notFound}`);
  console.log(`Orders skipped: ${results.skipped}`);
  console.log(`Errors: ${results.errors.length}`);

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.forEach(e => console.log(`  - ${e.orderId}: ${e.error}`));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
