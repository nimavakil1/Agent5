require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const fs = require('fs');
const path = require('path');

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

async function main() {
  console.log('=== VCS vs ODOO COMPREHENSIVE ANALYSIS ===\n');

  // Read VCS files
  const vcsFiles = [
    '/Users/nimavakil/Downloads/taxReport_c26b0feaf8d3ff691909ff5ae0bc274897c92e8b.csv',
    '/Users/nimavakil/Downloads/taxReport_07c4ec70eff1c89a26c1d786aba98e822e0691c0.csv'
  ];

  const vcsOrders = new Map(); // orderId -> { lines: [], totalAmount, invoiceNumbers, ... }

  for (const file of vcsFiles) {
    console.log('Parsing: ' + path.basename(file));
    const content = fs.readFileSync(file, 'utf-8');
    const rows = parseCSV(content);
    console.log('  Rows: ' + rows.length);

    for (const row of rows) {
      const orderId = row['Order ID'];
      if (!orderId) continue;

      const transactionType = row['Transaction Type'];
      const invoiceNum = row['VAT Invoice Number'];
      const currency = row['Currency'];

      // Calculate line total (product + shipping + giftwrap, minus promos)
      const productPrice = parseFloat(row['OUR_PRICE Tax Inclusive Selling Price'] || 0);
      const productPromo = parseFloat(row['OUR_PRICE Tax Inclusive Promo Amount'] || 0);
      const shippingPrice = parseFloat(row['SHIPPING Tax Inclusive Selling Price'] || 0);
      const shippingPromo = parseFloat(row['SHIPPING Tax Inclusive Promo Amount'] || 0);
      const giftPrice = parseFloat(row['GIFTWRAP Tax Inclusive Selling Price'] || 0);
      const giftPromo = parseFloat(row['GIFTWRAP Tax Inclusive Promo Amount'] || 0);

      let lineTotal = productPrice + productPromo + shippingPrice + shippingPromo + giftPrice + giftPromo;

      // For RETURN transactions, amounts are already negative
      // For SHIPMENT, amounts are positive

      if (!vcsOrders.has(orderId)) {
        vcsOrders.set(orderId, {
          lines: [],
          invoiceNumbers: new Set(),
          currencies: new Set(),
          hasShipment: false,
          hasReturn: false,
          totalShipment: 0,
          totalReturn: 0
        });
      }

      const order = vcsOrders.get(orderId);
      order.lines.push({
        transactionType,
        invoiceNum,
        lineTotal,
        currency,
        sku: row['SKU'],
        quantity: parseInt(row['Quantity'] || 0)
      });

      if (invoiceNum) order.invoiceNumbers.add(invoiceNum);
      if (currency) order.currencies.add(currency);

      if (transactionType === 'SHIPMENT') {
        order.hasShipment = true;
        order.totalShipment += lineTotal;
      } else if (transactionType === 'RETURN') {
        order.hasReturn = true;
        order.totalReturn += Math.abs(lineTotal); // Returns are negative, store as positive
      }
    }
  }

  console.log('\nTotal unique orders in VCS: ' + vcsOrders.size);

  // Summarize VCS data
  let shipmentOnly = 0, returnOnly = 0, both = 0;
  for (const [orderId, data] of vcsOrders) {
    if (data.hasShipment && data.hasReturn) both++;
    else if (data.hasShipment) shipmentOnly++;
    else if (data.hasReturn) returnOnly++;
  }
  console.log('  Shipment only: ' + shipmentOnly);
  console.log('  Return only: ' + returnOnly);
  console.log('  Both shipment + return: ' + both);

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('\nConnected to Odoo\n');

  // Get all FBA/FBM orders from Odoo
  console.log('Fetching Odoo orders...');
  const odooOrders = await odoo.searchRead('sale.order',
    [
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_status', 'invoice_ids', 'date_order'],
    { limit: 100000 }
  );
  console.log('Total Odoo FBA/FBM orders: ' + odooOrders.length);

  // Create lookup by Amazon order ID
  const odooByAmazonId = new Map();
  for (const order of odooOrders) {
    const amazonId = order.name.replace(/^FBA|^FBM/, '');
    if (!odooByAmazonId.has(amazonId)) {
      odooByAmazonId.set(amazonId, []);
    }
    odooByAmazonId.get(amazonId).push(order);
  }

  // Get all Odoo invoices with VCS-style names
  console.log('Fetching Odoo invoices...');
  const odooInvoices = await odoo.searchRead('account.move',
    [
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['state', '=', 'posted']
    ],
    ['id', 'name', 'ref', 'amount_total', 'move_type'],
    { limit: 100000 }
  );
  console.log('Total posted invoices: ' + odooInvoices.length);

  // Create lookup by invoice number
  const invoiceByNumber = new Map();
  for (const inv of odooInvoices) {
    invoiceByNumber.set(inv.name, inv);
    if (inv.ref) invoiceByNumber.set(inv.ref, inv);
  }

  // Now analyze: compare VCS orders with Odoo
  console.log('\n=== ANALYSIS ===\n');

  const results = {
    vcsOrdersWithOdooOrder: 0,
    vcsOrdersWithoutOdooOrder: [],
    vcsOrdersWithMatchingInvoice: 0,
    vcsOrdersWithPartialInvoice: [],
    vcsOrdersWithNoInvoice: [],
    odooOrdersNotInVCS: [],
    toInvoiceOrdersNotInVCS: []
  };

  // Check each VCS order
  for (const [orderId, vcsData] of vcsOrders) {
    const odooOrderList = odooByAmazonId.get(orderId);

    if (!odooOrderList || odooOrderList.length === 0) {
      results.vcsOrdersWithoutOdooOrder.push({
        orderId,
        vcsAmount: vcsData.totalShipment,
        invoiceNumbers: Array.from(vcsData.invoiceNumbers)
      });
      continue;
    }

    results.vcsOrdersWithOdooOrder++;

    // Check if VCS invoices exist in Odoo
    let foundInvoices = 0;
    let missingInvoices = [];
    for (const invNum of vcsData.invoiceNumbers) {
      if (invoiceByNumber.has(invNum)) {
        foundInvoices++;
      } else {
        missingInvoices.push(invNum);
      }
    }

    if (foundInvoices === vcsData.invoiceNumbers.size && vcsData.invoiceNumbers.size > 0) {
      results.vcsOrdersWithMatchingInvoice++;
    } else if (foundInvoices > 0) {
      results.vcsOrdersWithPartialInvoice.push({
        orderId,
        found: foundInvoices,
        missing: missingInvoices
      });
    } else if (vcsData.invoiceNumbers.size > 0) {
      results.vcsOrdersWithNoInvoice.push({
        orderId,
        vcsAmount: vcsData.totalShipment,
        invoiceNumbers: Array.from(vcsData.invoiceNumbers)
      });
    }
  }

  // Check "to invoice" orders that are NOT in VCS
  const toInvoiceOrders = odooOrders.filter(o => o.invoice_status === 'to invoice');
  console.log('"To invoice" orders in Odoo: ' + toInvoiceOrders.length);

  for (const order of toInvoiceOrders) {
    const amazonId = order.name.replace(/^FBA|^FBM/, '');
    if (!vcsOrders.has(amazonId)) {
      results.toInvoiceOrdersNotInVCS.push({
        orderId: order.id,
        name: order.name,
        amazonId,
        amount: order.amount_total,
        date: order.date_order ? order.date_order.substring(0, 10) : ''
      });
    }
  }

  // Print results
  console.log('\n=== RESULTS ===\n');
  console.log('VCS orders that have Odoo order: ' + results.vcsOrdersWithOdooOrder);
  console.log('VCS orders WITHOUT Odoo order: ' + results.vcsOrdersWithoutOdooOrder.length);
  console.log('');
  console.log('VCS orders with ALL invoices in Odoo: ' + results.vcsOrdersWithMatchingInvoice);
  console.log('VCS orders with PARTIAL invoices in Odoo: ' + results.vcsOrdersWithPartialInvoice.length);
  console.log('VCS orders with NO invoices in Odoo: ' + results.vcsOrdersWithNoInvoice.length);
  console.log('');
  console.log('"To invoice" orders NOT in VCS files: ' + results.toInvoiceOrdersNotInVCS.length);

  // Date range analysis of missing orders
  if (results.toInvoiceOrdersNotInVCS.length > 0) {
    const byMonth = {};
    for (const o of results.toInvoiceOrdersNotInVCS) {
      const month = o.date ? o.date.substring(0, 7) : 'unknown';
      byMonth[month] = (byMonth[month] || 0) + 1;
    }
    console.log('\n"To invoice" orders NOT in VCS by month:');
    Object.keys(byMonth).sort().forEach(m => {
      console.log('  ' + m + ': ' + byMonth[m]);
    });
  }

  // Export detailed results
  const exportData = {
    summary: {
      totalVcsOrders: vcsOrders.size,
      vcsOrdersWithOdooOrder: results.vcsOrdersWithOdooOrder,
      vcsOrdersWithoutOdooOrder: results.vcsOrdersWithoutOdooOrder.length,
      vcsOrdersWithMatchingInvoice: results.vcsOrdersWithMatchingInvoice,
      vcsOrdersWithPartialInvoice: results.vcsOrdersWithPartialInvoice.length,
      vcsOrdersWithNoInvoice: results.vcsOrdersWithNoInvoice.length,
      toInvoiceOrdersNotInVCS: results.toInvoiceOrdersNotInVCS.length
    },
    toInvoiceNotInVCS: results.toInvoiceOrdersNotInVCS.slice(0, 500),
    vcsWithoutOdooOrder: results.vcsOrdersWithoutOdooOrder.slice(0, 200),
    vcsWithNoInvoice: results.vcsOrdersWithNoInvoice.slice(0, 200)
  };

  fs.writeFileSync('/Users/nimavakil/Downloads/VCS_ODOO_ANALYSIS.json', JSON.stringify(exportData, null, 2));
  console.log('\nDetailed results exported to ~/Downloads/VCS_ODOO_ANALYSIS.json');

  // Also create CSV of "to invoice" orders not in VCS
  if (results.toInvoiceOrdersNotInVCS.length > 0) {
    const csv = 'Order Name,Amazon ID,Order Date,Amount\n' +
      results.toInvoiceOrdersNotInVCS.map(o =>
        [o.name, o.amazonId, o.date, o.amount.toFixed(2)].join(',')
      ).join('\n');
    fs.writeFileSync('/Users/nimavakil/Downloads/TO_INVOICE_NOT_IN_VCS.csv', csv);
    console.log('CSV of "to invoice" orders not in VCS: ~/Downloads/TO_INVOICE_NOT_IN_VCS.csv');
  }
}

main().catch(e => console.error(e));
