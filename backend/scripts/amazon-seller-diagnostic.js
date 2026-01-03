#!/usr/bin/env node
/**
 * Amazon Seller Orders Diagnostic Script
 *
 * Generates reports for:
 * 1. Duplicate Orders (same Amazon Order ID in Odoo multiple times)
 * 2. Duplicate Invoices (same order has multiple invoices)
 * 3. Orphan Invoices (invoices not linked to any order)
 * 4. "To Invoice" Orders Analysis
 *
 * Usage:
 *   node scripts/amazon-seller-diagnostic.js
 *   node scripts/amazon-seller-diagnostic.js --output /path/to/output
 *
 * Environment variables required:
 *   ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

// Configuration
const OUTPUT_DIR = process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : path.join(__dirname, '../reports');

const DATE_FROM = '2024-01-01';

async function main() {
  console.log('=== Amazon Seller Orders Diagnostic ===\n');

  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  // Run all diagnostics
  const report1 = await generateDuplicateOrdersReport(odoo);
  const report2 = await generateDuplicateInvoicesReport(odoo);
  const report3 = await generateOrphanInvoicesReport(odoo);
  const report4 = await generateToInvoiceAnalysisReport(odoo, report1);

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log('Duplicate Order Groups:', report1.length);
  console.log('Duplicate Invoice Groups:', report2.length);
  console.log('Orphan Invoices:', report3.length);
  console.log('Orders To Invoice:', report4.length);
  console.log('\nReports saved to:', OUTPUT_DIR);

  return {
    duplicateOrders: report1,
    duplicateInvoices: report2,
    orphanInvoices: report3,
    toInvoiceAnalysis: report4,
  };
}

/**
 * Report 1: Duplicate Orders
 */
async function generateDuplicateOrdersReport(odoo) {
  console.log('Generating Report 1: Duplicate Orders...');

  // Fetch all Amazon orders from 2024+
  let allOrders = [];
  let offset = 0;
  while (true) {
    const batch = await odoo.searchRead('sale.order',
      [
        '|', ['name', 'like', 'FBA%'], ['name', 'like', 'FBM%'],
        ['date_order', '>=', DATE_FROM],
      ],
      ['id', 'name', 'client_order_ref', 'invoice_status', 'state', 'date_order', 'amount_total'],
      { limit: 2000, offset }
    );
    if (batch.length === 0) break;
    allOrders = allOrders.concat(batch);
    offset += batch.length;
    if (batch.length < 2000) break;
  }
  console.log(`  Fetched ${allOrders.length} Amazon orders`);

  // Group by client_order_ref
  const byRef = {};
  for (const order of allOrders) {
    const ref = order.client_order_ref || 'NO_REF';
    if (!byRef[ref]) byRef[ref] = [];
    byRef[ref].push(order);
  }

  // Find duplicates
  const duplicates = [];
  for (const [amazonOrderId, orders] of Object.entries(byRef)) {
    if (orders.length > 1 && amazonOrderId !== 'NO_REF') {
      duplicates.push({
        amazonOrderId,
        odooOrders: orders.map(o => ({
          id: o.id,
          name: o.name,
          invoiceStatus: o.invoice_status,
          state: o.state,
          dateOrder: o.date_order,
          amountTotal: o.amount_total,
        })),
        count: orders.length,
      });
    }
  }

  console.log(`  Found ${duplicates.length} duplicate groups`);

  // Write CSV
  const csvLines = ['Amazon Order ID,Odoo Order IDs,Odoo Order Names,Invoice Statuses,States,Amounts'];
  for (const dup of duplicates) {
    csvLines.push([
      dup.amazonOrderId,
      dup.odooOrders.map(o => o.id).join('; '),
      dup.odooOrders.map(o => o.name).join('; '),
      dup.odooOrders.map(o => o.invoiceStatus).join('; '),
      dup.odooOrders.map(o => o.state).join('; '),
      dup.odooOrders.map(o => o.amountTotal).join('; '),
    ].join(','));
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'report1_duplicate_orders.csv'), csvLines.join('\n'));
  console.log('  Saved: report1_duplicate_orders.csv');

  return duplicates;
}

/**
 * Report 2: Duplicate Invoices
 */
