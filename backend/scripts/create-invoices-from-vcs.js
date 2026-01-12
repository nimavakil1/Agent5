require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');
const path = require('path');

// Parse CSV helper
function parseCSV(content) {
  const lines = content.split('\n');
  const headers = parseCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => row[h] = values[idx] || '');
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Journal mapping by destination country
const JOURNALS = {
  'DE': 15, // VDE
  'FR': 14, // VFR
  'IT': 40, // VIT
  'NL': 16, // VNL
  'BE': 1,  // VBE
  'ES': 12, // VOS (OSS)
  'GB': 41, // VGB
  'PL': null, // VPL
  'AT': 12, // VOS
  'DEFAULT': 12, // VOS for other EU
};

// OSS fiscal position by destination country
const OSS_FISCAL_POSITIONS = {
  'AT': 6, 'BE': 35, 'BG': 7, 'HR': 8, 'CY': 9, 'CZ': 10, 'DK': 11, 'EE': 12,
  'FI': 13, 'FR': 14, 'DE': 15, 'GR': 16, 'HU': 17, 'IE': 18, 'IT': 19, 'LV': 20,
  'LT': 21, 'LU': 22, 'MT': 23, 'NL': 24, 'PL': 25, 'PT': 26, 'RO': 27, 'SK': 28,
  'SI': 29, 'ES': 30, 'SE': 31
};

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');

  console.log('=== CREATE INVOICES FROM VCS DATA ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Read VCS files
  const vcsFiles = [
    '/Users/nimavakil/Downloads/taxReport_c26b0feaf8d3ff691909ff5ae0bc274897c92e8b.csv',
    '/Users/nimavakil/Downloads/taxReport_07c4ec70eff1c89a26c1d786aba98e822e0691c0.csv'
  ];

  const vcsOrders = new Map();

  for (const file of vcsFiles) {
    console.log('Parsing: ' + path.basename(file));
    const content = fs.readFileSync(file, 'utf-8');
    const rows = parseCSV(content);
    console.log('  Rows: ' + rows.length);

    for (const row of rows) {
      const orderId = row['Order ID'];
      if (!orderId) continue;

      const transactionType = row['Transaction Type'];
      if (transactionType !== 'SHIPMENT') continue; // Only process shipments

      const shipToCountry = row['Ship To Country'];
      const currency = row['Currency'];
      const shipDate = row['Shipment Date'];
      const taxRate = parseFloat(row['Tax Rate'] || 0);

      // Calculate line total
      const productPrice = parseFloat(row['OUR_PRICE Tax Inclusive Selling Price'] || 0);
      const productPromo = parseFloat(row['OUR_PRICE Tax Inclusive Promo Amount'] || 0);
      const shippingPrice = parseFloat(row['SHIPPING Tax Inclusive Selling Price'] || 0);
      const shippingPromo = parseFloat(row['SHIPPING Tax Inclusive Promo Amount'] || 0);
      const lineTotal = productPrice + productPromo + shippingPrice + shippingPromo;

      if (!vcsOrders.has(orderId)) {
        vcsOrders.set(orderId, {
          lines: [],
          totalAmount: 0,
          currency,
          shipToCountry,
          shipDate,
          taxRate
        });
      }

      const order = vcsOrders.get(orderId);
      order.lines.push({
        sku: row['SKU'],
        quantity: parseInt(row['Quantity'] || 1),
        productPrice,
        productPromo,
        shippingPrice,
        shippingPromo,
        lineTotal,
        taxRate
      });
      order.totalAmount += lineTotal;
      // Use the latest ship date and country
      if (shipDate) order.shipDate = shipDate;
      if (shipToCountry) order.shipToCountry = shipToCountry;
    }
  }

  console.log('\nTotal unique orders in VCS (shipments): ' + vcsOrders.size);

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  // Get "to invoice" orders that don't have any invoices
  console.log('Fetching "to invoice" orders without invoices...');
  const toInvoiceOrders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '=', false], // No invoices linked yet
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'partner_id', 'date_order', 'order_line'],
    { limit: limit * 2, order: 'date_order asc' }
  );

  console.log('Orders without invoices: ' + toInvoiceOrders.length);

  // Filter to orders that ARE in VCS
  const ordersToProcess = [];
  for (const order of toInvoiceOrders) {
    const amazonId = order.name.replace(/^FBA|^FBM/, '');
    const vcsData = vcsOrders.get(amazonId);
    if (vcsData) {
      ordersToProcess.push({ odooOrder: order, vcsData, amazonId });
    }
  }

  console.log('Orders with VCS data: ' + ordersToProcess.length);

  // Process orders
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const { odooOrder, vcsData, amazonId } of ordersToProcess.slice(0, limit)) {
    await sleep(100);

    try {
      console.log('\n' + odooOrder.name + ':');
      console.log('  Odoo total: EUR ' + odooOrder.amount_total.toFixed(2));
      console.log('  VCS total: ' + vcsData.currency + ' ' + vcsData.totalAmount.toFixed(2));
      console.log('  Ship to: ' + vcsData.shipToCountry);
      console.log('  VCS lines: ' + vcsData.lines.length);

      if (dryRun) {
        console.log('  [DRY RUN] Would create invoice');
        created++;
        continue;
      }

      // Get order lines
      const orderLines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', odooOrder.id]],
        ['id', 'product_id', 'product_uom_qty', 'price_unit', 'price_subtotal', 'name']
      );

      // Create invoice from order using Odoo's native method
      // This ensures proper linking to the order
      const invoiceIds = await odoo.execute('sale.order', 'action_invoice_create', [[odooOrder.id]]);

      if (invoiceIds && invoiceIds.length > 0) {
        const invoiceId = invoiceIds[0];

        // Update invoice with VCS reference
        await odoo.execute('account.move', 'write', [[invoiceId], {
          ref: amazonId,
          narration: 'Created from VCS data - Ship to: ' + vcsData.shipToCountry
        }]);

        // Post the invoice
        await odoo.execute('account.move', 'action_post', [[invoiceId]]);

        console.log('  Created and posted invoice ID: ' + invoiceId);
        created++;
      } else {
        console.log('  No invoice created (may already exist)');
        skipped++;
      }

    } catch (err) {
      console.log('  ERROR: ' + err.message);
      errors++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Processed: ' + Math.min(ordersToProcess.length, limit));
  console.log('Created: ' + created);
  console.log('Skipped: ' + skipped);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to create invoices.');
  }
}

main().catch(e => console.error(e));
