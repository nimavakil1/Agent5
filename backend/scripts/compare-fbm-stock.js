#!/usr/bin/env node
/**
 * Compare FBM stock: Amazon vs Odoo CW
 * Shows what would change if we sync
 * Uses SkuResolver to map Amazon SKU → Odoo SKU
 */
require('dotenv').config();
const { connectDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { getSellerClient } = require('../src/services/amazon/seller/SellerClient');
const { skuResolver } = require('../src/services/amazon/SkuResolver');

const LISTINGS_REPORT_TYPE = 'GET_MERCHANT_LISTINGS_DATA';

async function run() {
  console.error('Connecting...');
  await connectDb();

  // Load SKU resolver mappings
  await skuResolver.load();

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

  // Step 2: Get listings reports from ALL EU marketplaces
  const EU_MARKETPLACES = {
    'A1PA6795UKMFR9': 'DE',
    'A1RKKUPIHCS9HS': 'ES',
    'A13V1IB3VIYZZH': 'FR',  // Note: Account-specific FR ID (not standard A13V1IB3VIYBER)
    'A1F83G8C2ARO7P': 'UK',
    'APJ6JRA9NG5V4': 'IT',
    'A1805IZSGTT6HS': 'NL',
    'A2NODRKZP88ZB9': 'SE',
    'A1C3SOZRARQ6R3': 'PL',
    'AMEN7PMS3EDWL': 'BE'
  };

  console.error('Getting Amazon listings reports for all EU marketplaces...');

  // Get all recent reports
  const reportsResponse = await spClient.callAPI({
    operation: 'reports.getReports',
    query: {
      reportTypes: [LISTINGS_REPORT_TYPE],
      processingStatuses: ['DONE'],
      pageSize: 50
    }
  });

  // Find most recent report for each marketplace
  const marketplaceReports = {};
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  for (const report of (reportsResponse.reports || [])) {
    const mpId = report.marketplaceIds?.[0];
    if (!mpId || !EU_MARKETPLACES[mpId]) continue;

    const reportAge = Date.now() - new Date(report.createdTime).getTime();
    if (reportAge > maxAge) continue;

    // Keep only the most recent per marketplace
    if (!marketplaceReports[mpId] || new Date(report.createdTime) > new Date(marketplaceReports[mpId].createdTime)) {
      marketplaceReports[mpId] = report;
    }
  }

  console.error(`Found recent reports for: ${Object.keys(marketplaceReports).map(m => EU_MARKETPLACES[m]).join(', ')}`);

  // Download and parse all reports
  const amazonStock = {};
  let totalFbm = 0;
  let totalFba = 0;

  for (const [mpId, report] of Object.entries(marketplaceReports)) {
    const mpName = EU_MARKETPLACES[mpId];
    console.error(`Processing ${mpName} report...`);

    const docResponse = await spClient.callAPI({
      operation: 'reports.getReportDocument',
      path: { reportDocumentId: report.reportDocumentId }
    });

    const reportData = await spClient.download(docResponse, { json: false });
    const lines = reportData.toString().split('\n');
    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_'));

    let mpFbm = 0;
    let mpFba = 0;

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      if (values.length < 2) continue;

      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx]?.trim() || '';
      });

      const sku = row['seller_sku'] || row['seller-sku'] || '';
      const quantity = parseInt(row['quantity']) || 0;
      const fulfillmentChannel = row['fulfillment_channel'] || row['fulfillment-channel'] || '';
      const asin = row['asin1'] || '';
      const productName = row['item_name'] || row['item-name'] || '';

      if (!sku) continue;

      if (fulfillmentChannel === 'AMAZON_EU' || fulfillmentChannel === 'AMAZON_NA' || fulfillmentChannel.startsWith('AMAZON')) {
        mpFba++;
      } else if (fulfillmentChannel === 'DEFAULT') {
        mpFbm++;
        // For FBM, use the SKU as key - if same SKU in multiple marketplaces, keep the one with data
        if (!amazonStock[sku] || !amazonStock[sku].name) {
          amazonStock[sku] = {
            quantity,
            asin,
            name: productName,
            channel: fulfillmentChannel,
            marketplaces: [mpName]
          };
        } else {
          // Same SKU in multiple marketplaces - add marketplace to list
          if (!amazonStock[sku].marketplaces.includes(mpName)) {
            amazonStock[sku].marketplaces.push(mpName);
          }
        }
      }
    }

    console.error(`  ${mpName}: ${mpFbm} FBM, ${mpFba} FBA`);
    totalFbm += mpFbm;
    totalFba += mpFba;
  }

  console.error(`Total across all marketplaces: ${totalFbm} FBM, ${totalFba} FBA listings`);
  console.error(`Unique FBM SKUs: ${Object.keys(amazonStock).length}`);

  // Step 4: Resolve Amazon SKUs using SkuResolver
  console.error('Resolving Amazon SKUs...');
  const resolvedAmazonStock = {};
  const amazonSkuToOriginal = {}; // Map resolved SKU back to original Amazon SKU

  for (const [originalSku, data] of Object.entries(amazonStock)) {
    const resolution = skuResolver.resolve(originalSku);
    const resolvedSku = resolution.odooSku || originalSku;

    // Store the mapping
    if (!amazonSkuToOriginal[resolvedSku]) {
      amazonSkuToOriginal[resolvedSku] = [];
    }
    amazonSkuToOriginal[resolvedSku].push({
      originalSku,
      matchType: resolution.matchType
    });

    // Aggregate stock for resolved SKU
    if (!resolvedAmazonStock[resolvedSku]) {
      resolvedAmazonStock[resolvedSku] = {
        quantity: 0,
        asin: data.asin,
        name: data.name,
        originalSkus: [],
        marketplaces: new Set()
      };
    }
    resolvedAmazonStock[resolvedSku].quantity += data.quantity;
    resolvedAmazonStock[resolvedSku].originalSkus.push(originalSku);
    // Add marketplaces from this SKU
    if (data.marketplaces) {
      data.marketplaces.forEach(mp => resolvedAmazonStock[resolvedSku].marketplaces.add(mp));
    }
  }

  // Step 5: Compare and build result
  const allSkus = new Set([...Object.keys(odooStock), ...Object.keys(resolvedAmazonStock)]);
  const comparison = [];

  for (const sku of allSkus) {
    const odoo = odooStock[sku] || { name: '', quantity: 0 };
    const amazon = resolvedAmazonStock[sku] || { quantity: 0, asin: '', name: '', originalSkus: [], marketplaces: new Set() };

    comparison.push({
      sku,                              // Resolved/Odoo SKU
      amazonSku: amazon.originalSkus.join(', ') || '',  // Original Amazon SKU(s)
      marketplaces: [...(amazon.marketplaces || [])].join(', '),  // Which marketplaces
      name: odoo.name || amazon.name,
      asin: amazon.asin || '',
      odooQty: odoo.quantity,
      amazonQty: amazon.quantity,
      difference: odoo.quantity - amazon.quantity,
      inOdoo: !!odooStock[sku],
      inAmazon: !!resolvedAmazonStock[sku]
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
