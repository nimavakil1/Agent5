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
  console.log('=== VCS vs ODOO ANALYSIS V2 (Match by Amazon Order ID) ===\n');

  // Read VCS files
  const vcsFiles = [
    '/Users/nimavakil/Downloads/taxReport_c26b0feaf8d3ff691909ff5ae0bc274897c92e8b.csv',
    '/Users/nimavakil/Downloads/taxReport_07c4ec70eff1c89a26c1d786aba98e822e0691c0.csv'
  ];

  const vcsOrders = new Map(); // orderId -> { totalAmount, lineCount, currencies, ... }

  for (const file of vcsFiles) {
    console.log('Parsing: ' + path.basename(file));
    const content = fs.readFileSync(file, 'utf-8');
    const rows = parseCSV(content);
    console.log('  Rows: ' + rows.length);

    for (const row of rows) {
      const orderId = row['Order ID'];
      if (!orderId) continue;

      const transactionType = row['Transaction Type'];
      const currency = row['Currency'];
      const shipDate = row['Shipment Date'];

      // Calculate line total (product + shipping + giftwrap, including promos)
      const productPrice = parseFloat(row['OUR_PRICE Tax Inclusive Selling Price'] || 0);
      const productPromo = parseFloat(row['OUR_PRICE Tax Inclusive Promo Amount'] || 0);
      const shippingPrice = parseFloat(row['SHIPPING Tax Inclusive Selling Price'] || 0);
      const shippingPromo = parseFloat(row['SHIPPING Tax Inclusive Promo Amount'] || 0);
      const giftPrice = parseFloat(row['GIFTWRAP Tax Inclusive Selling Price'] || 0);
      const giftPromo = parseFloat(row['GIFTWRAP Tax Inclusive Promo Amount'] || 0);

      const lineTotal = productPrice + productPromo + shippingPrice + shippingPromo + giftPrice + giftPromo;

      if (!vcsOrders.has(orderId)) {
        vcsOrders.set(orderId, {
          lineCount: 0,
          currencies: new Set(),
          totalShipment: 0,
          totalReturn: 0,
          shipmentLines: 0,
          returnLines: 0,
          earliestDate: shipDate,
          latestDate: shipDate
        });
      }

      const order = vcsOrders.get(orderId);
      order.lineCount++;
      if (currency) order.currencies.add(currency);

      if (shipDate) {
        if (!order.earliestDate || shipDate < order.earliestDate) order.earliestDate = shipDate;
        if (!order.latestDate || shipDate > order.latestDate) order.latestDate = shipDate;
      }

      if (transactionType === 'SHIPMENT') {
        order.shipmentLines++;
        order.totalShipment += lineTotal;
      } else if (transactionType === 'RETURN') {
        order.returnLines++;
        order.totalReturn += Math.abs(lineTotal);
      }
    }
  }

  console.log('\nTotal unique orders in VCS: ' + vcsOrders.size);

  // Connect to Odoo
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('\nConnected to Odoo');

  // Get all "to invoice" orders
  console.log('\nFetching "to invoice" orders from Odoo...');
  const toInvoiceOrders = await odoo.searchRead('sale.order',
    [
      ['invoice_status', '=', 'to invoice'],
      '|',
      ['name', 'like', 'FBA%'],
      ['name', 'like', 'FBM%']
    ],
    ['id', 'name', 'amount_total', 'invoice_ids', 'date_order'],
    { limit: 10000 }
  );
  console.log('"To invoice" orders: ' + toInvoiceOrders.length);

  // Analyze each "to invoice" order
  const results = {
    inVCS: [],         // Orders that ARE in VCS (should have invoices)
    notInVCS: [],      // Orders NOT in VCS (no VCS data available)
    inVCSAmountMatch: [],
    inVCSAmountMismatch: []
  };

  for (const order of toInvoiceOrders) {
    const amazonId = order.name.replace(/^FBA|^FBM/, '');
    const vcsData = vcsOrders.get(amazonId);

    if (!vcsData) {
      results.notInVCS.push({
        orderId: order.id,
        name: order.name,
        amazonId,
        amount: order.amount_total,
        date: order.date_order ? order.date_order.substring(0, 10) : '',
        hasInvoices: order.invoice_ids && order.invoice_ids.length > 0
      });
    } else {
      const vcsNet = vcsData.totalShipment - vcsData.totalReturn;
      const diff = Math.abs(order.amount_total - vcsNet);

      results.inVCS.push({
        orderId: order.id,
        name: order.name,
        amazonId,
        odooAmount: order.amount_total,
        vcsShipment: vcsData.totalShipment,
        vcsReturn: vcsData.totalReturn,
        vcsNet,
        diff,
        vcsLineCount: vcsData.lineCount,
        vcsCurrencies: Array.from(vcsData.currencies),
        vcsDate: vcsData.earliestDate,
        hasInvoices: order.invoice_ids && order.invoice_ids.length > 0
      });

      if (diff < 1) {
        results.inVCSAmountMatch.push(results.inVCS[results.inVCS.length - 1]);
      } else {
        results.inVCSAmountMismatch.push(results.inVCS[results.inVCS.length - 1]);
      }
    }
  }

  // Print summary
  console.log('\n=== RESULTS ===\n');
  console.log('"To invoice" orders IN VCS: ' + results.inVCS.length);
  console.log('  - Amount matches: ' + results.inVCSAmountMatch.length);
  console.log('  - Amount mismatch: ' + results.inVCSAmountMismatch.length);
  console.log('"To invoice" orders NOT in VCS: ' + results.notInVCS.length);

  // Break down by currency for orders in VCS
  const byCurrency = {};
  for (const o of results.inVCS) {
    const curr = o.vcsCurrencies.join(',') || 'unknown';
    byCurrency[curr] = (byCurrency[curr] || 0) + 1;
  }
  console.log('\n"To invoice" orders in VCS by currency:');
  Object.entries(byCurrency).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => {
    console.log('  ' + c + ': ' + n);
  });

  // Date range of orders NOT in VCS
  if (results.notInVCS.length > 0) {
    const byMonth = {};
    for (const o of results.notInVCS) {
      const month = o.date ? o.date.substring(0, 7) : 'unknown';
      byMonth[month] = (byMonth[month] || 0) + 1;
    }
    console.log('\n"To invoice" orders NOT in VCS by month:');
    Object.keys(byMonth).sort().forEach(m => {
      console.log('  ' + m + ': ' + byMonth[m]);
    });
  }

  // Show sample mismatches
  if (results.inVCSAmountMismatch.length > 0) {
    console.log('\nSample amount mismatches (first 10):');
    for (const o of results.inVCSAmountMismatch.slice(0, 10)) {
      console.log('  ' + o.name + ': Odoo EUR ' + o.odooAmount.toFixed(2) +
        ' vs VCS ' + o.vcsCurrencies.join('/') + ' ' + o.vcsNet.toFixed(2) +
        ' (diff: ' + o.diff.toFixed(2) + ', VCS lines: ' + o.vcsLineCount + ')');
    }
  }

  // Export results
  const exportData = {
    summary: {
      toInvoiceInVCS: results.inVCS.length,
      amountMatch: results.inVCSAmountMatch.length,
      amountMismatch: results.inVCSAmountMismatch.length,
      notInVCS: results.notInVCS.length
    },
    inVCS: results.inVCS,
    notInVCS: results.notInVCS
  };

  fs.writeFileSync('/Users/nimavakil/Downloads/VCS_ANALYSIS_V2.json', JSON.stringify(exportData, null, 2));
  console.log('\nDetailed results exported to ~/Downloads/VCS_ANALYSIS_V2.json');

  // CSV of orders in VCS that still need invoicing
  const csv = 'Order Name,Amazon ID,Odoo Amount,VCS Net,Diff,VCS Lines,Currency,VCS Date,Has Invoices\n' +
    results.inVCS.map(o =>
      [o.name, o.amazonId, o.odooAmount.toFixed(2), o.vcsNet.toFixed(2), o.diff.toFixed(2),
       o.vcsLineCount, o.vcsCurrencies.join('/'), o.vcsDate || '', o.hasInvoices].join(',')
    ).join('\n');
  fs.writeFileSync('/Users/nimavakil/Downloads/TO_INVOICE_IN_VCS.csv', csv);
  console.log('CSV of "to invoice" orders in VCS: ~/Downloads/TO_INVOICE_IN_VCS.csv');
}

main().catch(e => console.error(e));
