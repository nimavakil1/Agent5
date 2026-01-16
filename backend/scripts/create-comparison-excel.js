#!/usr/bin/env node
/**
 * Create Excel from comparison JSON
 */
const XLSX = require('xlsx');
const fs = require('fs');

const data = JSON.parse(fs.readFileSync('/tmp/comparison.json', 'utf8'));

// Create worksheet with headers
const wsData = [
  ['Odoo SKU', 'Amazon SKU (Original)', 'Product Name', 'ASIN', 'Odoo CW Stock', 'Amazon FBM Stock', 'Difference', 'In Odoo', 'In Amazon', 'Status']
];

for (const item of data) {
  let status = '';
  if (item.inOdoo && !item.inAmazon) {
    status = 'Only in Odoo (not on Amazon FBM)';
  } else if (!item.inOdoo && item.inAmazon) {
    status = 'Only on Amazon (no Odoo stock)';
  } else if (item.difference > 0) {
    status = 'Will INCREASE on Amazon';
  } else if (item.difference < 0) {
    status = 'Will DECREASE on Amazon';
  } else {
    status = 'No change';
  }

  wsData.push([
    item.sku,                          // Resolved Odoo SKU
    item.amazonSku || '',              // Original Amazon SKU(s)
    item.name,
    item.asin || '',
    item.odooQty,
    item.amazonQty,
    item.difference,
    item.inOdoo ? 'Yes' : 'No',
    item.inAmazon ? 'Yes' : 'No',
    status
  ]);
}

// Calculate summary stats
const inBoth = data.filter(d => d.inOdoo && d.inAmazon);
const onlyOdoo = data.filter(d => d.inOdoo && !d.inAmazon);
const onlyAmazon = data.filter(d => !d.inOdoo && d.inAmazon);
const willChange = inBoth.filter(d => d.difference !== 0);
const willIncrease = inBoth.filter(d => d.difference > 0);
const willDecrease = inBoth.filter(d => d.difference < 0);

// Add summary section
wsData.push([]);
wsData.push(['=== SUMMARY ===']);
wsData.push(['Total SKUs analyzed:', data.length]);
wsData.push(['In both Odoo & Amazon FBM:', inBoth.length]);
wsData.push(['Only in Odoo (not FBM listing):', onlyOdoo.length]);
wsData.push(['Only on Amazon FBM (no Odoo stock):', onlyAmazon.length]);
wsData.push([]);
wsData.push(['=== FOR FBM LISTINGS ONLY ===']);
wsData.push(['Would change:', willChange.length]);
wsData.push(['Would increase:', willIncrease.length]);
wsData.push(['Would decrease:', willDecrease.length]);
wsData.push(['No change:', inBoth.length - willChange.length]);

const ws = XLSX.utils.aoa_to_sheet(wsData);

// Set column widths
ws['!cols'] = [
  { wch: 15 },   // Odoo SKU
  { wch: 20 },   // Amazon SKU (Original)
  { wch: 60 },   // Product Name
  { wch: 15 },   // ASIN
  { wch: 15 },   // Odoo CW Stock
  { wch: 18 },   // Amazon FBM Stock
  { wch: 12 },   // Difference
  { wch: 10 },   // In Odoo
  { wch: 12 },   // In Amazon
  { wch: 35 }    // Status
];

// Create workbook
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'FBM Stock Comparison');

// Save to /tmp (works on both local and server)
const filePath = '/tmp/FBM_Stock_Comparison_' + new Date().toISOString().split('T')[0] + '.xlsx';
XLSX.writeFile(wb, filePath);
console.log('Saved to:', filePath);
console.log('');
console.log('=== Summary ===');
console.log('Total SKUs:', data.length);
console.log('In both Odoo & Amazon FBM:', inBoth.length);
console.log('Only in Odoo:', onlyOdoo.length);
console.log('Only on Amazon:', onlyAmazon.length);
console.log('');
console.log('For FBM listings (in both):');
console.log('  Would change:', willChange.length);
console.log('  Would increase:', willIncrease.length);
console.log('  Would decrease:', willDecrease.length);
