/**
 * Generate detailed cleanup report for review
 * Creates a CSV file with all duplicates to be removed
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  console.log('Generating cleanup report...\n');

  const reportLines = [];
  const csvLines = [];

  // CSV Header
  csvLines.push([
    'Type',
    'Action',
    'Invoice ID',
    'Invoice Name',
    'State',
    'Sale Order (Origin)',
    'Amazon Order ID (Ref)',
    'Invoice Date',
    'Amount (EUR)',
    'Keep Invoice Name',
    'Keep Invoice ID',
    'Duplicate Group Size'
  ].join(','));

  // ==================== PART 1: Draft Duplicates ====================
  console.log('Fetching draft duplicates...');

  const draftInvoices = await odoo.searchRead('account.move',
    [
      ['state', '=', 'draft'],
      ['name', '=', '/'],
      ['move_type', '=', 'out_invoice'],
      ['invoice_origin', '!=', false]
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'amount_total', 'invoice_date', 'create_date'],
    { limit: 10000 }
  );

  // Get posted invoices for these origins
  const draftOrigins = [...new Set(draftInvoices.map(d => d.invoice_origin).filter(Boolean))];
  const postedForDrafts = await odoo.searchRead('account.move',
    [
      ['invoice_origin', 'in', draftOrigins],
      ['state', '=', 'posted'],
      ['move_type', '=', 'out_invoice']
    ],
    ['id', 'name', 'invoice_origin', 'amount_total'],
    { limit: 100000 }
  );

  // Create lookup
  const postedByOrigin = {};
  for (const p of postedForDrafts) {
    postedByOrigin[p.invoice_origin] = p;
  }

  // Add draft duplicates to report
  let draftCount = 0;
  for (const draft of draftInvoices) {
    const posted = postedByOrigin[draft.invoice_origin];
    if (posted) {
      draftCount++;
      csvLines.push([
        'Draft Duplicate',
        'DELETE',
        draft.id,
        `"${draft.name}"`,
        'draft',
        `"${draft.invoice_origin}"`,
        `"${draft.ref || ''}"`,
        draft.invoice_date || draft.create_date?.split(' ')[0] || '',
        draft.amount_total?.toFixed(2) || '0.00',
        `"${posted.name}"`,
        posted.id,
        '2'
      ].join(','));
    }
  }

  console.log(`Found ${draftCount} draft duplicates\n`);

  // ==================== PART 2: Posted Duplicates ====================
  console.log('Fetching posted duplicates...');

  const allPostedInvoices = await odoo.searchRead('account.move',
    [
      ['state', '=', 'posted'],
      ['move_type', '=', 'out_invoice'],
      ['invoice_origin', '!=', false]
    ],
    ['id', 'name', 'invoice_origin', 'ref', 'amount_total', 'invoice_date'],
    { limit: 200000 }
  );

  // Group by origin+amount+date
  const byKey = {};
  for (const inv of allPostedInvoices) {
    const key = `${inv.invoice_origin}|${inv.amount_total?.toFixed(2)}|${inv.invoice_date}`;
    if (!byKey[key]) {
      byKey[key] = [];
    }
    byKey[key].push(inv);
  }

  // Find duplicates
  let postedDupCount = 0;
  for (const [key, invs] of Object.entries(byKey)) {
    if (invs.length > 1) {
      // Sort by ID (oldest first) - keep the first
      invs.sort((a, b) => a.id - b.id);
      const keepInv = invs[0];

      for (const inv of invs.slice(1)) {
        postedDupCount++;
        csvLines.push([
          'Posted Duplicate',
          'CANCEL',
          inv.id,
          `"${inv.name}"`,
          'posted',
          `"${inv.invoice_origin}"`,
          `"${inv.ref || ''}"`,
          inv.invoice_date || '',
          inv.amount_total?.toFixed(2) || '0.00',
          `"${keepInv.name}"`,
          keepInv.id,
          invs.length
        ].join(','));
      }
    }
  }

  console.log(`Found ${postedDupCount} posted duplicates\n`);

  // ==================== Write Report ====================
  const outputPath = path.join(__dirname, '..', 'duplicate_invoices_cleanup_report.csv');
  fs.writeFileSync(outputPath, csvLines.join('\n'));

  console.log(`Report written to: ${outputPath}`);
  console.log(`\nTotal rows: ${csvLines.length - 1}`);
  console.log(`  - Draft duplicates to DELETE: ${draftCount}`);
  console.log(`  - Posted duplicates to CANCEL: ${postedDupCount}`);

  // Also create a summary text file
  const summaryPath = path.join(__dirname, '..', 'duplicate_invoices_cleanup_summary.txt');

  // Calculate totals
  let totalDraftValue = 0;
  let totalPostedValue = 0;

  for (const draft of draftInvoices) {
    if (postedByOrigin[draft.invoice_origin]) {
      totalDraftValue += draft.amount_total || 0;
    }
  }

  for (const [key, invs] of Object.entries(byKey)) {
    if (invs.length > 1) {
      for (const inv of invs.slice(1)) {
        totalPostedValue += inv.amount_total || 0;
      }
    }
  }

  const summary = `
DUPLICATE INVOICE CLEANUP REPORT
================================
Generated: ${new Date().toISOString()}

SUMMARY
-------
Draft duplicates to DELETE: ${draftCount}
  - These are draft invoices (name="/") where a posted invoice already exists
  - Total value: €${totalDraftValue.toFixed(2)}

Posted duplicates to CANCEL: ${postedDupCount}
  - These are posted invoices that are exact duplicates (same origin + amount + date)
  - Total over-invoiced value: €${totalPostedValue.toFixed(2)}

TOTAL DUPLICATES: ${draftCount + postedDupCount}
TOTAL OVER-INVOICED VALUE: €${(totalDraftValue + totalPostedValue).toFixed(2)}


HOW TO VERIFY
-------------
1. Open the CSV file: duplicate_invoices_cleanup_report.csv
2. For each row:
   - "Invoice Name" is the duplicate to be removed
   - "Keep Invoice Name" is the invoice that will remain
   - "Sale Order (Origin)" shows which order both invoices belong to
3. You can check in Odoo:
   - Go to Accounting > Customers > Invoices
   - Filter by the Invoice Name or Sale Order
   - Verify that there are indeed duplicate invoices


WHAT THE CLEANUP WILL DO
------------------------
1. Draft duplicates: Delete directly (they're not posted, so no accounting impact)
2. Posted duplicates: Reset to draft, then cancel (preserves audit trail)

To execute cleanup:
  node scripts/cleanup-all-duplicates.js --execute


SAMPLE DUPLICATES (first 20 posted)
-----------------------------------
`;

  // Add sample data
  let sampleCount = 0;
  const samples = [];
  for (const [key, invs] of Object.entries(byKey)) {
    if (invs.length > 1 && sampleCount < 20) {
      invs.sort((a, b) => a.id - b.id);
      samples.push(`
Order: ${invs[0].invoice_origin}
Date: ${invs[0].invoice_date} | Amount: €${invs[0].amount_total?.toFixed(2)}
Invoices (${invs.length} total - KEEP first, CANCEL rest):
${invs.map((inv, i) => `  ${i === 0 ? 'KEEP  ' : 'CANCEL'} ${inv.name} (ID: ${inv.id})`).join('\n')}
`);
      sampleCount++;
    }
  }

  fs.writeFileSync(summaryPath, summary + samples.join('\n'));

  console.log(`Summary written to: ${summaryPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
