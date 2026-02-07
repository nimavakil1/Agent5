#!/usr/bin/env node
/**
 * Reconcile VCS invoices with Amazon settlement data
 *
 * Matches settlement order IDs to VCS invoices in Odoo and reconciles
 * their receivable (400102XX) move lines so invoices show as "paid".
 *
 * Usage:
 *   node scripts/reconcile-vcs-invoices.js                                  # Preview (dry run)
 *   node scripts/reconcile-vcs-invoices.js --execute                        # Actually reconcile
 *   node scripts/reconcile-vcs-invoices.js --settlement=26470813822         # Single settlement
 *   node scripts/reconcile-vcs-invoices.js --execute --settlement=26470813822
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { connectDb, getDb } = require('../src/db');
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');
const { VcsReconciliationService } = require('../src/services/accounting/VcsReconciliationService');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const settlementArg = args.find(a => a.startsWith('--settlement='));
  const settlementId = settlementArg ? settlementArg.split('=')[1] : null;
  const verbose = args.includes('--verbose') || args.includes('-v');

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage:');
    console.log('  node scripts/reconcile-vcs-invoices.js                              # Preview (dry run)');
    console.log('  node scripts/reconcile-vcs-invoices.js --execute                    # Actually reconcile');
    console.log('  node scripts/reconcile-vcs-invoices.js --settlement=<ID>            # Single settlement');
    console.log('  node scripts/reconcile-vcs-invoices.js --execute --settlement=<ID>  # Execute single');
    console.log('  node scripts/reconcile-vcs-invoices.js --verbose                    # Show per-order details');
    process.exit(0);
  }

  console.log('=== VCS Invoice Reconciliation ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (preview only)' : 'EXECUTE (will reconcile in Odoo)'}`);
  if (settlementId) console.log(`Settlement: ${settlementId}`);
  console.log('');

  // Connect to MongoDB and Odoo
  await connectDb();
  const db = getDb();
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to MongoDB and Odoo\n');

  const service = new VcsReconciliationService(odoo);

  let summary;
  if (settlementId) {
    // Single settlement
    const result = await service.reconcileSettlement(db, settlementId, { dryRun });
    summary = {
      settlements: 1,
      totalOrders: result.totalOrders || 0,
      matched: result.matched || 0,
      reconciled: result.reconciled || 0,
      unmatched: result.unmatched || 0,
      alreadyReconciled: result.alreadyReconciled || 0,
      posted: result.posted || 0,
      errors: (result.errors || []).length,
      results: [result],
    };
  } else {
    // All settlements
    summary = await service.reconcileAll(db, { dryRun });
  }

  // Print summary
  console.log('\n=== SUMMARY ===');
  console.log(`Settlements processed: ${summary.settlements}`);
  console.log(`Total orders:          ${summary.totalOrders}`);
  console.log(`Matched to invoice:    ${summary.matched}`);
  console.log(`Reconciled:            ${summary.reconciled}`);
  console.log(`Already reconciled:    ${summary.alreadyReconciled || 0}`);
  console.log(`Invoices posted:       ${summary.posted || 0}`);
  console.log(`Unmatched:             ${summary.unmatched}`);
  console.log(`Errors:                ${summary.errors}`);

  // Print verbose per-order details
  if (verbose && summary.results) {
    console.log('\n=== DETAILS ===');
    for (const result of summary.results) {
      if (!result.details) continue;
      console.log(`\nSettlement ${result.settlementId}:`);
      for (const d of result.details) {
        const statusIcon = d.status === 'reconciled' ? '+' :
                           d.status === 'matched' ? '~' :
                           d.status === 'already_reconciled' ? '=' :
                           d.status === 'error' ? '!' : '-';
        const extra = d.invoiceName ? ` -> ${d.invoiceName}` : '';
        const reason = d.reason ? ` (${d.reason})` : '';
        const err = d.error ? ` ERROR: ${d.error}` : '';
        console.log(`  [${statusIcon}] ${d.orderId}${extra} [${d.status}]${reason}${err}`);
      }
    }
  }

  // Print unmatched orders if any
  if (summary.unmatched > 0 && !verbose) {
    console.log('\nTip: Run with --verbose to see per-order details including unmatched orders');
  }

  if (dryRun && summary.matched > 0) {
    console.log('\nThis was a DRY RUN. Run with --execute to actually reconcile in Odoo.');
  }

  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
