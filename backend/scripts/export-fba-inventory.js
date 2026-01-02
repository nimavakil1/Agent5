#!/usr/bin/env node
/**
 * Export FBA Inventory to Excel
 *
 * Fetches all FBA inventory from Amazon Seller Central and exports to Excel
 * with columns: SKU, ASIN, FC Country Code, Available QTY
 *
 * Usage: node scripts/export-fba-inventory.js
 */

require('dotenv').config();
const SellingPartner = require('amazon-sp-api');
const ExcelJS = require('exceljs');
const path = require('path');

// FC code to country mapping (from FbaInventoryReportParser.js)
const FC_COUNTRY_MAP = {
  // Germany
  'BER1': 'DE', 'BER2': 'DE', 'BER3': 'DE',
  'CGN1': 'DE', 'CGN2': 'DE',
  'DUS2': 'DE', 'DUS4': 'DE',
  'DTM1': 'DE', 'DTM2': 'DE',
  'EDE4': 'DE', 'EDE5': 'DE',
  'FRA1': 'DE', 'FRA3': 'DE', 'FRA7': 'DE',
  'HAM2': 'DE',
  'LEJ1': 'DE', 'LEJ2': 'DE',
  'MUC3': 'DE',
  'STR1': 'DE',
  // France
  'LIL1': 'FR', 'ORY1': 'FR', 'ORY4': 'FR',
  'CDG5': 'FR', 'MRS1': 'FR', 'LYS1': 'FR',
  'ETZ1': 'FR', 'BVA1': 'FR', 'SXB1': 'FR',
  // Italy
  'MXP5': 'IT', 'FCO1': 'IT',
  // Spain
  'BCN1': 'ES', 'MAD4': 'ES', 'MAD6': 'ES',
  // Poland
  'WRO2': 'PL', 'WRO5': 'PL', 'KTW1': 'PL', 'POZ1': 'PL',
  // Czech Republic
  'PRG1': 'CZ', 'PRG2': 'CZ',
  // Netherlands
  'AMS1': 'NL',
  // UK
  'BHX1': 'GB', 'BHX2': 'GB', 'BHX3': 'GB', 'BHX4': 'GB',
  'EDI4': 'GB', 'EUK5': 'GB',
  'LBA1': 'GB', 'LBA2': 'GB',
  'LCY2': 'GB', 'LTN1': 'GB', 'LTN2': 'GB', 'LTN4': 'GB',
  'MAN1': 'GB', 'MAN2': 'GB', 'MAN3': 'GB',
  'MME1': 'GB', 'GLA1': 'GB',
  // Sweden
  'GOT1': 'SE',
};

// All EU Marketplace IDs
const MARKETPLACE_IDS = [
  'A13V1IB3VIYZZH', // FR
  'A1805IZSGTT6HS', // NL
  'A1C3SOZRARQ6R3', // PL
  'A1PA6795UKMFR9', // DE
  'A1RKKUPIHCS9HS', // ES
  'A2NODRKZP88ZB9', // SE
  'A33AVAJ2PDY3EV', // TR
  'AMEN7PMS3EDWL',  // BE
  'APJ6JRA9NG5V4',  // IT
  'A1F83G8C2ARO7P', // UK
  'A28R8C7NBKEWEA', // IE
  'A17E79C6D8DWNP', // SA
  'A2VIGQ35RCS4UG', // AE
];

// Country code from marketplace ID
const MARKETPLACE_TO_COUNTRY = {
  'A13V1IB3VIYZZH': 'FR',
  'A1805IZSGTT6HS': 'NL',
  'A1C3SOZRARQ6R3': 'PL',
  'A1PA6795UKMFR9': 'DE',
  'A1RKKUPIHCS9HS': 'ES',
  'A2NODRKZP88ZB9': 'SE',
  'A33AVAJ2PDY3EV': 'TR',
  'AMEN7PMS3EDWL': 'BE',
  'APJ6JRA9NG5V4': 'IT',
  'A1F83G8C2ARO7P': 'GB',
  'A28R8C7NBKEWEA': 'IE',
  'A17E79C6D8DWNP': 'SA',
  'A2VIGQ35RCS4UG': 'AE',
};

