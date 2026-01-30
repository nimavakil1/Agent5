#!/usr/bin/env node
/**
 * Clear the ref field on reversed invoices so VCS processing can create new invoices
 *
 * These 4 invoices were reversed with credit notes, but the `ref` field still contains
 * the Amazon order ID, causing the findExistingInvoice method to detect them.
 *
 * Usage:
 *   node src/scripts/clearRefOnReversedInvoices.js --dry-run    # Preview changes
 *   node src/scripts/clearRefOnReversedInvoices.js --fix        # Apply fixes
 */

require('dotenv').config();
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

// Invoices that were reversed but still detected via ref field
const INVOICES_TO_CLEAR = [
  { invoiceId: 360258, invoiceName: 'VOS/2025/12/03696', amazonOrderId: '402-3394787-4841132' },
  { invoiceId: 360261, invoiceName: 'VOS/2025/12/03757', amazonOrderId: '408-7203120-7093146' },
  { invoiceId: 360262, invoiceName: 'VOS/2025/12/03709', amazonOrderId: '403-4696052-1501900' },
  { invoiceId: 360264, invoiceName: 'VOS/2025/12/03708', amazonOrderId: '403-4652236-2349159' },
];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fix = args.includes('--fix');

  if (!dryRun && !fix) {
    console.log('Usage:');
    console.log('  node src/scripts/clearRefOnReversedInvoices.js --dry-run    # Preview changes');
    console.log('  node src/scripts/clearRefOnReversedInvoices.js --fix        # Apply fixes');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Clear Ref Field on Reversed Invoices - ${dryRun ? 'DRY RUN' : 'APPLYING FIXES'}`);
  console.log(`${'='.repeat(60)}\n`);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  let cleared = 0;
  let errors = 0;

  for (const inv of INVOICES_TO_CLEAR) {
    console.log(`\nInvoice: ${inv.invoiceName} (ID: ${inv.invoiceId})`);
    console.log(`  Amazon Order: ${inv.amazonOrderId}`);

    try {
      // Get current invoice data
      const invoices = await odoo.searchRead('account.move',
        [['id', '=', inv.invoiceId]],
        ['id', 'name', 'ref', 'state']
      );

      if (invoices.length === 0) {
        console.log(`  ERROR: Invoice not found in Odoo`);
        errors++;
        continue;
      }

      const invoice = invoices[0];
      console.log(`  Current ref: ${invoice.ref || '(empty)'}`);
      console.log(`  State: ${invoice.state}`);

      if (!invoice.ref) {
        console.log(`  SKIP: ref field is already empty`);
        continue;
      }

      if (fix) {
        // Clear the ref field
        console.log(`  Clearing ref field...`);
        await odoo.execute('account.move', 'write', [[inv.invoiceId], {
          ref: false,
        }]);
        console.log(`  Cleared successfully.`);
        cleared++;
      } else {
        console.log(`  [DRY RUN] Would clear ref field`);
        cleared++;
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Summary:`);
  console.log(`  Invoices ${dryRun ? 'to clear' : 'cleared'}: ${cleared}`);
  if (errors > 0) {
    console.log(`  Errors: ${errors}`);
  }
  console.log(`${'='.repeat(60)}\n`);

  if (dryRun) {
    console.log('This was a dry run. Run with --fix to apply changes.');
  } else {
    console.log('Now you can re-run the VCS invoice processing for these 4 orders.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