async function generateDuplicateInvoicesReport(odoo) {
  console.log('Generating Report 2: Duplicate Invoices...');

  // Fetch all VCS invoices
  let allInvoices = [];
  let offset = 0;
  while (true) {
    const batch = await odoo.searchRead('account.move',
      [
        ['move_type', '=', 'out_invoice'],
        ['invoice_date', '>=', DATE_FROM],
        '|', '|', '|', '|', '|',
        ['journal_id.code', '=', 'VFR'],
        ['journal_id.code', '=', 'VDE'],
        ['journal_id.code', '=', 'VIT'],
        ['journal_id.code', '=', 'VBE'],
        ['journal_id.code', '=', 'VNL'],
        ['journal_id.code', '=', 'VPL'],
      ],
      ['id', 'name', 'invoice_origin', 'state', 'amount_total', 'invoice_date', 'journal_id'],
      { limit: 2000, offset }
    );
    if (batch.length === 0) break;
    allInvoices = allInvoices.concat(batch);
    offset += batch.length;
    if (batch.length < 2000) break;
  }
  console.log(`  Fetched ${allInvoices.length} VCS invoices`);

  // Group by invoice_origin (sale order name)
  const byOrigin = {};
  for (const inv of allInvoices) {
    const origin = inv.invoice_origin || 'NO_ORIGIN';
    if (origin === 'NO_ORIGIN' || origin === false) continue;
    if (!byOrigin[origin]) byOrigin[origin] = [];
    byOrigin[origin].push(inv);
  }

  // Find duplicates
  const duplicates = [];
  for (const [orderName, invoices] of Object.entries(byOrigin)) {
    if (invoices.length > 1) {
      // Determine if it's a real duplicate or shipment+return
      const allSameAmount = invoices.every(i => i.amount_total === invoices[0].amount_total);
      const hasPosted = invoices.some(i => i.state === 'posted');
      const hasDraft = invoices.some(i => i.state === 'draft');

      let actionNeeded = 'Review';
      if (allSameAmount && hasDraft) {
        actionNeeded = 'Delete draft duplicates';
      } else if (allSameAmount && !hasDraft) {
        actionNeeded = 'Cancel duplicate posted invoice';
      }

      duplicates.push({
        orderName,
        invoices: invoices.map(i => ({
          id: i.id,
          name: i.name,
          state: i.state,
          amountTotal: i.amount_total,
          invoiceDate: i.invoice_date,
          journal: i.journal_id ? i.journal_id[1] : 'N/A',
        })),
        count: invoices.length,
        actionNeeded,
      });
    }
  }

  console.log(`  Found ${duplicates.length} orders with multiple invoices`);

  // Write CSV
  const csvLines = ['Odoo Order,Invoice Count,Invoice IDs,Invoice Names,States,Amounts,Dates,Action Needed'];
  for (const dup of duplicates) {
    csvLines.push([
      dup.orderName,
      dup.count,
      dup.invoices.map(i => i.id).join('; '),
      dup.invoices.map(i => i.name).join('; '),
      dup.invoices.map(i => i.state).join('; '),
      dup.invoices.map(i => i.amountTotal).join('; '),
      dup.invoices.map(i => i.invoiceDate).join('; '),
      dup.actionNeeded,
    ].join(','));
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'report2_duplicate_invoices.csv'), csvLines.join('\n'));
  console.log('  Saved: report2_duplicate_invoices.csv');

  return duplicates;
}

/**
 * Report 3: Orphan Invoices
 */
async function generateOrphanInvoicesReport(odoo) {
  console.log('Generating Report 3: Orphan Invoices...');

  // Fetch VCS invoices without invoice_origin
  const orphanInvoices = await odoo.searchRead('account.move',
    [
      ['move_type', '=', 'out_invoice'],
      ['invoice_date', '>=', DATE_FROM],
      '|', ['invoice_origin', '=', false], ['invoice_origin', '=', ''],
      '|', '|', '|', '|', '|',
      ['journal_id.code', '=', 'VFR'],
      ['journal_id.code', '=', 'VDE'],
      ['journal_id.code', '=', 'VIT'],
      ['journal_id.code', '=', 'VBE'],
      ['journal_id.code', '=', 'VNL'],
      ['journal_id.code', '=', 'VPL'],
    ],
    ['id', 'name', 'state', 'amount_total', 'invoice_date', 'journal_id', 'partner_id', 'ref'],
    { limit: 10000 }
  );

  console.log(`  Found ${orphanInvoices.length} orphan invoices`);

  const report = orphanInvoices.map(inv => ({
    id: inv.id,
    name: inv.name,
    state: inv.state,
    amountTotal: inv.amount_total,
    invoiceDate: inv.invoice_date,
    journal: inv.journal_id ? inv.journal_id[1] : 'N/A',
    partner: inv.partner_id ? inv.partner_id[1] : 'N/A',
    ref: inv.ref || '',
  }));

  // Write CSV
  const csvLines = ['Invoice ID,Invoice Name,State,Amount,Date,Journal,Partner,Reference'];
  for (const inv of report) {
    csvLines.push([
      inv.id,
      inv.name,
      inv.state,
      inv.amountTotal,
      inv.invoiceDate,
      `"${inv.journal}"`,
      `"${inv.partner}"`,
      `"${inv.ref}"`,
    ].join(','));
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'report3_orphan_invoices.csv'), csvLines.join('\n'));
  console.log('  Saved: report3_orphan_invoices.csv');

  return report;
}