async function main() {
  console.log('=== FBA Inventory Export ===\n');

  // Validate credentials
  const refreshToken = process.env.AMAZON_SELLER_REFRESH_TOKEN;
  const clientId = process.env.AMAZON_SP_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_SP_LWA_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    console.error('Missing Amazon SP-API credentials in .env');
    console.error('Required: AMAZON_SELLER_REFRESH_TOKEN, AMAZON_SP_LWA_CLIENT_ID, AMAZON_SP_LWA_CLIENT_SECRET');
    process.exit(1);
  }

  // Initialize SP-API client
  console.log('Connecting to Amazon Seller Central...');
  const spClient = new SellingPartner({
    region: 'eu',
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: clientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret
    },
    options: {
      auto_request_tokens: true,
      auto_request_throttled: true,
      version_fallback: true
    }
  });

  // Fetch FBA inventory with FC-level breakdown using reports
  console.log('Requesting FBA Inventory report with FC breakdown...\n');

  let allInventory = [];

  try {
    // Request GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA report
    console.log('  Creating report request...');
    const createResponse = await spClient.callAPI({
      operation: 'reports.createReport',
      body: {
        reportType: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA',
        marketplaceIds: ['A1PA6795UKMFR9'] // DE as primary for Pan-EU
      }
    });

    const reportId = createResponse.reportId;
    console.log(`  Report ID: ${reportId}`);

    // Poll for completion
    const maxWaitMs = 5 * 60 * 1000;
    const startTime = Date.now();
    let reportDocId = null;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, 10000));

      const statusResponse = await spClient.callAPI({
        operation: 'reports.getReport',
        path: { reportId }
      });

      const status = statusResponse.processingStatus;
      console.log(`  Status: ${status}`);

      if (status === 'DONE') {
        reportDocId = statusResponse.reportDocumentId;
        break;
      } else if (status === 'FATAL' || status === 'CANCELLED') {
        throw new Error(`Report failed: ${status}`);
      }
    }

    if (!reportDocId) {
      throw new Error('Report timed out');
    }

    // Download report
    console.log('  Downloading report...');
    const docResponse = await spClient.callAPI({
      operation: 'reports.getReportDocument',
      path: { reportDocumentId: reportDocId }
    });

    const reportData = await spClient.download(docResponse, { json: false });

    // Parse the report
    allInventory = parseInventoryReport(reportData.toString());
    console.log(`  Parsed ${allInventory.length} inventory records`);

  } catch (error) {
    console.error('Report method failed:', error.message);
    console.log('\nFalling back to API method...');

    // Fallback: fetch once from DE marketplace (Pan-EU primary)
    allInventory = await fetchInventoryFromAPI(spClient);
  }

  console.log(`\nTotal items: ${allInventory.length}`);

  if (allInventory.length === 0) {
    console.log('No FBA inventory found.');
    process.exit(0);
  }

  // Export directly to Excel - we already have country-level data
  console.log('\nExporting to Excel...');
  const outputPath = await exportToExcel(allInventory);

  console.log(`\n✓ Export complete: ${outputPath}`);
  console.log(`  Total rows: ${allInventory.length}`);
}

/**
 * Parse FBA Inventory Report (TSV format)
 * GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA format
 *
 * For Pan-EU FBA, creates separate rows for local (DE) and remote (other EU) inventory
 */
function parseInventoryReport(data) {
  const lines = data.split('\n');
  const inventory = [];

  if (lines.length < 2) return inventory;

  // Parse header - normalize column names
  const rawHeaders = lines[0].split('\t');
  const headers = rawHeaders.map(h => h.trim().toLowerCase().replace(/[-\s]+/g, '_'));

  console.log(`  Columns found: ${headers.length}`);

  // Check if we have local/remote breakdown
  const hasLocalRemote = headers.includes('afn_fulfillable_quantity_local') &&
                         headers.includes('afn_fulfillable_quantity_remote');

  console.log(`  Has local/remote breakdown: ${hasLocalRemote}`);

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t');
    if (values.length < 3) continue;

    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx]?.trim() || '';
    });

    const sku = row.sku || row.seller_sku || '';
    if (!sku) continue;

    const asin = row.asin || '';

    if (hasLocalRemote) {
      // Split into local (DE) and remote (other EU) entries
      const localQty = parseInt(row.afn_fulfillable_quantity_local || 0, 10);
      const remoteQty = parseInt(row.afn_fulfillable_quantity_remote || 0, 10);

      if (localQty > 0) {
        inventory.push({
          sku: sku,
          asin: asin,
          countryCode: 'DE', // Local = Germany FCs
          quantity: localQty,
        });
      }

      if (remoteQty > 0) {
        inventory.push({
          sku: sku,
          asin: asin,
          countryCode: 'EU-Remote', // Remote = other EU FCs (FR, PL, CZ, etc.)
          quantity: remoteQty,
        });
      }

      // If both are 0 but there's total inventory, add as EU
      if (localQty === 0 && remoteQty === 0) {
        const totalQty = parseInt(row.afn_fulfillable_quantity || 0, 10);
        if (totalQty > 0) {
          inventory.push({
            sku: sku,
            asin: asin,
            countryCode: 'EU',
            quantity: totalQty,
          });
        }
      }
    } else {
      // No local/remote breakdown - use total
      const qty = parseInt(row.afn_fulfillable_quantity || 0, 10);
      if (qty > 0) {
        inventory.push({
          sku: sku,
          asin: asin,
          countryCode: 'EU',
          quantity: qty,
        });
      }
    }
  }

  return inventory;
}

