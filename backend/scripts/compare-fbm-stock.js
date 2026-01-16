#!/usr/bin/env node
/**
 * Compare FBM stock: Amazon vs Odoo CW
 * Shows what would change if we sync
 */
require('dotenv').config();
const { connectDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { getSellerClient } = require('../src/services/amazon/seller/SellerClient');

const LISTINGS_REPORT_TYPE = 'GET_MERCHANT_LISTINGS_DATA';

async function run() {
  console.error('Connecting...');
  await connectDb();

  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const sellerClient = getSellerClient();
  await sellerClient.init();
  const spClient = await sellerClient.getClient();

  // Step 1: Get Odoo CW stock
  console.error('Getting Odoo CW stock...');
  const warehouses = await odoo.searchRead('stock.warehouse',
    [['name', 'ilike', 'Central%']],
    ['id', 'name', 'lot_stock_id']
  );

  if (warehouses.length === 0) {
    throw new Error('Central Warehouse not found');
  }

  const centralLocationId = warehouses[0].lot_stock_id[0];

  const quants = await odoo.searchRead('stock.quant',
    [['location_id', '=', centralLocationId]],
    ['product_id', 'quantity', 'reserved_quantity'],
    { limit: 10000 }
  );

  const productIds = [...new Set(quants.map(q => q.product_id[0]))];
  const products = await odoo.searchRead('product.product',
    [['id', 'in', productIds]],
    ['id', 'default_code', 'name', 'active'],
    { limit: 10000 }
  );

  const productMap = {};
  for (const p of products) {
    if (p.default_code && p.active) {
      productMap[p.id] = { sku: p.default_code, name: p.name };
    }
  }

  // Build Odoo stock map
  const odooStock = {};
  for (const quant of quants) {
    const product = productMap[quant.product_id[0]];
    if (!product) continue;

    const available = Math.max(0, Math.floor(quant.quantity - (quant.reserved_quantity || 0)));
    if (!odooStock[product.sku]) {
      odooStock[product.sku] = { name: product.name, quantity: 0 };
    }
    odooStock[product.sku].quantity += available;
  }

  console.error(`Odoo CW: ${Object.keys(odooStock).length} SKUs`);

  // Step 2: Request listings report from Amazon (for DE marketplace)
  console.error('Requesting Amazon listings report (DE marketplace)...');

  // First check for any recent completed reports
  const reportsResponse = await spClient.callAPI({
    operation: 'reports.getReports',
    query: {
      reportTypes: [LISTINGS_REPORT_TYPE],
      processingStatuses: ['DONE'],
      pageSize: 10
    }
  });

  let reportDocumentId = null;

  if (reportsResponse.reports && reportsResponse.reports.length > 0) {
    // Use most recent completed report
    const latestReport = reportsResponse.reports[0];
    const reportAge = Date.now() - new Date(latestReport.createdTime).getTime();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    if (reportAge < maxAge) {
      console.error(`Using recent report: ${latestReport.reportId} (${Math.round(reportAge / 3600000)}h old)`);
      reportDocumentId = latestReport.reportDocumentId;
    }
  }

  if (!reportDocumentId) {
    // Request new report for single marketplace
    console.error('Requesting new listings report...');
    const createResponse = await spClient.callAPI({
      operation: 'reports.createReport',
      body: {
        reportType: LISTINGS_REPORT_TYPE,
        marketplaceIds: ['A1PA6795UKMFR9'] // DE marketplace only
      }
    });

    const reportId = createResponse.reportId;
    console.error(`Report requested: ${reportId}`);

    // Poll for completion (max 5 minutes)
    const startTime = Date.now();
    const timeout = 5 * 60 * 1000;

    while (Date.now() - startTime < timeout) {
      await new Promise(r => setTimeout(r, 10000)); // Wait 10 seconds

      const statusResponse = await spClient.callAPI({
        operation: 'reports.getReport',
        path: { reportId }
      });

      console.error(`Report status: ${statusResponse.processingStatus}`);

      if (statusResponse.processingStatus === 'DONE') {
        reportDocumentId = statusResponse.reportDocumentId;
        break;
      } else if (statusResponse.processingStatus === 'FATAL' || statusResponse.processingStatus === 'CANCELLED') {
        throw new Error(`Report failed: ${statusResponse.processingStatus}`);
      }
    }

    if (!reportDocumentId) {
      throw new Error('Report timed out');
    }
  }

  // Step 3: Download and parse report
  console.error('Downloading report...');
  const docResponse = await spClient.callAPI({
    operation: 'reports.getReportDocument',
    path: { reportDocumentId }
  });

  const reportData = await spClient.download(docResponse, { json: false });

  // Parse TSV
  const lines = reportData.toString().split('\n');
  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '_'));

  const amazonStock = {};
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t');
    if (values.length < 2) continue;

    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx]?.trim() || '';
    });

    const sku = row.seller_sku || row.sku;
    const quantity = parseInt(row.quantity) || 0;
    const fulfillmentChannel = row.fulfillment_channel || '';
    const status = row.status || '';
    const asin = row.asin1 || row.asin || '';
    const productName = row.item_name || row.product_name || row.title || '';

    // Only include FBM (DEFAULT channel) and Active listings
    if (sku && fulfillmentChannel === 'DEFAULT' && status === 'Active') {
      amazonStock[sku] = {
        quantity,
        asin,
        name: productName
      };
    }
  }

  console.error(`Amazon FBM: ${Object.keys(amazonStock).length} active SKUs`);

  // Step 4: Compare and build result
  const allSkus = new Set([...Object.keys(odooStock), ...Object.keys(amazonStock)]);
  const comparison = [];

  for (const sku of allSkus) {
    const odoo = odooStock[sku] || { name: '', quantity: 0 };
    const amazon = amazonStock[sku] || { quantity: 0, asin: '', name: '' };

    comparison.push({
      sku,
      name: odoo.name || amazon.name,
      asin: amazon.asin || '',
      odooQty: odoo.quantity,
      amazonQty: amazon.quantity,
      difference: odoo.quantity - amazon.quantity,
      inOdoo: !!odooStock[sku],
      inAmazon: !!amazonStock[sku]
    });
  }

  // Sort by absolute difference (biggest changes first)
  comparison.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

  // Output as JSON
  console.log(JSON.stringify(comparison));

  // Summary to stderr
  const changes = comparison.filter(c => c.difference !== 0);
  const increases = comparison.filter(c => c.difference > 0);
  const decreases = comparison.filter(c => c.difference < 0);
  const onlyOdoo = comparison.filter(c => c.inOdoo && !c.inAmazon);
  const onlyAmazon = comparison.filter(c => !c.inOdoo && c.inAmazon);

  console.error(`\n=== Summary ===`);
  console.error(`Total SKUs: ${comparison.length}`);
  console.error(`Would change: ${changes.length}`);
  console.error(`  - Increases: ${increases.length}`);
  console.error(`  - Decreases: ${decreases.length}`);
  console.error(`In Odoo only: ${onlyOdoo.length}`);
  console.error(`In Amazon only: ${onlyAmazon.length}`);
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