/**
 * Report 4: To Invoice Analysis
 */
async function generateToInvoiceAnalysisReport(odoo, duplicateOrders) {
  console.log('Generating Report 4: To Invoice Analysis...');

  // Fetch all "to invoice" Amazon orders
  let toInvoiceOrders = [];
  let offset = 0;
  while (true) {
    const batch = await odoo.searchRead('sale.order',
      [
        '|', ['name', 'like', 'FBA%'], ['name', 'like', 'FBM%'],
        ['invoice_status', '=', 'to invoice'],
        ['date_order', '>=', DATE_FROM],
      ],
      ['id', 'name', 'client_order_ref', 'state', 'date_order', 'amount_total', 'invoice_ids'],
      { limit: 2000, offset }
    );
    if (batch.length === 0) break;
    toInvoiceOrders = toInvoiceOrders.concat(batch);
    offset += batch.length;
    if (batch.length < 2000) break;
  }
  console.log(`  Fetched ${toInvoiceOrders.length} "to invoice" orders`);

  // Build duplicate lookup
  const duplicateLookup = new Map();
  for (const dup of duplicateOrders) {
    for (const order of dup.odooOrders) {
      duplicateLookup.set(order.id, dup);
    }
  }

  // Analyze each order
  const report = [];
  for (const order of toInvoiceOrders) {
    const dupGroup = duplicateLookup.get(order.id);
    const hasInvoicedDuplicate = dupGroup
      ? dupGroup.odooOrders.some(o => o.id !== order.id && o.invoiceStatus === 'invoiced')
      : false;
    const hasInvoice = order.invoice_ids && order.invoice_ids.length > 0;

    let recommendedAction = 'Needs invoicing';
    if (hasInvoicedDuplicate) {
      recommendedAction = 'Cancel (has invoiced duplicate)';
    } else if (hasInvoice) {
      recommendedAction = 'Check invoice link';
    } else if (order.state === 'cancel') {
      recommendedAction = 'Already cancelled';
    }

    report.push({
      id: order.id,
      name: order.name,
      amazonOrderId: order.client_order_ref,
      state: order.state,
      dateOrder: order.date_order,
      amountTotal: order.amount_total,
      hasInvoicedDuplicate,
      hasInvoice,
      recommendedAction,
      duplicateOrderIds: dupGroup ? dupGroup.odooOrders.filter(o => o.id !== order.id).map(o => o.name).join('; ') : '',
    });
  }

  // Sort by recommended action
  report.sort((a, b) => {
    const priority = { 'Cancel (has invoiced duplicate)': 0, 'Check invoice link': 1, 'Needs invoicing': 2, 'Already cancelled': 3 };
    return (priority[a.recommendedAction] || 99) - (priority[b.recommendedAction] || 99);
  });

  // Write CSV
  const csvLines = ['Order ID,Order Name,Amazon Order ID,State,Date,Amount,Has Invoiced Duplicate,Has Invoice,Recommended Action,Duplicate Order Names'];
  for (const r of report) {
    csvLines.push([
      r.id,
      r.name,
      r.amazonOrderId,
      r.state,
      r.dateOrder,
      r.amountTotal,
      r.hasInvoicedDuplicate ? 'Yes' : 'No',
      r.hasInvoice ? 'Yes' : 'No',
      r.recommendedAction,
      `"${r.duplicateOrderIds}"`,
    ].join(','));
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'report4_to_invoice_analysis.csv'), csvLines.join('\n'));
  console.log('  Saved: report4_to_invoice_analysis.csv');

  // Summary by action
  const byAction = {};
  for (const r of report) {
    byAction[r.recommendedAction] = (byAction[r.recommendedAction] || 0) + 1;
  }
  console.log('  Summary by recommended action:');
  for (const [action, count] of Object.entries(byAction)) {
    console.log(`    ${action}: ${count}`);
  }

  return report;
}

// Run if called directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
}

module.exports = { main };
