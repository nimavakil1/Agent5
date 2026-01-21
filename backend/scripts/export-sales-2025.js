/**
 * Export Odoo Sales Data for 2025
 * Columns: Number, Date, Product/SKU, Quantity, Unit Price, Sales Team, Country
 */

require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const ExcelJS = require('exceljs');
const path = require('path');

async function exportSales2025() {
  console.log('Connecting to Odoo...');
  const client = new OdooDirectClient();
  await client.authenticate();
  console.log('Connected!\n');

  // Date range for 2025
  const startDate = '2025-01-01';
  const endDate = '2025-12-31';

  console.log(`Fetching invoices from ${startDate} to ${endDate}...`);

  // Get all posted customer invoices for 2025
  const invoices = await client.searchRead('account.move', [
    ['move_type', 'in', ['out_invoice', 'out_refund']],
    ['state', '=', 'posted'],
    ['invoice_date', '>=', startDate],
    ['invoice_date', '<=', endDate]
  ], [
    'id', 'name', 'invoice_date', 'partner_id', 'team_id', 'partner_shipping_id'
  ], { limit: 50000, order: 'invoice_date desc, name desc' });

  console.log(`Found ${invoices.length} invoices\n`);

  if (invoices.length === 0) {
    console.log('No invoices found for 2025.');
    return;
  }

  // Get all invoice line items
  const invoiceIds = invoices.map(i => i.id);
  console.log('Fetching invoice lines...');

  // Fetch in batches to avoid timeout
  const allLines = [];
  const batchSize = 500;

  for (let i = 0; i < invoiceIds.length; i += batchSize) {
    const batchIds = invoiceIds.slice(i, i + batchSize);
    const lines = await client.searchRead('account.move.line', [
      ['move_id', 'in', batchIds],
      ['product_id', '!=', false]  // Only lines with products
    ], [
      'move_id', 'product_id', 'quantity', 'price_unit', 'name'
    ], { limit: 50000 });
    allLines.push(...lines);
    console.log(`  Fetched ${allLines.length} lines so far...`);
  }

  console.log(`Total lines: ${allLines.length}\n`);

  // Get unique product IDs for SKU lookup
  const productIds = [...new Set(allLines.map(l => l.product_id?.[0]).filter(Boolean))];
  console.log(`Fetching ${productIds.length} products...`);

  const products = await client.read('product.product', productIds, ['id', 'default_code']);
  const productMap = {};
  for (const p of products) {
    productMap[p.id] = p.default_code || '';
  }

  // Get unique partner shipping IDs for country lookup
  const shippingIds = [...new Set(invoices.map(i => i.partner_shipping_id?.[0]).filter(Boolean))];
  console.log(`Fetching ${shippingIds.length} shipping addresses...`);

  let countryMap = {};
  if (shippingIds.length > 0) {
    const partners = await client.read('res.partner', shippingIds, ['id', 'country_id']);
    for (const p of partners) {
      countryMap[p.id] = p.country_id ? p.country_id[1] : '';
    }
  }

  // Build invoice lookup
  const invoiceMap = {};
  for (const inv of invoices) {
    invoiceMap[inv.id] = inv;
  }

  // Build the data rows
  console.log('\nBuilding export data...');
  const rows = [];

  for (const line of allLines) {
    const invoice = invoiceMap[line.move_id[0]];
    if (!invoice) continue;

    const productId = line.product_id?.[0];
    const sku = productId ? (productMap[productId] || '') : '';
    const shippingId = invoice.partner_shipping_id?.[0];
    const country = shippingId ? (countryMap[shippingId] || '') : '';
    const salesTeam = invoice.team_id ? invoice.team_id[1] : '';

    rows.push({
      number: invoice.name,
      date: invoice.invoice_date,
      sku: sku,
      quantity: line.quantity,
      unitPrice: line.price_unit,
      salesTeam: salesTeam,
      country: country
    });
  }

  // Sort by date desc, then number desc
  rows.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return b.number.localeCompare(a.number);
  });

  console.log(`Total rows: ${rows.length}\n`);

  // Create Excel file
  console.log('Creating Excel file...');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sales 2025');

  // Headers
  sheet.columns = [
    { header: 'Number', key: 'number', width: 22 },
    { header: 'Journal Entry/Invoice/Bill Date', key: 'date', width: 25 },
    { header: 'Product/Internal Reference', key: 'sku', width: 25 },
    { header: 'Quantity', key: 'quantity', width: 12 },
    { header: 'Unit Price', key: 'unitPrice', width: 12 },
    { header: 'Journal Entry/Sales Team', key: 'salesTeam', width: 28 },
    { header: 'Journal Entry/Delivery Address/Country', key: 'country', width: 35 }
  ];

  // Style header row
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9EAD3' }
  };

  // Add data rows
  for (const row of rows) {
    sheet.addRow(row);
  }

  // Format number columns
  sheet.getColumn('quantity').numFmt = '0.00';
  sheet.getColumn('unitPrice').numFmt = '0.00';

  // Save file
  const outputPath = path.join(__dirname, '../output/Export_sales_ODOO_2025.xlsx');
  await workbook.xlsx.writeFile(outputPath);
  console.log(`\nExport complete: ${outputPath}`);
  console.log(`Total rows: ${rows.length}`);

  // Also copy to Downloads
  const downloadsPath = path.join(process.env.HOME || '/Users/nimavakil', 'Downloads', 'Export_sales_ODOO_2025.xlsx');
  await workbook.xlsx.writeFile(downloadsPath);
  console.log(`Also saved to: ${downloadsPath}`);
}

exportSales2025().then(() => process.exit(0)).catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
