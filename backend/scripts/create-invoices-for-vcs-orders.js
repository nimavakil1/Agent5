require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');

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
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else current += char;
  }
  result.push(current.trim());
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '50');

  console.log('=== CREATE INVOICES FOR VCS ORDERS ===');
  console.log('Mode: ' + (dryRun ? 'DRY RUN' : 'EXECUTE'));
  console.log('Limit: ' + limit + '\n');

  // Load VCS data
  const vcsFiles = [
    '/Users/nimavakil/Downloads/taxReport_c26b0feaf8d3ff691909ff5ae0bc274897c92e8b.csv',
    '/Users/nimavakil/Downloads/taxReport_07c4ec70eff1c89a26c1d786aba98e822e0691c0.csv'
  ];

  const vcsOrders = new Map();
  for (const file of vcsFiles) {
    console.log('Loading: ' + file.split('/').pop());
    const rows = parseCSV(fs.readFileSync(file, 'utf-8'));
    for (const row of rows) {
      const orderId = row['Order ID'];
      if (!orderId || row['Transaction Type'] !== 'SHIPMENT') continue;

      if (!vcsOrders.has(orderId)) {
        vcsOrders.set(orderId, {
          totalAmount: 0,
          currency: row['Currency'],
          shipToCountry: row['Ship To Country'],
          shipDate: row['Shipment Date']
        });
      }

      const productPrice = parseFloat(row['OUR_PRICE Tax Inclusive Selling Price'] || 0);
      const productPromo = parseFloat(row['OUR_PRICE Tax Inclusive Promo Amount'] || 0);
      const shippingPrice = parseFloat(row['SHIPPING Tax Inclusive Selling Price'] || 0);
      const shippingPromo = parseFloat(row['SHIPPING Tax Inclusive Promo Amount'] || 0);
      vcsOrders.get(orderId).totalAmount += productPrice + productPromo + shippingPrice + shippingPromo;
    }
  }
  console.log('VCS orders loaded: ' + vcsOrders.size + '\n');

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Get orders without invoices that are in VCS
  const orders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      ['invoice_ids', '=', false],
      '|', ['name', 'like', 'FBA%'], ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'date_order', 'state', 'partner_id'],
    { limit: 5000, order: 'date_order asc' }
  );

  // Filter to orders in VCS
  const ordersToProcess = orders.filter(o => {
    const amazonId = o.name.replace(/^FBA|^FBM/, '');
    return vcsOrders.has(amazonId);
  });

  console.log('Orders to process: ' + ordersToProcess.length);
  console.log('Processing first ' + Math.min(limit, ordersToProcess.length) + '...\n');

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const order of ordersToProcess.slice(0, limit)) {
    const amazonId = order.name.replace(/^FBA|^FBM/, '');
    const vcsData = vcsOrders.get(amazonId);

    try {
      if (created < 20 || created % 50 === 0) {
        console.log(order.name + ': Odoo ' + order.amount_total.toFixed(2) + ' | VCS ' + vcsData.currency + ' ' + vcsData.totalAmount.toFixed(2) + ' | ' + vcsData.shipToCountry);
      }

      if (dryRun) {
        created++;
        continue;
      }

      await sleep(200); // Rate limiting

      // Check if order is in 'sale' state (required for invoice creation)
      if (order.state !== 'sale') {
        console.log('  Skipping - state is: ' + order.state);
        skipped++;
        continue;
      }

      // Step 1: Get order lines
      const orderLines = await odoo.searchRead('sale.order.line',
        [['order_id', '=', order.id]],
        ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'tax_id', 'qty_delivered']
      );

      if (orderLines.length === 0) {
        console.log('  No order lines - skipping');
        skipped++;
        continue;
      }

      // Step 2: Update qty_delivered to match qty ordered (for shipments)
      for (const line of orderLines) {
        if (line.qty_delivered < line.product_uom_qty) {
          await odoo.execute('sale.order.line', 'write', [[line.id], {
            qty_delivered: line.product_uom_qty
          }]);
        }
      }

      // Step 3: Build invoice lines
      const invoiceLines = [];
      for (const line of orderLines) {
        if (!line.product_id) continue;
        const qty = line.product_uom_qty;
        invoiceLines.push([0, 0, {
          product_id: line.product_id[0],
          name: line.name,
          quantity: qty,
          price_unit: line.price_unit,
          tax_ids: line.tax_id ? [[6, 0, line.tax_id]] : false,
          sale_line_ids: [[4, line.id]], // Link to sale order line
        }]);
      }

      // Step 4: Create invoice
      const partnerId = order.partner_id ? order.partner_id[0] : null;
      const invoiceId = await odoo.create('account.move', {
        move_type: 'out_invoice',
        partner_id: partnerId,
        invoice_origin: order.name,
        ref: amazonId,
        invoice_line_ids: invoiceLines,
      });

      if (!invoiceId) {
        console.log('  Failed to create invoice');
        skipped++;
        continue;
      }

      // Step 5: Post the invoice
      await odoo.execute('account.move', 'action_post', [[invoiceId]]);

      if (created < 20 || created % 50 === 0) {
        console.log('  Created invoice ID: ' + invoiceId);
      }
      created++;

    } catch (err) {
      if (errors < 10) {
        console.log(order.name + ': ERROR - ' + err.message);
      }
      errors++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Created: ' + created);
  console.log('Skipped: ' + skipped);
  console.log('Errors: ' + errors);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --execute to create invoices.');
  }
}

main().catch(e => console.error(e));