/**
 * Fallback: Fetch inventory from API (single marketplace, no duplicates)
 */
async function fetchInventoryFromAPI(spClient) {
  const inventory = [];
  let nextToken = null;

  console.log('  Fetching from DE marketplace (Pan-EU primary)...');

  do {
    const params = {
      granularityType: 'Marketplace',
      granularityId: 'A1PA6795UKMFR9', // DE
      marketplaceIds: ['A1PA6795UKMFR9'],
      details: true
    };

    if (nextToken) {
      params.nextToken = nextToken;
    }

    const response = await spClient.callAPI({
      operation: 'fbaInventory.getInventorySummaries',
      query: params
    });

    const summaries = response.inventorySummaries || [];

    for (const item of summaries) {
      const qty = item.inventoryDetails?.fulfillableQuantity || 0;
      if (qty > 0) { // Only include items with stock
        inventory.push({
          sku: item.sellerSku || '',
          asin: item.asin || '',
          countryCode: 'EU', // Pan-EU pool
          quantity: qty,
        });
      }
    }

    nextToken = response.nextToken;
    if (nextToken) {
      await new Promise(r => setTimeout(r, 500));
    }
  } while (nextToken);

  console.log(`  Fetched ${inventory.length} items`);
  return inventory;
}

/**
 * Merge inventory summaries with FC-level data
 */
function mergeInventoryData(summaries, fcData) {
  // If we have FC-level data, use that as the primary source
  if (fcData && fcData.length > 0) {
    console.log(`  Merging with ${fcData.length} FC-level records`);

    // Create lookup from summaries for ASIN
    const asinLookup = {};
    for (const item of summaries) {
      if (item.asin) {
        asinLookup[item.sku] = item.asin;
      }
    }

    // Add ASIN to FC data where missing
    return fcData.map(item => ({
      ...item,
      asin: item.asin || asinLookup[item.sku] || ''
    }));
  }

  // No FC data - use summaries with unknown FC
  console.log('  No FC-level data available, using marketplace-level inventory');
  return summaries.map(item => ({
    sku: item.sku,
    asin: item.asin,
    fnsku: item.fnsku,
    fc: '',
    countryCode: 'EU', // Pan-EU pool
    quantity: item.fulfillableQuantity,
  }));
}

/**
 * Export inventory data to Excel
 */
async function exportToExcel(inventory) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Agent5 FBA Inventory Export';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('FBA Inventory');

  // Define columns
  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 25 },
    { header: 'ASIN', key: 'asin', width: 15 },
    { header: 'FC Country Code', key: 'countryCode', width: 18 },
    { header: 'Available QTY', key: 'quantity', width: 15 },
  ];

  // Style header row
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };

  // Add data rows
  for (const item of inventory) {
    sheet.addRow({
      sku: item.sku,
      asin: item.asin,
      countryCode: item.countryCode || item.fc || '',
      quantity: item.quantity
    });
  }

  // Add filters
  sheet.autoFilter = {
    from: 'A1',
    to: 'D1'
  };

  // Freeze header row
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Format quantity column as number
  sheet.getColumn('quantity').numFmt = '0';

  // Generate filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `FBA_Inventory_${timestamp}.xlsx`;
  const outputPath = path.join(process.cwd(), filename);

  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

// Run
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
