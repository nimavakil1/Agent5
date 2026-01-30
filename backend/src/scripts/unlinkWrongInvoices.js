#!/usr/bin/env node
/**
 * Unlink invoices from wrong orders
 *
 * This script removes the link between invoices and the wrong sale orders
 * without cancelling the invoices.
 *
 * Usage:
 *   node src/scripts/unlinkWrongInvoices.js --dry-run    # Preview changes
 *   node src/scripts/unlinkWrongInvoices.js --fix        # Apply fixes
 */

require('dotenv').config();
const { OdooDirectClient } = require('../core/agents/integrations/OdooMCP');

// The 9 invoices to unlink (from the wrong orders)
const INVOICES_TO_UNLINK = [
  { invoiceId: 360101, invoiceName: 'VOS/2025/12/03508', wrongOrder: 'S14720', amazonOrderId: '402-1160083-6363529' },
  { invoiceId: 360103, invoiceName: 'VOS/2025/12/03519', wrongOrder: 'S14716', amazonOrderId: '405-7031124-1753168' },
  { invoiceId: 360248, invoiceName: 'VOS/2025/12/03607', wrongOrder: 'S14709', amazonOrderId: '303-7993887-6359566' },
  { invoiceId: 360254, invoiceName: 'VBE/2025/12/02184', wrongOrder: 'S14722', amazonOrderId: '407-6214261-6623568' },
  { invoiceId: 360255, invoiceName: 'VBE/2025/12/02181', wrongOrder: 'S14718', amazonOrderId: '404-3134498-6558767' },
  { invoiceId: 360258, invoiceName: 'VOS/2025/12/03696', wrongOrder: 'S14711', amazonOrderId: '402-3394787-4841132' },
  { invoiceId: 360261, invoiceName: 'VOS/2025/12/03757', wrongOrder: 'S14726', amazonOrderId: '408-7203120-7093146' },
  { invoiceId: 360262, invoiceName: 'VOS/2025/12/03709', wrongOrder: 'S14713', amazonOrderId: '403-4696052-1501900' },
  { invoiceId: 360264, invoiceName: 'VOS/2025/12/03708', wrongOrder: 'S14724', amazonOrderId: '403-4652236-2349159' },
];

async function unlinkInvoices() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fix = args.includes('--fix');

  if (!dryRun && !fix) {
    console.log('Usage:');
    console.log('  node src/scripts/unlinkWrongInvoices.js --dry-run    # Preview changes');
    console.log('  node src/scripts/unlinkWrongInvoices.js --fix        # Apply fixes');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Unlink Invoices from Wrong Orders - ${dryRun ? 'DRY RUN' : 'APPLYING FIXES'}`);
  console.log(`${'='.repeat(60)}\n`);

  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo\n');

  let fixed = 0;
  let errors = 0;

  for (const inv of INVOICES_TO_UNLINK) {
    console.log(`\nInvoice: ${inv.invoiceName} (ID: ${inv.invoiceId})`);
    console.log(`  Currently linked to: ${inv.wrongOrder}`);
    console.log(`  Amazon Order: ${inv.amazonOrderId}`);

    try {
      // Get current invoice data
      const invoices = await odoo.searchRead('account.move',
        [['id', '=', inv.invoiceId]],
        ['id', 'name', 'invoice_origin', 'state', 'ref']
      );

      if (invoices.length === 0) {
        console.log(`  ERROR: Invoice not found in Odoo`);
        errors++;
        continue;
      }

      const invoice = invoices[0];
      console.log(`  Current invoice_origin: ${invoice.invoice_origin || '(none)'}`);
      console.log(`  Current ref: ${invoice.ref || '(none)'}`);
      console.log(`  State: ${invoice.state}`);

      if (fix) {
        // Step 1: Clear invoice_origin on the invoice header
        console.log(`  Clearing invoice_origin...`);
        await odoo.execute('account.move', 'write', [[inv.invoiceId], {
          invoice_origin: false,
        }]);

        // Step 2: Get invoice lines and clear sale_line_ids
        const invoiceLines = await odoo.searchRead('account.move.line',
          [['move_id', '=', inv.invoiceId], ['display_type', '=', 'product']],
          ['id', 'sale_line_ids']
        );

        console.log(`  Found ${invoiceLines.length} product lines`);

        for (const line of invoiceLines) {
          if (line.sale_line_ids && line.sale_line_ids.length > 0) {
            console.log(`    Clearing sale_line_ids on line ${line.id}...`);
            await odoo.execute('account.move.line', 'write', [[line.id], {
              sale_line_ids: [[5, 0, 0]]  // Clear all links
            }]);
          }
        }

        console.log(`  Unlinked successfully.`);
        fixed++;
      } else {
        // Get invoice lines to show what would be cleared
        const invoiceLines = await odoo.searchRead('account.move.line',
          [['move_id', '=', inv.invoiceId], ['display_type', '=', 'product']],
          ['id', 'sale_line_ids']
        );
        const linesWithLinks = invoiceLines.filter(l => l.sale_line_ids && l.sale_line_ids.length > 0);
        console.log(`  [DRY RUN] Would clear invoice_origin and ${linesWithLinks.length} line links`);
        fixed++;
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Summary:`);
  console.log(`  Invoices ${dryRun ? 'to unlink' : 'unlinked'}: ${fixed}`);
  if (errors > 0) {
    console.log(`  Errors: ${errors}`);
  }
  console.log(`${'='.repeat(60)}\n`);

  if (dryRun) {
    console.log('This was a dry run. Run with --fix to apply changes.');
  }
}

unlinkInvoices().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
